import { useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { useReadContract } from "wagmi";
import { predictionMarketAbi, testTokenAbi } from "../blockchain/abis";
import { addr, useAppConfig } from "../blockchain/config";
import { useTx } from "../hooks/useTx";
import { useWallet } from "../hooks/useWallet";
import { humanizeError } from "../lib/errors";
import { pct, price, tokens } from "../lib/format";
import { buyProblem, quoteBuy, quoteSell, sharesForBudget, withSlippage, type MarketState, type Outcome } from "../lib/lmsr";
import type { Market } from "../lib/types";
import { Banner, Button, Card, TxLink } from "./ui";

const SLIPPAGE_BPS = [50, 100, 200, 500];
const toWei = (n: number): bigint => (n > 0 && Number.isFinite(n) ? parseUnits(n.toFixed(12), 18) : 0n);
const tok = (wei: bigint) => Number(formatUnits(wei, 18));

export function stateOf(m: Market): MarketState {
  return { qYes: tok(BigInt(m.q_yes)), qNo: tok(BigInt(m.q_no)), b: tok(BigInt(m.liquidity_parameter)) };
}

export function TradePanel({ market }: { market: Market }) {
  const cfg = useAppConfig();
  const wallet = useWallet();
  const tx = useTx();
  const [action, setAction] = useState<"buy" | "sell">("buy");
  const [outcome, setOutcome] = useState<Outcome>("YES");
  const [mode, setMode] = useState<"shares" | "tokens">("shares");
  const [input, setInput] = useState("");
  const [slip, setSlip] = useState(100);
  const [confirming, setConfirming] = useState(false);

  const marketAddr = addr(market.contract_address);
  const user = wallet.address;
  const tradable = market.status === "active";
  const s = useMemo(() => stateOf(market), [market]);
  const idx = outcome === "YES" ? 0 : 1;

  const { data: balance } = useReadContract({ address: addr(cfg.token_address), abi: testTokenAbi, functionName: "balanceOf", args: user ? [user] : undefined, query: { enabled: !!user, refetchInterval: 5000 } });
  const { data: heldWei } = useReadContract({ address: marketAddr, abi: predictionMarketAbi, functionName: outcome === "YES" ? "yesShares" : "noShares", args: user ? [user] : undefined, query: { enabled: !!user, refetchInterval: 5000 } });
  const held = heldWei !== undefined ? tok(heldWei as bigint) : 0;

  // ---- what the user typed -> a share count
  const typed = Number(input);
  const validInput = input.trim() !== "" && Number.isFinite(typed) && typed > 0;
  const shares = !validInput ? 0 : action === "sell" || mode === "shares" ? typed : sharesForBudget(s, outcome, typed);
  const sharesWei = toWei(shares);

  // ---- indicative estimate (browser) and its client-side pre-check
  const problem = validInput ? (action === "buy" ? buyProblem(s, outcome, shares) : shares > held + 1e-9 ? `You hold only ${held.toFixed(4)} ${outcome} shares.` : null) : null;
  const estimate = validInput && !problem ? (action === "buy" ? quoteBuy(s, outcome, shares) : quoteSell(s, outcome, shares)) : null;

  // ---- the contract's own quote: the number that actually gets charged
  const quoteEnabled = tradable && validInput && !problem && sharesWei > 0n && !wallet.wrongNetwork;
  const contractQuote = useReadContract({
    address: marketAddr, abi: predictionMarketAbi, functionName: action === "buy" ? "quoteBuy" : "quoteSell", args: [idx, sharesWei],
    query: { enabled: quoteEnabled, refetchInterval: 6000 },
  });
  const quoteWei = contractQuote.data as bigint | undefined;
  const quoteError = contractQuote.error ? humanizeError(contractQuote.error) : null;
  const limitWei = quoteWei === undefined ? undefined : withSlippage(quoteWei, slip, action === "buy" ? "max" : "min");
  const short = action === "buy" && quoteWei !== undefined && balance !== undefined && (balance as bigint) < quoteWei;

  const blocker = !tradable ? (market.status === "closed" ? "Trading has closed; this market is waiting for its result." : `This market is ${market.status === "resolved" ? "resolved" : "voided"}. See the settlement panel.`) : null;
  const canReview = !blocker && wallet.isConnected && !wallet.wrongNetwork && validInput && !problem && !quoteError && quoteWei !== undefined && !short && !tx.busy;

  async function submit() {
    if (quoteWei === undefined || limitWei === undefined) return;
    setConfirming(false);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    const hash = await tx.send({
      address: marketAddr, abi: predictionMarketAbi, functionName: action, args: [idx, sharesWei, limitWei, deadline],
      label: `${action === "buy" ? "Buy" : "Sell"} ${outcome} · market #${market.id}`,
      invalidate: [["market", market.id], ["history", market.id], ["trades"], ["portfolio"], ["markets"], ["overview"]],
    });
    if (hash) setInput("");
  }

  return (
    <Card title="Trade" subtitle="Test tokens only. No money is involved.">
      <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-wash p-1" role="tablist" aria-label="Buy or sell">
        {(["buy", "sell"] as const).map((a) => (
          <button key={a} role="tab" aria-selected={action === a} onClick={() => { setAction(a); setConfirming(false); }} className={`rounded-md py-2 text-sm font-medium capitalize ${action === a ? "bg-surface text-ink shadow-sm" : "text-ink2"}`}>{a}</button>
        ))}
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Outcome">
        {(["YES", "NO"] as const).map((o) => {
          const p = o === "YES" ? Number(market.yes_price) : Number(market.no_price);
          return (
            <button key={o} role="radio" aria-checked={outcome === o} onClick={() => { setOutcome(o); setConfirming(false); }}
              className={`rounded-lg border-2 px-3 py-2 text-left ${outcome === o ? "" : "border-edge opacity-80"}`} style={outcome === o ? { borderColor: o === "YES" ? "var(--yes)" : "var(--no)" } : undefined}>
              <span className="flex items-center gap-1.5 text-sm font-semibold"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: o === "YES" ? "var(--yes)" : "var(--no)" }} />{o}</span>
              <span className="num-col text-lg font-semibold">{price(p)}</span><span className="ml-1 text-xs text-muted">{pct(p, 0)}</span>
            </button>
          );
        })}
      </div>

      {action === "buy" && (
        <div className="mb-2 flex gap-3 text-xs text-ink2" role="radiogroup" aria-label="Amount type">
          {(["shares", "tokens"] as const).map((m) => (
            <label key={m} className="flex items-center gap-1"><input type="radio" name="mode" checked={mode === m} onChange={() => { setMode(m); setInput(""); }} />{m === "shares" ? "Enter shares" : "Enter token budget"}</label>
          ))}
        </div>
      )}
      <label className="block text-sm">
        <span className="sr-only">{action === "sell" || mode === "shares" ? "Number of shares" : "Token budget"}</span>
        <div className="flex gap-2">
          <input className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-ink" inputMode="decimal" placeholder={action === "sell" || mode === "shares" ? "Shares, e.g. 25" : "Tokens to spend, e.g. 10"} value={input} onChange={(e) => { setInput(e.target.value); setConfirming(false); }} disabled={!tradable} aria-label={action === "sell" || mode === "shares" ? "Number of shares" : "Token budget"} />
          {action === "sell" && <Button variant="secondary" onClick={() => setInput(held > 0 ? String(held) : "")} disabled={held <= 0}>Max</Button>}
        </div>
      </label>
      {user && <p className="mt-1 text-xs text-muted">Balance {balance !== undefined ? tokens(balance as bigint) : "…"} tokens · You hold {held.toFixed(4)} {outcome} shares</p>}

      {input.trim() !== "" && !validInput && <p className="mt-2 text-xs text-crit" role="alert">Enter a positive number.</p>}
      {problem && <p className="mt-2 text-xs text-crit" role="alert">{problem}</p>}

      {estimate && (
        <dl className="mt-3 space-y-1 rounded-lg bg-wash p-3 text-sm" aria-label="Quote">
          <p className="text-xs font-medium text-ink2">Estimate (calculated in your browser, not binding)</p>
          <Row k={action === "buy" ? "Estimated cost" : "Estimated proceeds"} v={`${estimate.amount.toFixed(4)} tokens`} />
          <Row k="Shares" v={shares.toFixed(4)} />
          <Row k="Average price" v={`${estimate.avgPrice.toFixed(4)} per share`} />
          <Row k="Price impact" v={`${estimate.priceImpactPct.toFixed(2)}%`} />
          <Row k="YES probability after" v={`${pct(market.yes_price)} → ${pct(estimate.yesPriceAfter)}`} />
          <div className="my-2 border-t border-grid" />
          <p className="text-xs font-medium text-ink2">Contract quote (authoritative, read from the smart contract)</p>
          {quoteError ? <p className="text-xs text-crit" role="alert">{quoteError}</p> : quoteWei === undefined ? <p className="text-xs text-muted">{wallet.isConnected ? "Fetching…" : "Connect a wallet to fetch the contract's quote."}</p> : (
            <>
              <Row k={action === "buy" ? "You pay" : "You receive"} v={`${tokens(quoteWei, 4)} tokens`} strong />
              <Row k={action === "buy" ? `Maximum you can be charged (+${slip / 100}%)` : `Minimum you will receive (−${slip / 100}%)`} v={`${tokens(limitWei, 4)} tokens`} />
            </>
          )}
        </dl>
      )}

      <div className="mt-3 flex items-center gap-2 text-xs text-ink2">
        <label htmlFor="slippage">Slippage tolerance</label>
        <select id="slippage" className="rounded border border-line bg-surface px-1 py-1" value={slip} onChange={(e) => setSlip(Number(e.target.value))}>
          {SLIPPAGE_BPS.map((b) => <option key={b} value={b}>{b / 100}%</option>)}
        </select>
      </div>

      <div className="mt-4 space-y-2">
        {blocker && <Banner tone="warn">{blocker}</Banner>}
        {short && <Banner tone="warn">Not enough test tokens for this trade. Use “Get test tokens” in the top bar.</Banner>}
        {!wallet.isConnected ? (
          <Button className="w-full" onClick={wallet.connect} disabled={wallet.connecting || !wallet.hasInjectedWallet}>{wallet.hasInjectedWallet ? "Connect wallet to trade" : "Install MetaMask to trade"}</Button>
        ) : wallet.wrongNetwork ? (
          <Button className="w-full" variant="secondary" onClick={wallet.switchNetwork} disabled={wallet.switching}>Switch to {cfg.chain_name} to trade</Button>
        ) : confirming ? (
          <div className="rounded-lg border-2 border-line p-3 text-sm" role="dialog" aria-label="Confirm trade">
            <p className="font-medium">Confirm: {action} {shares.toFixed(4)} {outcome} shares</p>
            <p className="mt-1 text-ink2">{action === "buy" ? "Pay about" : "Receive about"} {tokens(quoteWei, 4)} tokens ({action === "buy" ? "never more than" : "never less than"} {tokens(limitWei, 4)}). Your wallet will ask you to approve.</p>
            <div className="mt-2 flex gap-2">
              <Button variant={outcome === "YES" ? "yes" : "no"} onClick={submit} disabled={tx.busy}>Confirm {action}</Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button className="w-full" variant={outcome === "YES" ? "yes" : "no"} disabled={!canReview} onClick={() => setConfirming(true)}>
            {tx.state.phase === "awaiting_wallet" ? "Confirm in your wallet…" : tx.state.phase === "pending" ? "Waiting for confirmation…" : `Review ${action} ${outcome}`}
          </Button>
        )}

        {tx.state.phase === "pending" && tx.state.hash && <Banner>Submitted <TxLink hash={tx.state.hash} />. Waiting for the network to confirm…</Banner>}
        {tx.state.phase === "confirmed" && tx.state.hash && <Banner tone="ok">Trade confirmed (<TxLink hash={tx.state.hash} />). It shows in history once the indexer has processed it.</Banner>}
        {tx.state.phase === "failed" && <Banner tone="error">{tx.state.error}</Banner>}
      </div>
      <p className="mt-3 text-xs text-muted">The estimate is a convenience. The smart contract recomputes the price when your transaction runs and reverts if it exceeds your limit.</p>
    </Card>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return <div className="flex justify-between gap-3"><dt className="text-ink2">{k}</dt><dd className={`num-col text-right ${strong ? "font-semibold text-ink" : "text-ink"}`}>{v}</dd></div>;
}
