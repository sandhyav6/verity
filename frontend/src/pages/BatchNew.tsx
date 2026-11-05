import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { addr, useAppConfig } from "../blockchain/config";
import { verityRegistryAbi } from "../blockchain/abi/verityRegistryAbi";
import { RequireWallet } from "../components/RequireIssuer";
import { TxPanel } from "../components/TxPanel";
import { DataTable, Facts, FileDrop, Stepper } from "../components/ui/data";
import type { Column } from "../components/ui/data";
import { Alert } from "../components/ui/feedback";
import { IconX } from "../components/ui/icons";
import { Button, ButtonLink, Card, CardHeader, Field, HashText, Input, PageHeader, Textarea } from "../components/ui/primitives";
import { keys } from "../hooks/queries";
import { useTx } from "../hooks/useTx";
import { api, ApiError } from "../lib/api";
import { downloadJson } from "../lib/download";
import { bytes, shortHash } from "../lib/format";
import { canonicalJson, sha256File, sha256Text } from "../lib/hash";
import { merkleRoot, proofsForAll } from "../lib/merkle";
import type { ProofFile } from "../lib/types";

const MAX_FILES = 500;
const STEPS = ["Fingerprint files", "Register root", "Save proofs", "Done"];

interface Item { id: number; name: string; size: number; hash: string | null; error?: string }

export function BatchNew() {
  return (
    <>
      <PageHeader title="Register a batch" breadcrumbs={[{ label: "Issuer dashboard", to: "/app" }, { label: "Batches", to: "/app/batches" }, { label: "New batch" }]}
        description="Fingerprint many documents, combine them into a Merkle tree, and register just the root in one transaction. Each document can later be verified with its own proof." />
      <RequireWallet role="issuer"><Flow /></RequireWallet>
    </>
  );
}

function Flow() {
  const cfg = useAppConfig();
  const tx = useTx();
  const nextId = useRef(1);
  const [items, setItems] = useState<Item[]>([]);
  const [hashingNow, setHashingNow] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [stage, setStage] = useState<"files" | "saving" | "done">("files");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [result, setResult] = useState<{ batchId: number; txHash: string } | null>(null);

  const seen = new Map<string, number>();
  const unique = items.filter((i) => {
    if (!i.hash) return false;
    if (seen.has(i.hash)) return false;
    seen.set(i.hash, i.id);
    return true;
  });
  const duplicates = items.filter((i) => i.hash && !unique.includes(i));
  const failed = items.filter((i) => i.error);
  const hashes = unique.map((i) => i.hash!);
  const root = useMemo(() => (hashes.length ? merkleRoot(hashes) : null), [hashes.join(",")]);
  const proofs = useMemo(() => (hashes.length ? proofsForAll(hashes) : []), [hashes.join(",")]);

  async function onFiles(files: File[]) {
    const room = MAX_FILES - items.length;
    const take = files.slice(0, Math.max(0, room));
    const fresh: Item[] = take.map((f) => ({ id: nextId.current++, name: f.name, size: f.size, hash: null, error: f.size === 0 ? "Empty file" : f.size > cfg.max_upload_bytes ? `Larger than ${bytes(cfg.max_upload_bytes)}` : undefined }));
    setItems((cur) => [...cur, ...fresh]);
    for (const [i, f] of take.entries()) {
      if (fresh[i].error) continue;
      setHashingNow(f.name);
      try {
        const h = await sha256File(f);
        setItems((cur) => cur.map((x) => (x.id === fresh[i].id ? { ...x, hash: h } : x)));
      } catch {
        setItems((cur) => cur.map((x) => (x.id === fresh[i].id ? { ...x, error: "Could not be read" } : x)));
      }
    }
    setHashingNow(null);
  }

  const metadata = { title: title.trim(), description: description.trim(), document_count: String(hashes.length) };

  async function register() {
    if (!title.trim()) return setTitleError("Give the batch a title so you can recognise it later.");
    setTitleError(null);
    if (!root) return;
    const txHash = await tx.send({
      address: addr(cfg.registry_address), abi: verityRegistryAbi as never, functionName: "registerBatch",
      args: [root, hashes.length, sha256Text(canonicalJson(metadata))], invalidate: [keys.batches, keys.stats, keys.audit],
    });
    if (txHash) await saveLeaves(txHash);
  }

  async function saveLeaves(txHash: string) {
    setStage("saving");
    setSaveError(null);
    try {
      const res = await api.post<{ batch_id: number }>("/batches/documents", {
        merkle_root: root, documents: unique.map((i) => ({ document_hash: i.hash, filename: i.name, size_bytes: i.size })),
      });
      setResult({ batchId: res.batch_id, txHash });
      setStage("done");
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : "Could not save the proofs.");
      setResult((r) => r ?? { batchId: 0, txHash });
    }
  }

  const proofFile = (index: number): ProofFile => ({ version: 1, batch_id: result!.batchId, merkle_root: root!, document_hash: hashes[index], leaf_index: index, proof: proofs[index], chain_id: cfg.chain_id, contract_address: cfg.registry_address.toLowerCase() });

  const current = stage === "done" ? 3 : stage === "saving" ? 2 : tx.state.phase === "idle" || tx.state.phase === "failed" ? 0 : 1;

  const columns: Column<Item>[] = [
    { key: "name", header: "File", cell: (i) => <span className="break-all">{i.name}</span> },
    { key: "size", header: "Size", cell: (i) => <span className="num">{bytes(i.size)}</span> },
    { key: "hash", header: "Fingerprint", cell: (i) => i.error ? <span className="text-bad">{i.error}</span> : i.hash ? <span className="mono">{shortHash(i.hash)}{duplicates.includes(i) && <span className="ml-2 text-warn">duplicate, ignored</span>}</span> : <span className="text-muted">Hashing…</span> },
    { key: "rm", header: "", align: "right", cell: (i) => stage === "files" && !tx.busy ? <Button variant="ghost" size="sm" aria-label={`Remove ${i.name}`} onClick={() => setItems((c) => c.filter((x) => x.id !== i.id))}><IconX width={15} height={15} /></Button> : null },
  ];

  if (stage === "done" && result) {
    const rows = unique.map((i, idx) => ({ ...i, idx }));
    const cols: Column<(typeof rows)[number]>[] = [
      { key: "name", header: "File", cell: (r) => <span className="break-all">{r.name}</span> },
      { key: "hash", header: "Fingerprint", cell: (r) => <span className="mono">{shortHash(r.hash!)}</span> },
      { key: "a", header: "Actions", align: "right", cell: (r) => (
        <span className="inline-flex gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => downloadJson(`proof-${r.hash!.slice(2, 10)}.json`, proofFile(r.idx))}>Download proof</Button>
          <Link className="rounded-md px-2 py-1 text-sm text-accent hover:bg-surface2" to={`/verify?hash=${r.hash}`}>Verify</Link>
        </span>
      ) },
    ];
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <Stepper steps={STEPS} current={4} />
        <Card>
          <CardHeader title="Batch registered" description={`${hashes.length} documents are now verifiable against one on-chain root.`} />
          <div className="space-y-5 p-5">
            <Facts items={[{ label: "Batch", value: `#${result.batchId}` }, { label: "Merkle root", value: <HashText value={root!} short label="Merkle root" /> }, { label: "Transaction", value: <HashText value={result.txHash} short label="transaction hash" /> }]} />
            <Alert tone="info" title="Give each recipient their proof">A proof file lets anyone confirm that one document belongs to this batch. Proofs are also kept by the registry service so recipients can simply upload their file on the verify page.</Alert>
          </div>
          <DataTable columns={cols} rows={rows} rowKey={(r) => r.hash!} />
          <div className="flex flex-wrap justify-between gap-2 border-t border-line px-5 py-3">
            <Button variant="secondary" onClick={() => downloadJson(`batch-${result.batchId}-proofs.json`, hashes.map((_, i) => proofFile(i)))}>Download all proofs</Button>
            <ButtonLink to={`/app/batches/${result.batchId}`}>View batch</ButtonLink>
          </div>
        </Card>
      </div>
    );
  }

  const busy = tx.busy || stage === "saving" && !saveError;
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Stepper steps={STEPS} current={current} />
      <Card>
        <CardHeader title="Documents" description={`${unique.length} unique file${unique.length === 1 ? "" : "s"} ready${items.length ? ` of ${items.length} added` : ""}. Up to ${MAX_FILES} per batch. Files are hashed in your browser; their contents are not uploaded.`} />
        <div className="space-y-4 p-5">
          <FileDrop multiple label="Add the documents in this batch" hint="Drop many files at once" onFiles={onFiles} disabled={busy || stage !== "files"} />
          {hashingNow && <p role="status" className="text-xs text-muted">Fingerprinting {hashingNow}…</p>}
          {items.length >= MAX_FILES && <Alert tone="warn">The batch is full ({MAX_FILES} files).</Alert>}
          {failed.length > 0 && <Alert tone="warn" title={`${failed.length} file${failed.length === 1 ? " was" : "s were"} skipped`}>Remove them or fix the problem and add them again.</Alert>}
        </div>
        {items.length > 0 && <DataTable columns={columns} rows={items} rowKey={(i) => String(i.id)} />}
      </Card>

      <Card>
        <CardHeader title="Batch details" />
        <div className="space-y-4 p-5">
          <Field label="Title" error={titleError}><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} disabled={busy} /></Field>
          <Field label="Description" optional><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} disabled={busy} /></Field>
          {root ? <Facts items={[{ label: "Documents", value: hashes.length }, { label: "Merkle root (preview)", value: <HashText value={root} label="Merkle root" /> }]} /> : <p className="text-sm text-muted">Add at least one document to preview the Merkle root.</p>}
          <p className="text-xs text-muted">How the root is built is documented in the README: each leaf is keccak256(0x00 ‖ fingerprint) and pairs are hashed in sorted order.</p>
          <TxPanel state={tx.state} />
          {stage === "saving" && !saveError && <p role="status" className="text-sm text-muted">Registered on-chain. Saving per-document proofs…</p>}
          {saveError && <Alert tone="warn" title="The root is registered, but the proofs were not saved" action={<Button size="sm" variant="secondary" onClick={() => result && saveLeaves(result.txHash)}>Retry</Button>}>{saveError} The batch is already on-chain; retrying does not send another transaction.</Alert>}
        </div>
        <div className="flex justify-end border-t border-line px-5 py-3">
          <Button onClick={register} loading={busy} disabled={!root || hashingNow !== null || stage !== "files"}>{tx.state.phase === "failed" ? "Try again" : `Register ${hashes.length || ""} document${hashes.length === 1 ? "" : "s"} on-chain`}</Button>
        </div>
      </Card>
    </div>
  );
}
