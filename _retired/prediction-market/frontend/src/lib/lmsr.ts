/**
 * INDICATIVE LMSR maths in the browser (token units, IEEE doubles).
 *
 * The contract is authoritative: it prices in 18-decimal fixed point and rounds in the market's
 * favour. This module exists so the UI can show an instant estimate and let the user type either a
 * share count or a token budget. Every trade is re-quoted by the contract's `quoteBuy`/`quoteSell`
 * view before signing, and `maxCost`/`minProceeds` enforce slippage on-chain.
 *
 * Cost uses the same overflow-safe form as the contract: C = max(q) + b * ln(1 + e^(-|qY-qN|/b)).
 */

export interface MarketState { qYes: number; qNo: number; b: number }
export type Outcome = "YES" | "NO";

export const MAX_DIVERGENCE_RATIO = 20; // |qYes - qNo| <= 20 b after any buy
export const MIN_TRADE = 1e-6; // shares; mirrors PredictionMarket.MIN_TRADE (1e12 wei)

export function cost(qYes: number, qNo: number, b: number): number {
  const hi = Math.max(qYes, qNo);
  const lo = Math.min(qYes, qNo);
  return hi + b * Math.log1p(Math.exp(-(hi - lo) / b));
}

export function priceYes(qYes: number, qNo: number, b: number): number {
  return 1 / (1 + Math.exp(-(qYes - qNo) / b));
}

function after(s: MarketState, outcome: Outcome, delta: number): MarketState {
  return outcome === "YES" ? { ...s, qYes: s.qYes + delta } : { ...s, qNo: s.qNo + delta };
}

export interface Quote {
  /** tokens paid (buy) or received (sell) */
  amount: number;
  shares: number;
  /** amount / shares */
  avgPrice: number;
  /** marginal YES price after the trade */
  yesPriceAfter: number;
  /** how far the average price sits from the current price of that outcome, in percent */
  priceImpactPct: number;
}

function outcomePrice(yes: number, outcome: Outcome): number {
  return outcome === "YES" ? yes : 1 - yes;
}

export function quoteBuy(s: MarketState, outcome: Outcome, shares: number): Quote {
  const next = after(s, outcome, shares);
  const amount = cost(next.qYes, next.qNo, s.b) - cost(s.qYes, s.qNo, s.b);
  const avgPrice = shares > 0 ? amount / shares : 0;
  const p0 = outcomePrice(priceYes(s.qYes, s.qNo, s.b), outcome);
  return { amount, shares, avgPrice, yesPriceAfter: priceYes(next.qYes, next.qNo, s.b), priceImpactPct: p0 > 0 ? ((avgPrice - p0) / p0) * 100 : 0 };
}

export function quoteSell(s: MarketState, outcome: Outcome, shares: number): Quote {
  const next = after(s, outcome, -shares);
  const amount = cost(s.qYes, s.qNo, s.b) - cost(next.qYes, next.qNo, s.b);
  const avgPrice = shares > 0 ? amount / shares : 0;
  const p0 = outcomePrice(priceYes(s.qYes, s.qNo, s.b), outcome);
  return { amount, shares, avgPrice, yesPriceAfter: priceYes(next.qYes, next.qNo, s.b), priceImpactPct: p0 > 0 ? ((p0 - avgPrice) / p0) * 100 : 0 };
}

/** Largest share count a single buy may have right now, from the contract's two limits. */
export function maxBuyShares(s: MarketState, outcome: Outcome): number {
  const room = MAX_DIVERGENCE_RATIO * s.b - (outcome === "YES" ? s.qYes - s.qNo : s.qNo - s.qYes);
  return Math.max(0, Math.min(s.b, room));
}

/** Reason a buy would be rejected on-chain, or null. Indicative pre-check only. */
export function buyProblem(s: MarketState, outcome: Outcome, shares: number): string | null {
  if (!(shares >= MIN_TRADE)) return "Amount is too small (minimum 0.000001 shares).";
  if (shares > s.b) return `Too large: a single buy is limited to ${s.b.toFixed(2)} shares (the liquidity parameter).`;
  if (shares > maxBuyShares(s, outcome) + 1e-9) return "This would push the market past its price limit (|YES - NO| ≤ 20× liquidity).";
  return null;
}

/** Shares obtainable for a token budget (bisection on the cost function; monotone, so it converges). */
export function sharesForBudget(s: MarketState, outcome: Outcome, budget: number): number {
  if (!(budget > 0)) return 0;
  let lo = 0;
  let hi = Math.max(maxBuyShares(s, outcome), 0);
  if (hi === 0) return 0;
  if (quoteBuy(s, outcome, hi).amount <= budget) return hi;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (quoteBuy(s, outcome, mid).amount <= budget) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Slippage-protected limit passed to the contract: contract quote plus a tolerance, rounded up. */
export function withSlippage(amountWei: bigint, bps: number, direction: "max" | "min"): bigint {
  const b = BigInt(Math.round(bps));
  return direction === "max" ? (amountWei * (10000n + b) + 9999n) / 10000n : (amountWei * (10000n - b)) / 10000n;
}
