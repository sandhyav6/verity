import { txUrl, useAppConfig } from "../blockchain/config";
import type { TxState } from "../hooks/useTx";
import { Alert } from "./ui/feedback";
import { Spinner } from "./ui/icons";
import { HashText } from "./ui/primitives";

/** Honest transaction progress: each phase is reported only when it has actually happened. */
export function TxPanel({ state, extra }: { state: TxState; extra?: string | null }) {
  const cfg = useAppConfig();
  const link = state.hash ? txUrl(cfg, state.hash) : null;
  if (state.phase === "idle") return extra ? <Alert tone="info">{extra}</Alert> : null;
  if (state.phase === "failed") {
    return (
      <Alert tone="bad" title="The transaction did not complete">
        {state.error}
        {state.hash && <span className="mt-2 block text-xs">Transaction: <HashText value={state.hash} short label="transaction hash" /></span>}
      </Alert>
    );
  }
  if (state.phase === "confirmed") {
    return <Alert tone="ok" title="Confirmed on-chain">{state.hash && <HashText value={state.hash} short label="transaction hash" />}{link && <> · <a className="text-accent underline" href={link} target="_blank" rel="noopener noreferrer">View on explorer</a></>}</Alert>;
  }
  return (
    <div role="status" className="flex items-start gap-3 rounded-md border border-line bg-surface2 px-4 py-3 text-sm">
      <Spinner className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0">
        <p className="font-medium text-ink">{state.phase === "awaiting_wallet" ? "Confirm the transaction in your wallet…" : "Waiting for the network to confirm…"}</p>
        <p className="mt-0.5 text-muted">{state.phase === "awaiting_wallet" ? "Nothing is recorded until you approve it." : "The registration is not complete until the transaction is mined."}</p>
        {state.hash && <p className="mt-1 text-xs">Transaction: <HashText value={state.hash} short label="transaction hash" />{link && <> · <a className="text-accent underline" href={link} target="_blank" rel="noopener noreferrer">explorer</a></>}</p>}
        {state.slow && <p className="mt-1 text-xs text-warn">This is taking longer than usual. You can keep this page open; the transaction may still be confirmed.</p>}
      </div>
    </div>
  );
}
