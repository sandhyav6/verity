import { useReadContract } from "wagmi";
import { predictionMarketAbi } from "../blockchain/abis";
import { addr } from "../blockchain/config";
import { useTx } from "../hooks/useTx";
import { useWallet } from "../hooks/useWallet";
import { tokens } from "../lib/format";
import type { Market } from "../lib/types";
import { Banner, Button, Card, TxLink } from "./ui";

/** Settlement actions after a market is resolved or voided. Amounts are read from the contract. */
export function SettlePanel({ market }: { market: Market }) {
  const w = useWallet();
  const tx = useTx();
  const a = addr(market.contract_address);
  const user = w.address;
  const q = (fn: "yesShares" | "noShares" | "costBasis") => useReadContract({ address: a, abi: predictionMarketAbi, functionName: fn, args: user ? [user] : undefined, query: { enabled: !!user, refetchInterval: 6000 } }); // eslint-disable-line react-hooks/rules-of-hooks
  const yes = q("yesShares").data as bigint | undefined;
  const no = q("noShares").data as bigint | undefined;
  const basis = q("costBasis").data as bigint | undefined;
  const { data: residual } = useReadContract({ address: a, abi: predictionMarketAbi, functionName: "residual", query: { refetchInterval: 6000 } });
  const { data: claimed } = useReadContract({ address: a, abi: predictionMarketAbi, functionName: "residualClaimed", query: { refetchInterval: 6000 } });

  const isCreator = !!user && user.toLowerCase() === market.created_by.toLowerCase();
  const winning = market.winning_outcome === "YES" ? yes : market.winning_outcome === "NO" ? no : undefined;
  const settled = market.status === "resolved" || market.status === "invalid";
  if (!settled) return null;
  const inval = ["market", market.id] as const;

  const run = (fn: "redeem" | "refund" | "claimResidual", label: string) => tx.send({ address: a, abi: predictionMarketAbi, functionName: fn, label, invalidate: [[...inval], ["portfolio"], ["trades"]] });

  return (
    <Card title="Settlement" subtitle={market.status === "resolved" ? `Resolved ${market.winning_outcome}. Each winning share redeems for exactly 1 test token; losing shares are worth nothing.` : "Voided: the outcome could not be determined. Your net cost is refunded (pro-rated only if funds fall short)."}>
      {!user ? <p className="text-sm text-ink2">Connect your wallet to see your position.</p> : (
        <div className="space-y-3 text-sm">
          <p>Your shares: <span className="num-col">{yes !== undefined ? tokens(yes, 4) : "…"} YES · {no !== undefined ? tokens(no, 4) : "…"} NO</span></p>
          {market.status === "resolved" && (
            <Button disabled={tx.busy || !winning || winning === 0n || w.wrongNetwork} onClick={() => run("redeem", `Redeem winnings · market #${market.id}`)}>
              {winning && winning > 0n ? `Redeem ${tokens(winning, 4)} tokens` : "Nothing to redeem"}
            </Button>
          )}
          {market.status === "invalid" && (
            <Button disabled={tx.busy || !basis || basis <= 0n || w.wrongNetwork} onClick={() => run("refund", `Claim refund · market #${market.id}`)}>
              {basis && basis > 0n ? `Claim refund (up to ${tokens(basis, 4)} tokens)` : "No refund due"}
            </Button>
          )}
          {isCreator && (
            <div className="border-t border-grid pt-3">
              <p className="text-ink2">As creator you funded this market's liquidity. Unspent subsidy: <span className="num-col">{residual !== undefined ? tokens(residual as bigint, 4) : "…"}</span> tokens.</p>
              <Button className="mt-2" variant="secondary" disabled={tx.busy || !!claimed || w.wrongNetwork} onClick={() => run("claimResidual", `Claim leftover subsidy · market #${market.id}`)}>{claimed ? "Already claimed" : "Claim leftover subsidy"}</Button>
            </div>
          )}
          {tx.state.phase === "pending" && tx.state.hash && <Banner>Submitted <TxLink hash={tx.state.hash} />…</Banner>}
          {tx.state.phase === "confirmed" && <Banner tone="ok">Done. Balances update shortly.</Banner>}
          {tx.state.phase === "failed" && <Banner tone="error">{tx.state.error}</Banner>}
        </div>
      )}
    </Card>
  );
}
