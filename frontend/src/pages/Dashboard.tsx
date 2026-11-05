import { useState } from "react";
import { Link } from "react-router-dom";
import { RequireWallet } from "../components/RequireIssuer";
import { RevokeDialog } from "../components/RevokeDialog";
import { DataTable, Pagination } from "../components/ui/data";
import type { Column } from "../components/ui/data";
import { EmptyState, Skeleton } from "../components/ui/feedback";
import { Button, ButtonLink, Card, CardHeader, Input, PageHeader, Select, StatusBadge } from "../components/ui/primitives";
import { useAudit, useDocuments, useStats } from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { actionLabel, dateTime, DOCUMENT_TYPES, relative, shortHash, typeLabel } from "../lib/format";
import type { DocumentVersion, Stats } from "../lib/types";

const PAGE = 10;

export function Dashboard() {
  return (
    <>
      <PageHeader title="Issuer dashboard" description="Your registrations, their status, and recent activity, read from indexed blockchain events."
        actions={<><ButtonLink to="/app/register">Register a document</ButtonLink><ButtonLink variant="secondary" to="/app/batches/new">Register a batch</ButtonLink></>} />
      <RequireWallet role="issuer"><Overview /></RequireWallet>
    </>
  );
}

function Overview() {
  const stats = useStats("mine");
  return (
    <div className="space-y-6">
      <Tiles stats={stats.data} loading={stats.isLoading} />
      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <ActivityChart stats={stats.data} loading={stats.isLoading} />
        <RecentActivity />
      </div>
      <Documents />
    </div>
  );
}

function Tiles({ stats, loading }: { stats?: Stats; loading: boolean }) {
  const items = [
    { label: "Registered documents", value: stats?.total_documents },
    { label: "Valid", value: stats?.valid_documents },
    { label: "Revoked", value: stats?.revoked_documents },
    { label: "Expired", value: stats?.expired_documents },
    { label: "Batches", value: stats?.total_batches },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((i) => (
        <Card key={i.label} as="div" className="px-4 py-3.5">
          <dt className="text-xs font-medium text-muted">{i.label}</dt>
          <dd className="mt-1 text-2xl font-semibold text-ink num">{loading || i.value === undefined ? <Skeleton className="h-8 w-12" /> : i.value}</dd>
        </Card>
      ))}
    </dl>
  );
}

function ActivityChart({ stats, loading }: { stats?: Stats; loading: boolean }) {
  const days = stats?.daily ?? [];
  const max = Math.max(1, ...days.map((d) => d.registrations));
  const total = days.reduce((a, d) => a + d.registrations, 0);
  return (
    <Card>
      <CardHeader title="Registration activity" description="Documents registered per day, last 30 days" />
      <div className="p-5">
        {loading ? <Skeleton className="h-32 w-full" /> : total === 0 ? (
          <EmptyState title="No registrations in the last 30 days">Registered documents will appear here.</EmptyState>
        ) : (
          <>
            <svg role="img" aria-label={`${total} documents registered in the last 30 days; the busiest day had ${max}`} viewBox={`0 0 ${days.length * 10} 100`} preserveAspectRatio="none" className="h-32 w-full">
              {days.map((d, i) => {
                const h = (d.registrations / max) * 92;
                return <rect key={d.day} x={i * 10 + 1.5} width={7} y={96 - h} height={Math.max(h, d.registrations ? 2 : 0.8)} rx={1.2} fill="var(--accent)" opacity={d.registrations ? 1 : 0.25}><title>{`${d.day}: ${d.registrations} registered, ${d.revocations} revoked`}</title></rect>;
              })}
            </svg>
            <div className="mt-1 flex justify-between text-xs text-muted"><span>{days[0]?.day}</span><span>{days[days.length - 1]?.day}</span></div>
          </>
        )}
      </div>
    </Card>
  );
}

function RecentActivity() {
  const auth = useAuth();
  const audit = useAudit({ actor: auth.session?.address, limit: 6 });
  return (
    <Card>
      <CardHeader title="Recent activity" actions={<Link to="/activity" className="text-sm text-accent underline">All activity</Link>} />
      {audit.isLoading ? <div className="space-y-3 p-5"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
        : audit.isError ? <p className="p-5 text-sm text-bad" role="alert">Could not load activity.</p>
        : audit.data?.items.length === 0 ? <EmptyState title="Nothing yet">Your registrations and revocations will be listed here.</EmptyState> : (
          <ul className="divide-y divide-line">
            {audit.data?.items.map((a) => (
              <li key={`${a.transaction_hash}-${a.resource_id}-${a.action}`} className="px-5 py-3 text-sm">
                <p className="font-medium text-ink">{actionLabel(a.action)}</p>
                <p className="mono truncate text-muted" title={a.resource_id}>{shortHash(a.resource_id)}</p>
                <p className="text-xs text-muted">{relative(a.timestamp)}</p>
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
}

function Documents() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [offset, setOffset] = useState(0);
  const [revoke, setRevoke] = useState<DocumentVersion | null>(null);
  const docs = useDocuments({ q: q.trim(), status, document_type: type, limit: PAGE, offset });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setOffset(0); };

  const columns: Column<DocumentVersion>[] = [
    { key: "title", header: "Document", cell: (d) => (
      <Link to={`/documents/${d.document_hash}`} className="font-medium text-ink hover:underline">{d.title ?? <span className="mono">{shortHash(d.document_hash)}</span>}</Link>
    ) },
    { key: "type", header: "Type", cell: (d) => typeLabel(d.document_type) },
    { key: "version", header: "Version", cell: (d) => <span className="num">v{d.version_number}{!d.is_latest && <span className="ml-1 text-xs text-muted">superseded</span>}</span> },
    { key: "status", header: "Status", cell: (d) => <StatusBadge status={d.status} /> },
    { key: "date", header: "Registered", cell: (d) => <span className="text-ink2">{dateTime(d.registered_at)}</span> },
    { key: "actions", header: "Actions", align: "right", cell: (d) => (
      <span className="inline-flex gap-1.5">
        <Link to={`/documents/${d.document_hash}`} className="rounded-md px-2 py-1 text-sm text-accent hover:bg-surface2">Details</Link>
        {d.is_latest && d.status !== "revoked" && <Link to={`/app/register?newVersionOf=${d.document_hash}`} className="rounded-md px-2 py-1 text-sm text-accent hover:bg-surface2">New version</Link>}
        {d.status !== "revoked" && <Button variant="ghost" size="sm" className="!text-bad" onClick={() => setRevoke(d)}>Revoke</Button>}
      </span>
    ) },
  ];

  return (
    <Card>
      <CardHeader title="Documents" description="Every version you have registered" />
      <form role="search" onSubmit={(e) => e.preventDefault()} className="grid gap-3 border-b border-line px-5 py-3 sm:grid-cols-[1fr_auto_auto]">
        <Input aria-label="Search by title or fingerprint" placeholder="Search by title or fingerprint…" value={q} onChange={(e) => reset(setQ)(e.target.value)} />
        <Select aria-label="Filter by status" value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
          <option value="">All statuses</option><option value="valid">Valid</option><option value="revoked">Revoked</option><option value="expired">Expired</option>
        </Select>
        <Select aria-label="Filter by type" value={type} onChange={(e) => reset(setType)(e.target.value)}>
          <option value="">All types</option>{DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
        </Select>
      </form>
      <DataTable columns={columns} rows={docs.data?.items} rowKey={(d) => d.document_hash} loading={docs.isLoading} error={docs.error} onRetry={() => docs.refetch()}
        empty={q || status || type
          ? <EmptyState title="No documents match these filters" action={<Button variant="secondary" onClick={() => { setQ(""); setStatus(""); setType(""); }}>Clear filters</Button>} />
          : <EmptyState title="You have not registered any documents yet" action={<ButtonLink to="/app/register">Register your first document</ButtonLink>}>Registered documents appear here once their transaction is confirmed.</EmptyState>} />
      {docs.data && <Pagination total={docs.data.total} limit={PAGE} offset={offset} onChange={setOffset} />}
      <RevokeDialog hash={revoke?.document_hash ?? null} title={revoke?.title ?? (revoke ? shortHash(revoke.document_hash) : "")} version={revoke?.version_number ?? 1} onClose={() => setRevoke(null)} />
    </Card>
  );
}
