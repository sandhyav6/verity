import { useState, useSyncExternalStore } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button, Card, Empty, ErrorState, Loading, Pill, Table, Td, TxLink } from "../components/ui";
import { useTrades, useTxStatus } from "../hooks/queries";
import { useWallet } from "../hooks/useWallet";
import { dateTime, price, shortAddr, tokens } from "../lib/format";
import { getTrackedTxs, subscribeTxs } from "../lib/txStore";

const PAGE = 20;

function LiveStatus({ hash }: { hash: string }) {
  const { data, isLoading, error } = useTxStatus(hash);
  if (isLoading) return <span className="text-muted">checking…</span>;
  if (error || !data) return <span className="text-crit">unavailable</span>;
  // "indexed" only appears for event types the indexer stores (trades, market and resolution events);
  // e.g. a faucet claim is confirmed on-chain but is deliberately never indexed.
  const label = data.status === "success" ? `✓ confirmed · ${data.confirmations} confirmation${data.confirmations === 1 ? "" : "s"}${data.indexed ? " · indexed" : ""}` : data.status === "failed" ? "✗ reverted" : data.status === "pending" ? "◐ pending" : "not found";
  return <Pill tone={data.status === "failed" ? "bad" : data.status === "success" ? "good" : "neutral"}>{label}</Pill>;
}

export function Transactions() {
  const w = useWallet();
  const [sp] = useSearchParams();
  const lookup = sp.get("hash");
  const [mine, setMine] = useState(true);
  const [page, setPage] = useState(0);
  const tracked = useSyncExternalStore(subscribeTxs, getTrackedTxs);
  const wallet = mine && w.address ? w.address : undefined;
  const { data, isLoading, error, refetch } = useTrades({ wallet, limit: PAGE, offset: page * PAGE });

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Transactions</h1>

      {lookup && <Card title="Transaction lookup"><p className="num-col break-all text-sm">{lookup}</p><div className="mt-2 text-sm"><LiveStatus hash={lookup} /></div></Card>}

      <Card title="Submitted from this browser" subtitle="Live status straight from the node, including transactions the indexer has not seen yet.">
        {tracked.length === 0 ? <p className="text-sm text-ink2" role="status">You have not sent any transaction in this session.</p> : (
          <Table head={["Submitted", "Action", "Hash", "Status"]}>
            {tracked.map((t) => <tr key={t.hash}><Td>{dateTime(new Date(t.submittedAt).toISOString())}</Td><Td>{t.label}</Td><Td><TxLink hash={t.hash} /></Td><Td><LiveStatus hash={t.hash} /></Td></tr>)}
          </Table>
        )}
      </Card>

      <Card title="Trade history" subtitle="Confirmed on-chain trades read from the indexer (each row exists only after the required confirmations)."
        actions={w.address ? <div className="flex gap-1 text-xs"><Button variant={mine ? "primary" : "secondary"} onClick={() => { setMine(true); setPage(0); }}>My trades</Button><Button variant={!mine ? "primary" : "secondary"} onClick={() => { setMine(false); setPage(0); }}>All trades</Button></div> : undefined}>
        {isLoading ? <Loading /> : error ? <ErrorState error={error} retry={() => refetch()} /> : !data?.items.length ? (
          <Empty title={wallet ? "You have no trades yet" : "No trades yet"} action={<Link className="text-accent underline" to="/markets">Browse markets</Link>}>{wallet ? "Trades you make will appear here once confirmed." : "Connect a wallet to see only your own trades."}</Empty>
        ) : (
          <>
            <Table head={["Time", "Market", "Outcome", "Action", "Shares", "Tokens", "Exec. price", "Block", "Tx", "Status"]}>
              {data.items.map((t) => (
                <tr key={t.transaction_hash + t.log_index}>
                  <Td>{dateTime(t.timestamp)}</Td>
                  <Td><Link className="hover:underline" to={`/markets/${t.market_id}`}>{(t.market_question ?? `#${t.market_id}`).slice(0, 40)}</Link><div className="num-col text-xs text-muted">{shortAddr(t.wallet_address)}</div></Td>
                  <Td><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: t.outcome === "YES" ? "var(--yes)" : "var(--no)" }} />{t.outcome}</Td>
                  <Td>{t.action}</Td><Td className="num-col">{tokens(t.shares)}</Td><Td className="num-col">{tokens(t.token_amount)}</Td><Td className="num-col">{price(t.execution_price)}</Td>
                  <Td className="num-col">{t.block_number}</Td><Td><TxLink hash={t.transaction_hash} url={t.explorer_url} /></Td><Td><Pill tone="good">✓ confirmed</Pill></Td>
                </tr>
              ))}
            </Table>
            <div className="mt-3 flex items-center justify-between"><Button variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Newer</Button><span className="text-sm text-ink2">{data.total} total</span><Button variant="secondary" disabled={(page + 1) * PAGE >= data.total} onClick={() => setPage((p) => p + 1)}>Older →</Button></div>
          </>
        )}
      </Card>
    </div>
  );
}
