import { Link, useParams } from "react-router-dom";
import { PriceHistoryChart } from "../charts/PriceHistoryChart";
import { ProbabilityBar } from "../charts/ProbabilityBar";
import { OraclePanel } from "../components/OraclePanel";
import { SettlePanel } from "../components/SettlePanel";
import { TradePanel } from "../components/TradePanel";
import { Banner, Card, Empty, ErrorState, Loading, Pill, Stat, StatusBadge, Table, Td, TxLink } from "../components/ui";
import { VerifyOnChain } from "../components/VerifyOnChain";
import { useEvidence, useHistory, useMarket, useMarketTrades, useResolution } from "../hooks/queries";
import { dateTime, price, shortAddr, tokens } from "../lib/format";
import type { Market } from "../lib/types";
import { ApiError } from "../lib/api";

export function MarketDetail() {
  const id = Number(useParams().id);
  const { data: m, isLoading, error, refetch } = useMarket(id);
  if (isLoading) return <Loading label="Loading market…" />;
  if (error instanceof ApiError && error.status === 404) return <Empty title="Market not found" action={<Link className="text-accent underline" to="/markets">Browse markets</Link>}>No market with id {id} has been indexed yet. If it was just created, wait a few seconds for the indexer.</Empty>;
  if (error || !m) return <ErrorState error={error} retry={() => refetch()} />;

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2"><Pill>{m.category}</Pill><StatusBadge status={m.status} /><span className="text-xs text-muted">Market #{m.id}</span>
          {!m.metadata_verified && <Pill tone="warn">⚠ definition not verified against the on-chain hash</Pill>}</div>
        <h1 className="text-2xl font-semibold leading-tight">{m.question}</h1>
        {m.trade_count > 0 ? <div className="max-w-xl"><ProbabilityBar yes={Number(m.yes_price)} size="lg" /></div> : <p className="text-sm text-ink2">No trades yet. The market opens at 50% / 50%; that is a starting point, not a forecast.</p>}
      </header>

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-5">
          <MarketNumbers m={m} />
          <HistorySection id={m.id} />
          <Rules m={m} />
          <ResolutionSection m={m} />
          <TradesSection id={m.id} />
        </div>
        <aside className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          <TradePanel market={m} />
          <OraclePanel market={m} />
          <SettlePanel market={m} />
          <VerifyOnChain market={m} />
        </aside>
      </div>
    </div>
  );
}

function MarketNumbers({ m }: { m: Market }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="YES price" value={<span className="num-col">{price(m.yes_price)}</span>} hint="tokens per share" />
      <Stat label="NO price" value={<span className="num-col">{price(m.no_price)}</span>} hint="tokens per share" />
      <Stat label="Volume" value={<span className="num-col">{tokens(m.volume, 0)}</span>} hint={`${m.trade_count} trades`} />
      <Stat label="Liquidity (b)" value={<span className="num-col">{tokens(m.liquidity_parameter, 0)}</span>} hint="higher = smaller price moves" />
    </div>
  );
}

function HistorySection({ id }: { id: number }) {
  const { data, isLoading, error } = useHistory(id);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} />;
  return <PriceHistoryChart history={data?.items ?? []} />;
}

function Rules({ m }: { m: Market }) {
  return (
    <Card title="Resolution rules" subtitle="A market is only meaningful if its outcome can be determined objectively from a named source.">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <Item k="Closes for trading" v={dateTime(m.trading_close_time)} />
        <Item k="Resolution deadline" v={dateTime(m.resolution_deadline)} />
        <Item k="YES means" v={m.yes_definition ?? "-"} />
        <Item k="NO means" v={m.no_definition ?? "-"} />
        <div className="sm:col-span-2"><Item k="Criteria" v={m.resolution_criteria ?? "Definition not available from this backend."} /></div>
        {m.resolution_source && <div className="sm:col-span-2"><Item k="Source" v={<><a className="text-accent underline" href={m.resolution_source.url} target="_blank" rel="noreferrer">{m.resolution_source.name}</a> · {m.resolution_source.dataset}</>} /></div>}
        {m.resolution_spec && (<>
          <Item k="Measured" v={`${m.resolution_spec.measurement} (${m.resolution_spec.unit})`} />
          <Item k="Observation period" v={m.resolution_spec.observation_period} />
          <Item k="Revision policy" v={m.resolution_spec.revision_policy} />
          <Item k="If data is missing" v={m.resolution_spec.missing_data_policy} />
        </>)}
      </dl>
      {m.resolution_data_note && <div className="mt-3"><Banner tone="warn">{m.resolution_data_note} Weather data by <a className="underline" href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo.com</a> (CC BY 4.0).</Banner></div>}
      {m.description && <p className="mt-3 text-sm text-ink2">{m.description}</p>}
      <p className="mt-3 text-xs text-muted">Created by <span className="num-col">{shortAddr(m.created_by)}</span> · contract <span className="num-col">{shortAddr(m.contract_address)}</span> · metadata hash <span className="num-col" title={m.metadata_hash}>{m.metadata_hash.slice(0, 12)}…</span></p>
    </Card>
  );
}

const Item = ({ k, v }: { k: string; v: React.ReactNode }) => <div><dt className="text-xs text-muted">{k}</dt><dd className="text-ink">{v}</dd></div>;

function ResolutionSection({ m }: { m: Market }) {
  const res = useResolution(m.id);
  const ev = useEvidence(m.id);
  return (
    <Card title="Resolution and evidence" subtitle={res.data?.trust_model}>
      {res.isLoading ? <Loading /> : res.error ? <ErrorState error={res.error} /> : res.data!.proposals.length === 0 ? (
        <p className="text-sm text-ink2" role="status">{m.status === "active" ? "Nothing to resolve yet: trading is still open." : m.status === "closed" ? "Trading has closed. A resolver must now submit the outcome with evidence." : "No resolution proposal was recorded."}</p>
      ) : (
        <ul className="space-y-3">
          {res.data!.proposals.map((p) => {
            const bundle = ev.data?.find((e) => e.evidence_hash === p.evidence_hash);
            return (
              <li key={p.transaction_hash} className="rounded-lg border border-edge p-3 text-sm">
                <p><strong>{p.state === "finalized" ? "Final" : p.state === "cancelled" ? "Cancelled" : p.state === "disputed" ? "Disputed" : "Proposed"}:</strong> {p.final_outcome ?? p.proposed_outcome} · by <span className="num-col">{shortAddr(p.resolver_address)}</span> · {dateTime(p.proposal_timestamp)}{p.bond !== "0" && <> · bond {tokens(p.bond)} tokens</>}</p>
                {p.dispute_status !== "none" && (
                  <p className="mt-1 text-xs text-ink2">
                    {p.dispute_status === "released" ? "A dispute was unwound without a ruling; all bonds were returned." : <>Disputed by <span className="num-col">{shortAddr(p.disputer_address ?? "")}</span>{p.dispute_status === "disputed" ? ", awaiting the arbiter." : <>; the arbiter <strong>{p.dispute_status === "upheld" ? "upheld the proposal" : "overturned it"}</strong> ({shortAddr(p.arbiter_address ?? "")}){p.arbiter_rationale_available && p.arbiter_rationale_hash && <> · <a className="text-accent underline" href={`${import.meta.env.VITE_API_URL ?? "http://localhost:8000"}/resolutions/${m.id}/evidence/${p.arbiter_rationale_hash}`} target="_blank" rel="noreferrer">reasoning</a></>}; the loser's bond went to the winner.</>}</>}
                    {p.dispute_evidence_available && p.dispute_evidence_hash && <> · <a className="text-accent underline" href={`${import.meta.env.VITE_API_URL ?? "http://localhost:8000"}/resolutions/${m.id}/evidence/${p.dispute_evidence_hash}`} target="_blank" rel="noreferrer">challenger's evidence</a></>}
                  </p>
                )}
                <p className="mt-1 text-xs text-ink2">Evidence hash <span className="num-col break-all">{p.evidence_hash}</span> {p.evidence_available ? <a className="text-accent underline" href={`${import.meta.env.VITE_API_URL ?? "http://localhost:8000"}/resolutions/${m.id}/evidence/${p.evidence_hash}`} target="_blank" rel="noreferrer">view document</a> : <Pill tone="warn">document not available</Pill>}</p>
                {bundle && (
                  <details className="mt-2"><summary className="cursor-pointer text-xs text-accent">Evidence details {bundle.hash_verified ? "✓ hash verified" : "✗ hash mismatch"}</summary>
                    <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">{Object.entries(bundle.bundle).filter(([, v]) => v !== null).map(([k, v]) => <div key={k}><dt className="text-muted">{k.replace(/_/g, " ")}</dt><dd className="break-words text-ink">{String(v)}</dd></div>)}</dl>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function TradesSection({ id }: { id: number }) {
  const { data, isLoading, error } = useMarketTrades(id);
  return (
    <Card title="Recent trades" subtitle="Confirmed on-chain events, newest first.">
      {isLoading ? <Loading /> : error ? <ErrorState error={error} /> : !data || data.items.length === 0 ? <p className="text-sm text-ink2" role="status">No trades yet.</p> : (
        <Table head={["Time", "Trader", "Action", "Shares", "Tokens", "Price", "Tx"]}>
          {data.items.map((t) => (
            <tr key={t.transaction_hash + t.log_index}>
              <Td>{dateTime(t.timestamp)}</Td><Td className="num-col">{shortAddr(t.wallet_address)}</Td>
              <Td><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: t.outcome === "YES" ? "var(--yes)" : "var(--no)" }} />{t.action} {t.outcome}</Td>
              <Td className="num-col">{tokens(t.shares, 2)}</Td><Td className="num-col">{tokens(t.token_amount, 2)}</Td><Td className="num-col">{price(t.execution_price)}</Td>
              <Td><TxLink hash={t.transaction_hash} url={t.explorer_url} /></Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
