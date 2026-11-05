import { Link } from "react-router-dom";
import { ColumnChart, HBarChart, tokenFormat, volumePoint } from "../charts/Bars";
import { MarketCard } from "../components/MarketCard";
import { Card, Empty, ErrorState, Loading, Pill, Stat, Table, Td, TxLink } from "../components/ui";
import { useCategories, useDataSources, useMarkets, useOverview, useTrades } from "../hooks/queries";
import { dateOnly, dateTime, price, relative, shortAddr, tokens } from "../lib/format";

function Section({ title, link, children }: { title: string; link?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between"><h2 className="text-lg font-semibold">{title}</h2>{link && <Link className="text-sm text-accent underline" to={link}>See all</Link>}</div>
      {children}
    </section>
  );
}

function MarketRow({ params, empty }: { params: Record<string, string | number>; empty: string }) {
  const { data, isLoading, error, refetch } = useMarkets({ limit: 3, ...params });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} retry={() => refetch()} />;
  if (!data?.items.length) return <Empty title={empty} />;
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{data.items.map((m) => <MarketCard key={m.id} m={m} />)}</div>;
}

export function Dashboard() {
  const ov = useOverview();
  const cats = useCategories();
  const trades = useTrades({ limit: 8 });
  const sources = useDataSources();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="mt-1 text-sm text-ink2">Forecast Indian events with test tokens. Every number below is computed from indexed blockchain events; there is no seed or demo data.</p>
      </div>

      {ov.isLoading ? <Loading /> : ov.error ? <ErrorState error={ov.error} retry={() => ov.refetch()} /> : ov.data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Markets" value={ov.data.markets_total} hint={`${ov.data.markets_by_status.active} open · ${ov.data.markets_by_status.closed} awaiting result · ${ov.data.markets_by_status.resolved} resolved`} />
            <Stat label="Trades" value={ov.data.trades_total} />
            <Stat label="Traders" value={ov.data.unique_traders} hint="distinct wallets that traded" />
            <Stat label="Test-token volume" value={<span className="num-col">{tokens(ov.data.total_volume, 0)}</span>} hint={ov.data.last_indexed_block !== null ? `indexed to block ${ov.data.last_indexed_block}` : "indexer has not run yet"} />
          </div>
          {ov.data.markets_total === 0 && <Empty title="Nothing has happened on-chain yet" action={<Link className="text-accent underline" to="/create">Create a market</Link>}>Statistics stay at zero until markets are created and traded. They are never filled with placeholders.</Empty>}
        </>
      )}

      <Section title="Markets nearing closure" link="/markets?status=active&sort=closing&order=asc"><MarketRow params={{ status: "active", sort: "closing", order: "asc" }} empty="No markets are open for trading." /></Section>
      <Section title="Recently created" link="/markets"><MarketRow params={{ sort: "created_at", order: "desc" }} empty="No markets have been created yet." /></Section>
      <Section title="Resolved" link="/markets?status=resolved"><MarketRow params={{ status: "resolved" }} empty="No market has been resolved yet." /></Section>

      <div className="grid gap-5 lg:grid-cols-2">
        <HBarChart title="Markets by category" subtitle="Count of markets created" valueLabel="Markets" points={(cats.data ?? []).map((c) => ({ label: c.category, value: c.markets, tip: `${c.trades} trades` }))} empty={<p className="py-6 text-center text-sm text-ink2" role="status">No markets yet.</p>} />
        <ColumnChart title="Trading activity" subtitle="Test-token volume per day, last 90 days (from indexed trades)" valueLabel="Volume (tokens)" points={(ov.data?.activity ?? []).map((a) => volumePoint(dateOnly(a.day), a.volume, a.trades))} format={tokenFormat} tableValue={(p) => p.value.toFixed(2)} empty={<p className="py-6 text-center text-sm text-ink2" role="status">No trades yet.</p>} />
      </div>

      <Section title="Recent trades" link="/transactions">
        <Card>
          {trades.isLoading ? <Loading /> : trades.error ? <ErrorState error={trades.error} /> : !trades.data?.items.length ? <p className="text-sm text-ink2" role="status">No trades yet.</p> : (
            <Table head={["Time", "Market", "Trader", "Trade", "Tokens", "Price", "Tx"]}>
              {trades.data.items.map((t) => (
                <tr key={t.transaction_hash + t.log_index}>
                  <Td>{relative(t.timestamp)}</Td><Td><Link className="hover:underline" to={`/markets/${t.market_id}`}>{(t.market_question ?? `Market #${t.market_id}`).slice(0, 48)}</Link></Td>
                  <Td className="num-col">{shortAddr(t.wallet_address)}</Td><Td>{t.action} {t.outcome}</Td><Td className="num-col">{tokens(t.token_amount)}</Td><Td className="num-col">{price(t.execution_price)}</Td>
                  <Td><TxLink hash={t.transaction_hash} url={t.explorer_url} /></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </Section>

      <Section title="Data sources" link="/data">
        <Card subtitle="External real-world data feeding market resolution. Separate from blockchain activity.">
          {sources.isLoading ? <Loading /> : sources.error ? <ErrorState error={sources.error} /> : (
            <ul className="divide-y divide-grid text-sm">
              {sources.data!.map((s) => (
                <li key={s.provider} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><span className="font-medium">{s.provider}</span> <span className="text-ink2">· {s.category}</span></span>
                  <span className="flex items-center gap-2"><Pill>{s.mode}</Pill>
                    <Pill tone={s.freshness === "stale" ? "warn" : s.freshness === "fresh" ? "good" : "neutral"}>{s.freshness === "no data" ? "no data yet" : `${s.records} record${s.records === 1 ? "" : "s"} · ${s.freshness}`}</Pill>
                    {s.last_retrieved_at && <span className="text-xs text-muted">{dateTime(s.last_retrieved_at)}</span>}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </Section>
    </div>
  );
}
