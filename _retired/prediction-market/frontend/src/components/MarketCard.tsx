import { Link } from "react-router-dom";
import { ProbabilityBar } from "../charts/ProbabilityBar";
import { relative, tokens } from "../lib/format";
import type { Market } from "../lib/types";
import { Pill, StatusBadge } from "./ui";

export function MarketCard({ m }: { m: Market }) {
  const closing = m.status === "active" ? `closes ${relative(m.trading_close_time)}` : m.status === "closed" ? `closed ${relative(m.trading_close_time)}` : m.winning_outcome ? `resolved ${m.winning_outcome}` : "voided";
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-edge bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2"><Pill>{m.category}</Pill><StatusBadge status={m.status} /></div>
      <h3 className="text-base font-semibold leading-snug"><Link to={`/markets/${m.id}`} className="hover:underline">{m.question}</Link></h3>
      {m.trade_count > 0 ? <ProbabilityBar yes={Number(m.yes_price)} /> : (
        <div><ProbabilityBar yes={0.5} /><p className="mt-1 text-xs text-muted">No trades yet: opening price, not a trader consensus.</p></div>
      )}
      <p className="mt-auto flex flex-wrap justify-between gap-x-3 text-xs text-ink2"><span>{closing}</span><span className="num-col">{m.trade_count} trades · {tokens(m.volume, 0)} tokens</span></p>
    </article>
  );
}
