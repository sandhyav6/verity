import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { addr, txUrl, useAppConfig } from "../blockchain/config";
import { verityRegistryAbi } from "../blockchain/abi/verityRegistryAbi";
import { RequireWallet } from "../components/RequireIssuer";
import { TxPanel } from "../components/TxPanel";
import { Facts, FileDrop, Stepper } from "../components/ui/data";
import { Alert } from "../components/ui/feedback";
import { IconFile, IconX } from "../components/ui/icons";
import { Badge, Button, ButtonLink, Card, CardHeader, Field, HashText, Input, PageHeader, Select } from "../components/ui/primitives";
import { useDocument, useIssuer, useVerification, keys } from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { useTx, waitForIndexed } from "../hooks/useTx";
import { ApiError, api } from "../lib/api";
import { bytes, DOCUMENT_TYPES, typeLabel } from "../lib/format";
import { randomBytes32, sha256File } from "../lib/hash";
import type { UploadResult } from "../lib/types";

const STEPS = ["Document", "Details", "Review", "Register"];
const MAX_ATTRS = 20;

interface Draft {
  file: File | null;
  hash: string | null;
  title: string;
  type: string;
  expires: string; // yyyy-mm-dd or ""
  visibility: "public" | "private";
  attrs: { key: string; value: string }[];
}
const EMPTY: Draft = { file: null, hash: null, title: "", type: "academic_certificate", expires: "", visibility: "private", attrs: [] };

export function Register() {
  return (
    <>
      <PageHeader title="Register a document" breadcrumbs={[{ label: "Issuer dashboard", to: "/app" }, { label: "Register a document" }]}
        description="Fingerprint a file, record who issued it, and anchor the record on the blockchain. The file itself never goes on-chain." />
      <RequireWallet role="issuer"><Flow /></RequireWallet>
    </>
  );
}

function Flow() {
  const cfg = useAppConfig();
  const auth = useAuth();
  const [params] = useSearchParams();
  const versionOf = params.get("newVersionOf");
  const parent = useDocument(versionOf ?? undefined);
  const issuer = useIssuer(auth.session?.address);
  const tx = useTx();

  const [step, setStep] = useState(0);
  const [d, setD] = useState<Draft>(EMPTY);
  const [hashing, setHashing] = useState<number | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: string; tx: string; indexed: boolean | null } | null>(null);

  const typeIndex = useMemo(() => Object.fromEntries(Object.entries(cfg.document_types).map(([i, n]) => [n, Number(i)])), [cfg.document_types]);
  const parentDoc = parent.data?.document;
  const parentLatest = parent.data?.versions[0];

  useEffect(() => {
    if (parentDoc) setD((x) => ({ ...x, title: x.title || parentDoc.title || "", type: parentDoc.document_type }));
  }, [parentDoc]);

  // duplicate check straight from the contract, once there is a fingerprint
  const existing = useVerification(step >= 2 ? d.hash : null);
  const duplicate = existing.data && existing.data.chain.verdict !== "not_verified";

  async function onFile([file]: File[]) {
    setFileError(null);
    setD((x) => ({ ...x, file, hash: null }));
    if (file.size === 0) return setFileError("This file is empty.");
    if (file.size > cfg.max_upload_bytes) return setFileError(`This file is ${bytes(file.size)}. The limit is ${bytes(cfg.max_upload_bytes)}.`);
    try {
      setHashing(0);
      const hash = await sha256File(file, setHashing);
      setD((x) => ({ ...x, hash, title: x.title || file.name.replace(/\.[^.]+$/, "") }));
    } catch {
      setFileError("This file could not be read. Check that it is still available and try again.");
    } finally {
      setHashing(null);
    }
  }

  function validateDetails(): boolean {
    const e: Record<string, string> = {};
    if (!d.title.trim()) e.title = "Enter a title.";
    else if (d.title.trim().length > 200) e.title = "Keep the title under 200 characters.";
    if (d.expires && new Date(d.expires + "T23:59:59Z").getTime() <= Date.now()) e.expires = "The expiry date must be in the future.";
    const keysSeen = new Set<string>();
    d.attrs.forEach((a, i) => {
      if (!a.key.trim() || !a.value.trim()) e[`attr${i}`] = "Fill in both the name and the value, or remove the row.";
      else if (a.key.length > 64 || a.value.length > 500) e[`attr${i}`] = "Names are limited to 64 characters and values to 500.";
      else if (keysSeen.has(a.key.trim())) e[`attr${i}`] = "Names must be unique.";
      keysSeen.add(a.key.trim());
    });
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit() {
    if (!d.file || !d.hash) return;
    setUploadError(null);
    setUploading(true);
    let up: UploadResult;
    try {
      const form = new FormData();
      form.set("file", d.file);
      form.set("title", d.title.trim());
      form.set("document_type", d.type);
      form.set("visibility", d.visibility);
      form.set("metadata", JSON.stringify(Object.fromEntries(d.attrs.map((a) => [a.key.trim(), a.value.trim()]))));
      form.set("expected_hash", d.hash);
      up = await api.upload<UploadResult>("/documents/uploads", form);
      if (up.document_hash !== d.hash) throw new Error("The server computed a different fingerprint from your browser. Please retry the upload.");
    } catch (e) {
      setUploadError(e instanceof ApiError || e instanceof Error ? e.message : "The upload failed.");
      return;
    } finally {
      setUploading(false);
    }
    const documentId = parentDoc?.document_id ?? randomBytes32();
    const expiresAt = d.expires ? Math.floor(new Date(d.expires + "T23:59:59Z").getTime() / 1000) : 0;
    const hash = await tx.send({
      address: addr(cfg.registry_address),
      abi: verityRegistryAbi as never,
      functionName: "registerDocument",
      args: [documentId, d.hash, typeIndex[d.type] ?? 0, up.metadata_hash, BigInt(expiresAt)],
      invalidate: [keys.documents, keys.stats, keys.audit],
    });
    if (hash) {
      setDone({ hash: d.hash, tx: hash, indexed: null });
      void waitForIndexed(hash).then((ok) => setDone((x) => (x ? { ...x, indexed: ok } : x)));
    }
  }

  function reset() {
    setD(EMPTY); setStep(0); setDone(null); setErrors({}); setUploadError(null); tx.reset();
  }

  if (done) return <Success done={done} onAnother={reset} title={d.title} version={parentLatest ? parentLatest.version_number + 1 : 1} />;

  const submitting = uploading || tx.busy;
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Stepper steps={STEPS} current={submitting ? 3 : step} />

      {versionOf && (
        parent.isLoading ? null : parentDoc && parentLatest
          ? <Alert tone="info" title={`New version of “${parentDoc.title ?? "an existing document"}”`}>This registers version {parentLatest.version_number + 1}. Earlier versions stay on record and keep verifying.</Alert>
          : <Alert tone="bad" title="The document to version was not found">Check the link, or register this file as a new document.</Alert>
      )}
      {versionOf && parentDoc && parentDoc.issuer.address !== auth.session?.address.toLowerCase() && (
        <Alert tone="bad" title="You did not issue this document">Only the issuing wallet can add versions. The contract will reject this transaction.</Alert>
      )}

      {step === 0 && (
        <Card>
          <CardHeader title="1. Choose the document" description="Verity computes its SHA-256 fingerprint here in your browser." />
          <div className="space-y-3 p-5">
            <FileDrop label="Choose a file to register" hint={`Up to ${bytes(cfg.max_upload_bytes)}. Executables are not accepted.`} onFiles={onFile} disabled={hashing !== null} />
            {d.file && (
              <div className="flex items-center gap-3 rounded-md border border-line bg-surface2 px-3 py-2 text-sm">
                <IconFile className="shrink-0 text-muted" /><span className="min-w-0 flex-1 truncate">{d.file.name}</span><span className="text-xs text-muted num">{bytes(d.file.size)}</span>
              </div>
            )}
            {hashing !== null && <p role="status" className="text-xs text-muted">Computing fingerprint… {Math.round(hashing * 100)}%</p>}
            {fileError && <Alert tone="bad">{fileError}</Alert>}
            {d.hash && <Facts items={[{ label: "Fingerprint (SHA-256)", value: <HashText value={d.hash} label="fingerprint" /> }]} />}
          </div>
          <div className="flex justify-end border-t border-line px-5 py-3"><Button disabled={!d.hash} onClick={() => setStep(1)}>Continue</Button></div>
        </Card>
      )}

      {step === 1 && (
        <Card>
          <CardHeader title="2. Describe the document" description="The title and details are stored off-chain; their hash is recorded on-chain so they cannot be altered unnoticed." />
          <div className="space-y-5 p-5">
            <Field label="Title" error={errors.title}><Input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} maxLength={200} autoComplete="off" /></Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Document type"><Select value={d.type} onChange={(e) => setD({ ...d, type: e.target.value })} disabled={!!parentDoc}>{DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}</Select></Field>
              <Field label="Expires on" optional error={errors.expires} hint="Leave empty if it does not expire."><Input type="date" value={d.expires} min={new Date(Date.now() + 86400_000).toISOString().slice(0, 10)} onChange={(e) => setD({ ...d, expires: e.target.value })} /></Field>
            </div>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-ink">Visibility</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {([["private", "Private", "Only you can see the title, details and file. Anyone can still verify the fingerprint."], ["public", "Public", "Verifiers see the title and details, and can download the file."]] as const).map(([v, label, text]) => (
                  <label key={v} className={`flex cursor-pointer gap-3 rounded-md border p-3 text-sm focus-within:outline focus-within:outline-2 focus-within:outline-accent ${d.visibility === v ? "border-accent bg-accentsoft" : "border-linestrong"}`}>
                    <input type="radio" name="visibility" value={v} checked={d.visibility === v} onChange={() => setD({ ...d, visibility: v })} className="mt-1 accent-[var(--accent)]" />
                    <span><span className="block font-medium text-ink">{label}</span><span className="text-muted">{text}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-ink">Additional details <span className="text-xs font-normal text-muted">optional</span></legend>
              <div className="space-y-2">
                {d.attrs.map((a, i) => (
                  <div key={i}>
                    <div className="flex gap-2">
                      <Input aria-label={`Detail ${i + 1} name`} placeholder="Name (e.g. Recipient)" value={a.key} onChange={(e) => setD({ ...d, attrs: d.attrs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
                      <Input aria-label={`Detail ${i + 1} value`} placeholder="Value" value={a.value} onChange={(e) => setD({ ...d, attrs: d.attrs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                      <Button variant="ghost" aria-label={`Remove detail ${i + 1}`} onClick={() => setD({ ...d, attrs: d.attrs.filter((_, j) => j !== i) })}><IconX width={16} height={16} /></Button>
                    </div>
                    {errors[`attr${i}`] && <p role="alert" className="mt-1 text-xs font-medium text-bad">{errors[`attr${i}`]}</p>}
                  </div>
                ))}
                {d.attrs.length < MAX_ATTRS && <Button variant="secondary" size="sm" onClick={() => setD({ ...d, attrs: [...d.attrs, { key: "", value: "" }] })}>Add a detail</Button>}
              </div>
            </fieldset>
          </div>
          <div className="flex justify-between border-t border-line px-5 py-3">
            <Button variant="ghost" onClick={() => setStep(0)}>Back</Button>
            <Button onClick={() => validateDetails() && setStep(2)}>Review</Button>
          </div>
        </Card>
      )}

      {step >= 2 && (
        <Card>
          <CardHeader title="3. Review and register" description="Check everything. Registration is permanent: a fingerprint cannot be deleted, only revoked." />
          <div className="space-y-5 p-5">
            <Facts items={[
              { label: "File", value: <span>{d.file?.name} <span className="text-muted">({bytes(d.file?.size ?? 0)})</span></span> },
              { label: "Fingerprint (SHA-256)", value: <HashText value={d.hash!} label="fingerprint" /> },
              { label: "Title", value: d.title.trim() },
              { label: "Document type", value: typeLabel(d.type) },
              { label: "Expires", value: d.expires || "Never" },
              { label: "Visibility", value: <Badge tone={d.visibility === "public" ? "info" : "neutral"}>{d.visibility === "public" ? "Public" : "Private"}</Badge> },
              { label: "Issuing as", value: <span>{issuer.data?.organization_name ?? "Authorised issuer"}<span className="mono block text-muted">{auth.session?.address}</span></span> },
              { label: "Network", value: `${cfg.chain_name} (chain ${cfg.chain_id})` },
              { label: "Registration", value: parentLatest ? `Version ${parentLatest.version_number + 1} of an existing document` : "New document, version 1" },
              ...(d.attrs.length ? [{ label: "Additional details", value: <ul>{d.attrs.map((a) => <li key={a.key}><span className="text-muted">{a.key}:</span> {a.value}</li>)}</ul> }] : []),
            ]} />
            {existing.isLoading && <p role="status" className="text-sm text-muted">Checking the registry for duplicates…</p>}
            {existing.isError && <Alert tone="warn" title="Could not check for duplicates">{(existing.error as Error).message} The contract will still reject a duplicate.</Alert>}
            {duplicate && <Alert tone="bad" title="This exact file is already registered">Each fingerprint can be registered once. {existing.data?.chain.verdict === "revoked" ? "It was revoked and cannot be re-registered." : <>See its <Link className="underline" to={`/documents/${d.hash}`}>record</Link>.</>}</Alert>}
            {uploadError && <Alert tone="bad" title="The upload failed">{uploadError} Your file was not registered.</Alert>}
            <TxPanel state={tx.state} extra={uploading ? "Uploading the document to storage…" : null} />
          </div>
          <div className="flex justify-between border-t border-line px-5 py-3">
            <Button variant="ghost" onClick={() => { tx.reset(); setStep(1); }} disabled={submitting}>Back</Button>
            <Button onClick={submit} loading={submitting} disabled={!!duplicate || existing.isLoading}>{tx.state.phase === "failed" || uploadError ? "Try again" : "Register on-chain"}</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Success({ done, onAnother, title, version }: { done: { hash: string; tx: string; indexed: boolean | null }; onAnother: () => void; title: string; version: number }) {
  const cfg = useAppConfig();
  const link = txUrl(cfg, done.tx);
  return (
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardHeader title="Registered on-chain" description={`“${title}” (version ${version}) is now part of the registry.`} actions={<Badge tone="ok">Confirmed</Badge>} />
        <div className="space-y-5 p-5">
          <Facts items={[
            { label: "Fingerprint", value: <HashText value={done.hash} label="fingerprint" /> },
            { label: "Transaction", value: <span className="inline-flex flex-wrap items-center gap-2"><HashText value={done.tx} short label="transaction hash" />{link && <a className="text-accent underline" href={link} target="_blank" rel="noopener noreferrer">Explorer</a>}</span> },
          ]} />
          {done.indexed === null && <p role="status" className="text-sm text-muted">The transaction is confirmed. Waiting for the record to appear in the dashboard…</p>}
          {done.indexed === false && <Alert tone="warn" title="The dashboard has not caught up yet">Your registration is confirmed on-chain and already verifies. The indexed record can take a little longer to appear.</Alert>}
        </div>
        <div className="flex flex-wrap justify-between gap-2 border-t border-line px-5 py-3">
          <Button variant="secondary" onClick={onAnother}>Register another</Button>
          <ButtonLink to={`/documents/${done.hash}`}>View document record</ButtonLink>
        </div>
      </Card>
    </div>
  );
}
