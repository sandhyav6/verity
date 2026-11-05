import { useState } from "react";
import { Link } from "react-router-dom";
import { ColumnChart, HBarChart, tokenFormat, volumePoint } from "../charts/Bars";
import { PriceHistoryChart } from "../charts/PriceHistoryChart";
import { SeriesLine } from "../charts/SeriesLine";
import { Card, Empty, ErrorState, Loading, Stat, Table, Td, inputCls } from "../components/ui";
import { useCategories, useHistory, useMarketStats, useMarkets, useOverview } from "../hooks/queries";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "../hooks/useWallet";
import { api } from "../lib/api";
import { dateOnly, dateTime, pct, tokens, tokensNum } from "../lib/format";
import type { MarketStat } from "../lib/types";
import type { PortfolioPoint } from "./analyticsTypes";

function PriceMovement({ stats }: { stats: MarketStat[] }) {
  const traded = stats.filter((s) => s.trades > 0);
  const [sel, setSel] = useState<number | null>(null);
  const id = sel ?? traded[0]?.id;
  const { data, isLoading } = useHistory(id ?? -1);
  if (traded.length === 0) return <Card title="YES / NO price movement"><p className="text-sm text-ink2" role="status">No market has traded yet, so there is no price movement to show.</p></Card>;
  return (
    <div className="space-y-2">
      <label className="block text-sm"><span className="mr-2 text-ink2">Market</span>
        <select className={`${inputCls} max-w-full sm:max-w-lg`} value={id} onChange={(e) => setSel(Number(e.target.value))}>{traded.map((s) => <option key={s.id} value={s.id}>#{s.id} {s.question.slice(0, 70)}</option>)}</select></label>
      {isLoading ? <Loading /> : <PriceHistoryChart history={data?.items ?? []} />}
    </div>
  );
}

function MyHistory() {
  const w = useWallet();
  const { data } = useQuery({ queryKey: ["pfhist", w.address], queryFn: () => api.get<PortfolioPoint[]>(`/portfolio/${w.address}/history`, { limit: 500 }), enabled: !!w.address });
  if (!w.address) return <Card title="Your net spending over time"><p className="text-sm text-ink2" role="status">Connect a wallet to see your own trading history.</p></Card>;
  const pts = (data ?? []).map((p) => ({ label: dateTime(p.timestamp), value: tokensNum(p.cumulative_net_spent), sub: `${p.action} ${p.outcome}` }));
  return <SeriesLine title="Your net spending over time" subtitle="Running total of tokens paid in buys minus received from sells (your own indexed trades)." unit="tokens" points={pts} empty={<p className="py-6 text-center text-sm text-ink2" role="status">You have no trades yet.</p>} />;
}

export function Analytics() {
  const ov = useOverview();
  const cats = useCategories();
  const stats = useMarketStats();
  const resolved = useMarkets({ status: "resolved", limit: 100 });

  if (ov.isLoading) return <Loading />;
  if (ov.error) return <ErrorState error={ov.error} retry={() => ov.refetch()} />;
  const o = ov.data!;
  const yesWins = resolved.data?.items.filter((m) => m.winning_outcome === "YES").length ?? 0;
  const noWins = resolved.data?.items.filter((m) => m.winning_outcome === "NO").length ?? 0;

  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-semibold">Analytics</h1>
        <p className="mt-1 text-sm text-ink2">Blockchain metrics only: every figure is computed from indexed on-chain events. External data statistics live in the <Link className="text-accent underline" to="/data">Data Explorer</Link>.</p></div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active markets" value={o.markets_by_status.active} />
        <Stat label="Resolved markets" value={o.markets_by_status.resolved} hint={`${o.markets_by_status.invalid} voided`} />
        <Stat label="Trades" value={o.trades_total} hint={`${o.unique_traders} traders`} />
        <Stat label="Volume (tokens)" value={<span className="num-col">{tokens(o.total_volume, 0)}</span>} />
      </div>
      {o.markets_total === 0 && <Empty title="No on-chain activity yet">Charts appear once markets are created and traded.</Empty>}

      <div className="grid gap-5 lg:grid-cols-2">
        <ColumnChart title="Market activity over time" subtitle="Test-token volume per day (last 90 days)" valueLabel="Volume (tokens)" points={o.activity.map((a) => volumePoint(dateOnly(a.day), a.volume, a.trades))} format={tokenFormat} tableValue={(p) => p.value.toFixed(2)} empty={<p className="py-6 text-center text-sm text-ink2" role="status">No trades yet.</p>} />
        <ColumnChart title="Trades per day" valueLabel="Trades" points={o.activity.map((a) => ({ label: dateOnly(a.day), value: a.trades }))} empty={<p className="py-6 text-center text-sm text-ink2" role="status">No trades yet.</p>} />
        <HBarChart title="Market category distribution" valueLabel="Markets" points={(cats.data ?? []).map((c) => ({ label: c.category, value: c.markets, tip: `${c.trades} trades` }))} empty={<p className="py-6 text-center text-sm text-ink2" role="status">No markets yet.</p>} />
        <HBarChart title="Resolution outcomes" subtitle="How resolved markets ended" valueLabel="Markets" points={[{ label: "YES", value: yesWins }, { label: "NO", value: noWins }, { label: "voided", value: o.markets_by_status.invalid }].filter((p) => p.value > 0)} empty={<p className="py-6 text-center text-sm text-ink2" role="status">No market has been resolved yet.</p>} />
      </div>

      <PriceMovement stats={stats.data ?? []} />
      <MyHistory />

      <Card title="Per-market activity">
        {!stats.data?.length ? <p className="text-sm text-ink2" role="status">No markets yet.</p> : (
          <Table head={["Market", "Category", "Status", "YES", "Trades", "Traders", "Volume (tokens)"]}>
            {stats.data.map((s) => <tr key={s.id}><Td><Link className="hover:underline" to={`/markets/${s.id}`}>{s.question.slice(0, 60)}</Link></Td><Td className="capitalize">{s.category}</Td><Td>{s.status}</Td><Td className="num-col">{pct(s.yes_price)}</Td><Td className="num-col">{s.trades}</Td><Td className="num-col">{s.unique_traders}</Td><Td className="num-col">{tokens(s.volume)}</Td></tr>)}
          </Table>
        )}
      </Card>
      <p className="text-xs text-muted">Source: {o.source}{o.indexed_at ? ` · last indexed ${dateTime(o.indexed_at)}` : ""}.</p>
    </div>
  );
}
