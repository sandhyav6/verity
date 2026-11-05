import { isAddress } from "viem";
import { useState } from "react";
import { addr, useAppConfig } from "../blockchain/config";
import { verityRegistryAbi } from "../blockchain/abi/verityRegistryAbi";
import { TxPanel } from "../components/TxPanel";
import { DataTable, Pagination } from "../components/ui/data";
import type { Column } from "../components/ui/data";
import { Alert, ConfirmDialog, Dialog, EmptyState, useToast } from "../components/ui/feedback";
import { Badge, Button, Card, CardHeader, Field, HashText, Input, PageHeader, Select } from "../components/ui/primitives";
import { keys, useAudit, useIssuers } from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { useTx } from "../hooks/useTx";
import { actionLabel, dateTime } from "../lib/format";
import type { Issuer } from "../lib/types";

const PAGE = 15;

export function Issuers() {
  const auth = useAuth();
  const [q, setQ] = useState("");
  const [authorized, setAuthorized] = useState("");
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<Issuer | null>(null);
  const [remove, setRemove] = useState<Issuer | null>(null);
  const list = useIssuers({ q: q.trim(), authorized, limit: PAGE, offset });

  const columns: Column<Issuer>[] = [
    { key: "org", header: "Organisation", cell: (i) => <button type="button" onClick={() => setDetail(i)} className="text-left font-medium text-ink hover:underline">{i.organization_name}</button> },
    { key: "addr", header: "Address", cell: (i) => <HashText value={i.address} short label="address" /> },
    { key: "status", header: "Status", cell: (i) => i.authorized ? <Badge tone="ok">Authorised</Badge> : <Badge tone="neutral">Removed</Badge> },
    { key: "docs", header: "Documents", cell: (i) => <span className="num">{i.document_count}</span> },
    { key: "actions", header: "Actions", align: "right", cell: (i) => (
      <span className="inline-flex gap-1.5">
        <Button variant="ghost" size="sm" onClick={() => setDetail(i)}>Details</Button>
        {auth.isManager && i.authorized && <Button variant="ghost" size="sm" className="!text-bad" onClick={() => setRemove(i)}>Remove</Button>}
      </span>
    ) },
  ];

  return (
    <>
      <PageHeader title="Issuers" description="Wallets authorised on the registry contract to register and revoke documents. Authorisation is stored on-chain; this list is its indexed view." />
      <div className="space-y-6">
        {auth.isManager ? <Authorize /> : (
          <Alert tone="info" title="Read-only">Only wallets holding the issuer-manager role can authorise or remove issuers. The contract enforces this, not this page.</Alert>
        )}
        <Card>
          <CardHeader title="Registered issuers" />
          <form role="search" onSubmit={(e) => e.preventDefault()} className="grid gap-3 border-b border-line px-5 py-3 sm:grid-cols-[1fr_auto]">
            <Input aria-label="Search issuers" placeholder="Search by name or address…" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
            <Select aria-label="Filter by status" value={authorized} onChange={(e) => { setAuthorized(e.target.value); setOffset(0); }}>
              <option value="">All issuers</option><option value="true">Authorised</option><option value="false">Removed</option>
            </Select>
          </form>
          <DataTable columns={columns} rows={list.data?.items} rowKey={(i) => i.address} loading={list.isLoading} error={list.error} onRetry={() => list.refetch()}
            empty={<EmptyState title={q || authorized ? "No issuers match" : "No issuers yet"}>Issuers appear here once a manager authorises them on-chain.</EmptyState>} />
          {list.data && <Pagination total={list.data.total} limit={PAGE} offset={offset} onChange={setOffset} />}
        </Card>
      </div>
      <IssuerDetail issuer={detail} onClose={() => setDetail(null)} />
      <RemoveIssuer issuer={remove} onClose={() => setRemove(null)} />
    </>
  );
}

function Authorize() {
  const cfg = useAppConfig();
  const tx = useTx();
  const toast = useToast();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<{ address?: string; name?: string }>({});

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!isAddress(address)) next.address = "Enter a valid wallet address (0x followed by 40 hexadecimal characters).";
    if (!name.trim() || name.trim().length > 100) next.name = "Enter the organisation name (1 to 100 characters).";
    setErrors(next);
    if (Object.keys(next).length) return;
    const hash = await tx.send({ address: addr(cfg.registry_address), abi: verityRegistryAbi as never, functionName: "authorizeIssuer", args: [address, name.trim()], invalidate: [keys.issuers, keys.audit, keys.stats] });
    if (hash) { toast.push(`${name.trim()} is now an authorised issuer.`, "ok"); setAddress(""); setName(""); tx.reset(); }
  }

  return (
    <Card>
      <CardHeader title="Authorise an issuer" description="Grants the right to register documents and batches. The organisation name is a label recorded on-chain; check the identity of the wallet's owner before authorising it." />
      <form onSubmit={submit} className="space-y-4 p-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Wallet address" error={errors.address}><Input value={address} onChange={(e) => setAddress(e.target.value.trim())} placeholder="0x…" spellCheck={false} autoComplete="off" className="mono" /></Field>
          <Field label="Organisation name" error={errors.name}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="off" /></Field>
        </div>
        <TxPanel state={tx.state} />
        <Button type="submit" loading={tx.busy}>Authorise issuer</Button>
      </form>
    </Card>
  );
}

function RemoveIssuer({ issuer, onClose }: { issuer: Issuer | null; onClose: () => void }) {
  const cfg = useAppConfig();
  const tx = useTx();
  const toast = useToast();
  const close = () => { tx.reset(); onClose(); };
  async function confirm() {
    const hash = await tx.send({ address: addr(cfg.registry_address), abi: verityRegistryAbi as never, functionName: "removeIssuer", args: [issuer!.address], invalidate: [keys.issuers, keys.audit, keys.stats] });
    if (hash) { toast.push(`${issuer!.organization_name} can no longer register documents.`, "ok"); close(); }
  }
  return (
    <ConfirmDialog open={!!issuer} onClose={close} onConfirm={confirm} loading={tx.busy} danger confirmLabel={tx.state.phase === "failed" ? "Try again" : "Remove issuer"}
      title={`Remove ${issuer?.organization_name ?? "issuer"}?`}
      description="They will no longer be able to register documents. Everything they already registered stays on record and keeps verifying, and they can still revoke their own documents.">
      <TxPanel state={tx.state} />
    </ConfirmDialog>
  );
}

function IssuerDetail({ issuer, onClose }: { issuer: Issuer | null; onClose: () => void }) {
  return (
    <Dialog open={!!issuer} onClose={onClose} title={issuer?.organization_name ?? ""} description={issuer?.authorized ? "Authorised issuer" : "Authorisation removed"}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {issuer && <IssuerBody issuer={issuer} />}
    </Dialog>
  );
}

function IssuerBody({ issuer }: { issuer: Issuer }) {
  const audit = useAudit({ actor: issuer.address, limit: 8 });
  return (
    <>
      {issuer && (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-3 gap-3 text-center">
            {[["Documents", issuer.document_count], ["Revoked", issuer.revoked_count], ["Batches", issuer.batch_count]].map(([l, v]) => (
              <div key={l} className="rounded-md bg-surface2 px-2 py-2"><dt className="text-xs text-muted">{l}</dt><dd className="text-lg font-semibold num">{v}</dd></div>
            ))}
          </dl>
          <p><span className="text-muted">Address</span><br /><HashText value={issuer.address} label="address" /></p>
          <p><span className="text-muted">Authorised</span><br />{dateTime(issuer.authorized_at)}{issuer.removed_at && <><br /><span className="text-muted">Removed </span>{dateTime(issuer.removed_at)}</>}</p>
          <div>
            <p className="mb-1 text-muted">Recent activity</p>
            {audit.isLoading ? <p className="text-xs text-muted" role="status">Loading…</p> : audit.data?.items.length ? (
              <ul className="space-y-1">{audit.data.items.map((a) => <li key={`${a.transaction_hash}-${a.resource_id}`} className="flex justify-between gap-2"><span>{actionLabel(a.action)}</span><span className="text-xs text-muted">{dateTime(a.timestamp)}</span></li>)}</ul>
            ) : <p className="text-xs text-muted">No activity yet.</p>}
          </div>
        </div>
      )}
    </>
  );
}
