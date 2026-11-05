import { useDeferredValue } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { MarketCard } from "../components/MarketCard";
import { Button, Empty, ErrorState, Loading, inputCls } from "../components/ui";
import { useMarkets } from "../hooks/queries";

const PAGE = 12;

export function Markets() {
  const [sp, setSp] = useSearchParams();
  const get = (k: string, d = "") => sp.get(k) ?? d;
  const set = (k: string, v: string) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); if (k !== "page") n.delete("page"); return n; }, { replace: true });

  const q = useDeferredValue(get("q"));
  const page = Math.max(0, Number(get("page", "0")) || 0);
  const params = { q: q || undefined, category: get("category") || undefined, status: get("status") || undefined, sort: get("sort", "created_at"), order: get("order", "desc"), limit: PAGE, offset: page * PAGE };
  const { data, isLoading, error, refetch } = useMarkets(params);
  const filtered = !!(q || get("category") || get("status"));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Markets</h1>
      <form className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" role="search" onSubmit={(e) => e.preventDefault()}>
        <input className={`${inputCls} lg:col-span-2`} type="search" placeholder="Search questions…" aria-label="Search questions" value={get("q")} onChange={(e) => set("q", e.target.value)} />
        <select className={inputCls} aria-label="Category" value={get("category")} onChange={(e) => set("category", e.target.value)}>
          <option value="">All categories</option>
          {["economy", "weather", "sports", "technology"].map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
        </select>
        <select className={inputCls} aria-label="Status" value={get("status")} onChange={(e) => set("status", e.target.value)}>
          <option value="">Any status</option>
          <option value="active">Trading open</option><option value="closed">Awaiting resolution</option><option value="resolved">Resolved</option><option value="invalid">Voided</option>
        </select>
        <select className={inputCls} aria-label="Sort by" value={`${get("sort", "created_at")}:${get("order", "desc")}`} onChange={(e) => { const [s, o] = e.target.value.split(":"); setSp((p) => { const n = new URLSearchParams(p); n.set("sort", s); n.set("order", o); n.delete("page"); return n; }, { replace: true }); }}>
          <option value="created_at:desc">Newest first</option>
          <option value="created_at:asc">Oldest first</option>
          <option value="volume:desc">Most volume</option>
          <option value="trade_count:desc">Most trades</option>
          <option value="closing:asc">Closing soonest</option>
        </select>
      </form>

      {isLoading ? <Loading label="Loading markets…" /> : error ? <ErrorState error={error} retry={() => refetch()} /> : !data || data.items.length === 0 ? (
        filtered ? <Empty title="No markets match these filters" action={<Button variant="secondary" onClick={() => setSp({}, { replace: true })}>Clear filters</Button>}>Try a different search term or status.</Empty>
          : <Empty title="No markets exist yet" action={<Link className="text-accent underline" to="/create">Create the first market</Link>}>Markets appear here after they are created on-chain and indexed. Nothing is pre-loaded.</Empty>
      ) : (
        <>
          <p className="text-sm text-ink2" aria-live="polite">{data.total} market{data.total === 1 ? "" : "s"}</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{data.items.map((m) => <MarketCard key={m.id} m={m} />)}</div>
          <div className="flex items-center justify-between">
            <Button variant="secondary" disabled={page === 0} onClick={() => set("page", String(page - 1))}>← Previous</Button>
            <span className="text-sm text-ink2">Page {page + 1} of {Math.max(1, Math.ceil(data.total / PAGE))}</span>
            <Button variant="secondary" disabled={(page + 1) * PAGE >= data.total} onClick={() => set("page", String(page + 1))}>Next →</Button>
          </div>
        </>
      )}
    </div>
  );
}
