import { useState } from "react";
import { Link } from "react-router-dom";
import { DataTable, Pagination } from "../components/ui/data";
import type { Column } from "../components/ui/data";
import { EmptyState } from "../components/ui/feedback";
import { Badge, Button, Card, HashText, Input, PageHeader, Select } from "../components/ui/primitives";
import { useAudit } from "../hooks/queries";
import { ACTIONS, actionLabel, dateTime, shortAddr } from "../lib/format";
import type { AuditEntry } from "../lib/types";

const PAGE = 20;
const TONE: Record<string, "ok" | "bad" | "info" | "accent"> = { registered: "ok", revoked: "bad", authorized: "accent", removed: "bad", document_revoked: "bad" };

export function Activity() {
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [resource, setResource] = useState("");
  const [offset, setOffset] = useState(0);
  const set = <T,>(f: (v: T) => void) => (v: T) => { f(v); setOffset(0); };
  const audit = useAudit({ action, actor: actor.trim(), resource_id: resource.trim(), limit: PAGE, offset });
  const filtered = !!(action || actor || resource);

  const columns: Column<AuditEntry>[] = [
    { key: "time", header: "Time", cell: (a) => <span className="text-ink2">{dateTime(a.timestamp)}</span> },
    { key: "action", header: "Event", cell: (a) => <Badge tone={TONE[a.action.split(".")[1]] ?? "info"}>{actionLabel(a.action)}</Badge> },
    { key: "actor", header: "Actor", cell: (a) => <span className="mono" title={a.actor}>{shortAddr(a.actor)}</span> },
    { key: "res", header: "Resource", cell: (a) => a.action.startsWith("document") || a.action === "batch.document_revoked" ? <Link className="mono text-accent underline" to={`/documents/${a.resource_id}`}>{a.resource_id.slice(0, 12)}…</Link> : <span className="mono" title={a.resource_id}>{a.resource_id.length > 20 ? shortAddr(a.resource_id) : a.resource_id}</span> },
    { key: "tx", header: "Transaction", cell: (a) => <span className="inline-flex items-center gap-2"><HashText value={a.transaction_hash} short label="transaction hash" />{a.explorer_url && <a className="text-accent underline" href={a.explorer_url} target="_blank" rel="noopener noreferrer">Explorer</a>}</span> },
  ];

  return (
    <>
      <PageHeader title="Registry activity" description="Every event the registry contract has emitted, as indexed. Public by design: it contains fingerprints and addresses, never document contents." />
      <Card>
        <form role="search" onSubmit={(e) => e.preventDefault()} className="grid gap-3 border-b border-line px-5 py-3 md:grid-cols-[auto_1fr_1fr_auto]">
          <Select aria-label="Filter by event" value={action} onChange={(e) => set(setAction)(e.target.value)}>
            <option value="">All events</option>{ACTIONS.map((a) => <option key={a} value={a}>{actionLabel(a)}</option>)}
          </Select>
          <Input aria-label="Filter by actor address" placeholder="Actor address (0x…)" value={actor} onChange={(e) => set(setActor)(e.target.value)} spellCheck={false} className="mono" />
          <Input aria-label="Filter by resource" placeholder="Fingerprint or resource id" value={resource} onChange={(e) => set(setResource)(e.target.value)} spellCheck={false} className="mono" />
          {filtered && <Button variant="ghost" onClick={() => { setAction(""); setActor(""); setResource(""); setOffset(0); }}>Clear</Button>}
        </form>
        <DataTable columns={columns} rows={audit.data?.items} rowKey={(a) => `${a.transaction_hash}-${a.action}-${a.resource_id}`} loading={audit.isLoading} error={audit.error} onRetry={() => audit.refetch()}
          empty={<EmptyState title={filtered ? "No events match these filters" : "No activity yet"}>{filtered ? "Try widening the filters." : "Events appear once the indexer has processed the registry's transactions."}</EmptyState>} />
        {audit.data && <Pagination total={audit.data.total} limit={PAGE} offset={offset} onChange={setOffset} />}
      </Card>
    </>
  );
}
