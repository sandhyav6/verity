import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { txUrl, useAppConfig } from "../blockchain/config";
import { RevokeDialog } from "../components/RevokeDialog";
import { DataTable, Facts } from "../components/ui/data";
import type { Column } from "../components/ui/data";
import { Alert, EmptyState, ErrorState, Skeleton } from "../components/ui/feedback";
import { IconDownload } from "../components/ui/icons";
import { Badge, Button, ButtonLink, Card, CardHeader, HashText, PageHeader, StatusBadge } from "../components/ui/primitives";
import { useDocument } from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { api, ApiError } from "../lib/api";
import { bytes, dateTime, shortHash, typeLabel } from "../lib/format";
import { normalizeHash } from "../lib/hash";
import type { DocumentVersion, ProofEntry } from "../lib/types";

export function DocumentDetails() {
  const { hash: raw } = useParams();
  const hash = normalizeHash(raw ?? "");
  const cfg = useAppConfig();
  const auth = useAuth();
  const doc = useDocument(hash ?? undefined);
  const batches = useQuery({ queryKey: ["proofs", hash], enabled: !!hash, queryFn: () => api.get<{ entries: ProofEntry[] }>(`/proofs/${hash}`) });
  const [revoke, setRevoke] = useState(false);

  if (!hash) return <EmptyState title="That is not a valid fingerprint">A fingerprint is 64 hexadecimal characters (a SHA-256 hash).</EmptyState>;
  if (doc.isLoading) return <div role="status" aria-label="Loading document" className="space-y-4"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (doc.error instanceof ApiError && doc.error.status === 404) {
    return (
      <EmptyState title="No indexed record for this fingerprint" action={<ButtonLink to={`/verify?hash=${hash}`}>Verify it against the blockchain</ButtonLink>}>
        It may not be registered, may belong to a batch, or the indexer may not have processed it yet. Verification reads the blockchain directly, so it is always the authoritative check.
      </EmptyState>
    );
  }
  if (doc.isError || !doc.data) return <ErrorState error={doc.error} onRetry={() => doc.refetch()} />;

  const { document: d, versions } = doc.data;
  const isOwner = auth.signedIn && auth.session?.address.toLowerCase() === d.issuer.address;
  const title = d.title ?? "Untitled document";
  const batch = batches.data?.entries[0];

  const versionColumns: Column<DocumentVersion>[] = [
    { key: "v", header: "Version", cell: (v) => <span className="num">v{v.version_number}{v.is_latest && <Badge tone="accent" className="ml-2">Latest</Badge>}</span> },
    { key: "hash", header: "Fingerprint", cell: (v) => v.document_hash === d.document_hash ? <span className="mono">{shortHash(v.document_hash)} <span className="text-muted">(this record)</span></span> : <Link className="mono text-accent underline" to={`/documents/${v.document_hash}`}>{shortHash(v.document_hash)}</Link> },
    { key: "status", header: "Status", cell: (v) => <StatusBadge status={v.status} /> },
    { key: "date", header: "Registered", cell: (v) => dateTime(v.registered_at) },
  ];

  const events = versions.flatMap((v) => [
    { key: `r-${v.document_hash}`, label: `Version ${v.version_number} registered`, at: v.registered_at, tx: v.transaction_hash },
    ...(v.revoked_at && v.revocation_transaction_hash ? [{ key: `x-${v.document_hash}`, label: `Version ${v.version_number} revoked`, at: v.revoked_at, tx: v.revocation_transaction_hash }] : []),
  ]).sort((a, b) => +new Date(b.at) - +new Date(a.at));

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader breadcrumbs={[{ label: "Verity", to: "/" }, { label: "Documents" }, { label: shortHash(d.document_hash) }]}
        title={<span className="flex flex-wrap items-center gap-3">{title}<StatusBadge status={d.status} /></span>}
        description={<>{typeLabel(d.document_type)} · version {d.version_number}{d.is_latest ? "" : " (superseded)"}</>}
        actions={<>
          <ButtonLink variant="secondary" to={`/verify?hash=${d.document_hash}`}>Verify</ButtonLink>
          {isOwner && d.file_available && <a href={api.fileUrl(`/documents/${d.document_hash}/file`)} className="inline-flex h-10 items-center gap-2 rounded-md border border-linestrong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface2"><IconDownload width={16} height={16} />Download file</a>}
          {isOwner && d.status !== "revoked" && d.is_latest && <ButtonLink variant="secondary" to={`/app/register?newVersionOf=${d.document_hash}`}>New version</ButtonLink>}
          {isOwner && d.status !== "revoked" && <Button variant="danger" onClick={() => setRevoke(true)}>Revoke</Button>}
        </>} />

      <div className="space-y-6">
        {d.status === "revoked" && (
          <Alert tone="bad" title="This version was revoked">
            Revoked {d.revoked_at && dateTime(d.revoked_at)} by <span className="mono">{d.revoked_by}</span>. The original registration is preserved but this document must no longer be relied on.
            {d.revocation_transaction_hash && <span className="mt-1 block text-xs">Revocation transaction: <HashText value={d.revocation_transaction_hash} short label="transaction hash" /></span>}
          </Alert>
        )}
        {d.status === "expired" && <Alert tone="warn" title="This registration has expired">Its validity period ended {d.expires_at && dateTime(d.expires_at)}.</Alert>}
        {!d.is_latest && d.status !== "revoked" && <Alert tone="info" title="A newer version exists">This version is still registered and still verifies, but the issuer has since registered a later one.</Alert>}

        <Card>
          <CardHeader title="Registration record" description="Facts recorded on-chain, as indexed" />
          <div className="p-5">
            <Facts items={[
              { label: "Fingerprint (SHA-256)", value: <HashText value={d.document_hash} label="fingerprint" /> },
              { label: "Issuer", value: <span>{d.issuer.organization_name ?? "Unnamed issuer"}<span className="mono block text-muted">{d.issuer.address}</span></span> },
              { label: "Registered", value: dateTime(d.registered_at) },
              { label: "Expires", value: d.expires_at ? dateTime(d.expires_at) : "Does not expire" },
              { label: "Document ID", value: <HashText value={d.document_id} short label="document ID" /> },
              { label: "Metadata hash", value: <span><HashText value={d.metadata_hash} short label="metadata hash" />{d.metadata_verified === true && <Badge tone="ok" className="ml-2">Matches stored details</Badge>}{d.metadata_verified === false && <Badge tone="bad" className="ml-2">Does not match</Badge>}</span> },
              ...(d.title ? [{ label: "Visibility", value: d.visibility === "public" ? "Public: anyone can see the details and download the file" : "Private: visible to you only" }] : [{ label: "Details", value: <span className="text-muted">Held privately by the issuer</span> }]),
              ...(d.size_bytes ? [{ label: "File", value: `${bytes(d.size_bytes)} · ${d.content_type}` }] : []),
              ...Object.entries(d.metadata ?? {}).map(([k, v]) => ({ label: k, value: v })),
            ]} />
          </div>
        </Card>

        {batch && (
          <Card>
            <CardHeader title="Batch information" description="This fingerprint is also a member of a registered Merkle batch" />
            <div className="p-5"><Facts items={[{ label: "Batch", value: <Link className="text-accent underline" to={`/app/batches/${batch.batch_id}`}>#{batch.batch_id}</Link> }, { label: "Merkle root", value: <HashText value={batch.merkle_root} short label="Merkle root" /> }]} /></div>
          </Card>
        )}

        <Card>
          <CardHeader title="Version history" description="Each version is its own on-chain record and verifies independently" />
          <DataTable columns={versionColumns} rows={versions} rowKey={(v) => v.document_hash} />
        </Card>

        <Card>
          <CardHeader title="Transaction history" />
          <ul className="divide-y divide-line">
            {events.map((e) => (
              <li key={e.key} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                <span><span className="font-medium text-ink">{e.label}</span><span className="ml-2 text-muted">{dateTime(e.at)}</span></span>
                <span className="inline-flex items-center gap-2"><HashText value={e.tx} short label="transaction hash" />{txUrl(cfg, e.tx) && <a className="text-accent underline" href={txUrl(cfg, e.tx)!} target="_blank" rel="noopener noreferrer">Explorer</a>}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <RevokeDialog hash={revoke ? d.document_hash : null} title={title} version={d.version_number} onClose={() => setRevoke(false)} />
    </div>
  );
}
