import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { addr, useAppConfig } from "../blockchain/config";
import { verityRegistryAbi } from "../blockchain/abi/verityRegistryAbi";
import { RequireWallet } from "../components/RequireIssuer";
import { TxPanel } from "../components/TxPanel";
import { DataTable, Facts, Pagination } from "../components/ui/data";
import type { Column } from "../components/ui/data";
import { Alert, ConfirmDialog, EmptyState, ErrorState, Skeleton, useToast } from "../components/ui/feedback";
import { Button, ButtonLink, Card, CardHeader, HashText, PageHeader, StatusBadge } from "../components/ui/primitives";
import { keys, useBatch, useBatchDocuments, useBatches } from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { useTx } from "../hooks/useTx";
import { api } from "../lib/api";
import { downloadJson } from "../lib/download";
import { bytes, dateTime, shortHash } from "../lib/format";
import type { Batch, BatchDocument, ProofFile } from "../lib/types";

const ZERO32 = "0x" + "00".repeat(32);

export function Batches() {
  const [offset, setOffset] = useState(0);
  return (
    <>
      <PageHeader title="Batches" breadcrumbs={[{ label: "Issuer dashboard", to: "/app" }, { label: "Batches" }]} description="Merkle batches you have registered: one transaction, many documents."
        actions={<ButtonLink to="/app/batches/new">Register a batch</ButtonLink>} />
      <RequireWallet role="issuer"><List offset={offset} setOffset={setOffset} /></RequireWallet>
    </>
  );
}

function List({ offset, setOffset }: { offset: number; setOffset: (n: number) => void }) {
  const list = useBatches({ limit: 15, offset });
  const columns: Column<Batch>[] = [
    { key: "id", header: "Batch", cell: (b) => <Link className="font-medium text-ink hover:underline" to={`/app/batches/${b.batch_id}`}>#{b.batch_id}</Link> },
    { key: "docs", header: "Documents", cell: (b) => <span className="num">{b.document_count}</span> },
    { key: "root", header: "Merkle root", cell: (b) => <span className="mono">{shortHash(b.merkle_root)}</span> },
    { key: "status", header: "Status", cell: (b) => <StatusBadge status={b.revoked_at ? "revoked" : "valid"} /> },
    { key: "date", header: "Registered", cell: (b) => dateTime(b.registered_at) },
  ];
  return (
    <Card>
      <DataTable columns={columns} rows={list.data?.items} rowKey={(b) => String(b.batch_id)} loading={list.isLoading} error={list.error} onRetry={() => list.refetch()}
        empty={<EmptyState title="No batches yet" action={<ButtonLink to="/app/batches/new">Register your first batch</ButtonLink>}>Use a batch to register hundreds of documents in a single transaction.</EmptyState>} />
      {list.data && <Pagination total={list.data.total} limit={15} offset={offset} onChange={setOffset} />}
    </Card>
  );
}

export function BatchDetail() {
  const { id } = useParams();
  const cfg = useAppConfig();
  const auth = useAuth();
  const batch = useBatch(id);
  const isOwner = auth.signedIn && batch.data?.issuer.address === auth.session?.address.toLowerCase();
  const [offset, setOffset] = useState(0);
  const docs = useBatchDocuments(id, { limit: 25, offset }, !!isOwner);
  const [revokeBatch, setRevokeBatch] = useState(false);
  const [revokeDoc, setRevokeDoc] = useState<BatchDocument | null>(null);
  const tx = useTx();
  const toast = useToast();

  if (batch.isLoading) return <div role="status" aria-label="Loading batch" className="space-y-4"><Skeleton className="h-8 w-1/3" /><Skeleton className="h-40 w-full" /></div>;
  if (batch.isError || !batch.data) return <ErrorState title="Batch not found" error={batch.error} onRetry={() => batch.refetch()} />;
  const b = batch.data;

  const close = () => { tx.reset(); setRevokeBatch(false); setRevokeDoc(null); };
  async function confirm() {
    const invalidate = [keys.batches, keys.audit, keys.stats];
    const hash = revokeDoc
      ? await tx.send({ address: addr(cfg.registry_address), abi: verityRegistryAbi as never, functionName: "revokeBatchDocument", args: [BigInt(b.batch_id), revokeDoc.document_hash, revokeDoc.proof, ZERO32], invalidate })
      : await tx.send({ address: addr(cfg.registry_address), abi: verityRegistryAbi as never, functionName: "revokeBatch", args: [BigInt(b.batch_id), ZERO32], invalidate });
    if (hash) { toast.push(revokeDoc ? "Document revoked." : "Batch revoked.", "ok"); close(); }
  }

  async function downloadProof(d: BatchDocument) {
    const proof = await api.get<ProofFile>(`/batches/${b.batch_id}/proof/${d.document_hash}`);
    downloadJson(`proof-${d.document_hash.slice(2, 10)}.json`, proof);
  }

  const columns: Column<BatchDocument>[] = [
    { key: "name", header: "File", cell: (d) => <span className="break-all">{d.filename}</span> },
    { key: "size", header: "Size", cell: (d) => <span className="num">{bytes(d.size_bytes)}</span> },
    { key: "hash", header: "Fingerprint", cell: (d) => <span className="mono">{shortHash(d.document_hash)}</span> },
    { key: "status", header: "Status", cell: (d) => <StatusBadge status={d.revoked_at ? "revoked" : "valid"} /> },
    { key: "a", header: "Actions", align: "right", cell: (d) => (
      <span className="inline-flex gap-1.5">
        <Link className="rounded-md px-2 py-1 text-sm text-accent hover:bg-surface2" to={`/verify?hash=${d.document_hash}`}>Verify</Link>
        <Button variant="ghost" size="sm" onClick={() => void downloadProof(d)}>Proof</Button>
        {!d.revoked_at && <Button variant="ghost" size="sm" className="!text-bad" onClick={() => setRevokeDoc(d)}>Revoke</Button>}
      </span>
    ) },
  ];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={<span className="flex flex-wrap items-center gap-3">Batch #{b.batch_id}<StatusBadge status={b.revoked_at ? "revoked" : "valid"} /></span>}
        breadcrumbs={[{ label: "Issuer dashboard", to: "/app" }, { label: "Batches", to: "/app/batches" }, { label: `#${b.batch_id}` }]}
        actions={isOwner && !b.revoked_at ? <Button variant="danger" onClick={() => setRevokeBatch(true)}>Revoke whole batch</Button> : undefined} />
      <div className="space-y-6">
        {b.revoked_at && <Alert tone="bad" title="This batch was revoked">Every document in it stopped verifying on {dateTime(b.revoked_at)}.</Alert>}
        <Card>
          <CardHeader title="Batch record" description="Recorded on-chain: only the root, the count and the issuer. Documents are proven individually." />
          <div className="p-5">
            <Facts items={[
              { label: "Merkle root", value: <HashText value={b.merkle_root} label="Merkle root" /> },
              { label: "Issuer", value: <span>{b.issuer.organization_name ?? "Unnamed issuer"}<span className="mono block text-muted">{b.issuer.address}</span></span> },
              { label: "Documents", value: <span className="num">{b.document_count}</span> },
              { label: "Registered", value: dateTime(b.registered_at) },
              { label: "Transaction", value: <HashText value={b.transaction_hash} short label="transaction hash" /> },
              { label: "Proofs held by the registry service", value: <span className="num">{b.documents_stored} of {b.document_count}</span> },
            ]} />
          </div>
        </Card>
        {isOwner ? (
          <Card>
            <CardHeader title="Documents in this batch" description="File names are visible to you only." />
            <DataTable columns={columns} rows={docs.data?.items} rowKey={(d) => d.document_hash} loading={docs.isLoading} error={docs.error} onRetry={() => docs.refetch()}
              empty={<EmptyState title="No document records stored">The proofs for this batch were not saved. Recipients can still verify with a proof file.</EmptyState>} />
            {docs.data && <Pagination total={docs.data.total} limit={25} offset={offset} onChange={setOffset} />}
          </Card>
        ) : (
          <Card><div className="p-5 text-sm text-muted">The documents in a batch are private to the issuer. To check a document, <Link className="text-accent underline" to="/verify">verify it</Link>: it is matched to this batch by its fingerprint and proof.</div></Card>
        )}
        {!isOwner && <RequireOwnerHint />}
      </div>
      <ConfirmDialog open={revokeBatch || !!revokeDoc} onClose={close} onConfirm={confirm} loading={tx.busy} danger confirmLabel={tx.state.phase === "failed" ? "Try again" : "Revoke permanently"}
        title={revokeDoc ? "Revoke this document?" : "Revoke the whole batch?"}
        description={revokeDoc ? "It will stop verifying. Other documents in the batch are unaffected. This cannot be undone." : `All ${b.document_count} documents stop verifying. This cannot be undone.`}>
        <TxPanel state={tx.state} />
      </ConfirmDialog>
    </div>
  );
}

function RequireOwnerHint() {
  const auth = useAuth();
  return auth.signedIn ? null : <p className="text-xs text-muted">Sign in as the issuing wallet to see this batch's documents.</p>;
}
