import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";
import { describe, expect, it } from "vitest";
import { humanizeError, CONTRACT_MESSAGES, isUserRejection } from "./errors";
import { dateTime, duration, price, relative, shortAddr, tokens } from "./format";
import { MAX_DIVERGENCE_RATIO, buyProblem, cost, maxBuyShares, priceYes, quoteBuy, quoteSell, sharesForBudget, withSlippage } from "./lmsr";
import { buildSiweMessage } from "./siwe";

// The same 64 vectors the Solidity tests check, produced by the independent mpmath implementation.
const vectors = JSON.parse(readFileSync(resolve(process.cwd(), "../contracts/reference/vectors.json"), "utf8"));
const tok = (wei: string) => Number(BigInt(wei)) / 1e18;

describe("indicative LMSR vs the 50-digit reference vectors", () => {
  it("cost() agrees to 1e-9 relative on all vectors", () => {
    for (const v of vectors.points) {
      const got = cost(tok(v.qYes), tok(v.qNo), tok(v.b)) * 1e18;
      const want = Number(BigInt(v.costFloor));
      expect(Math.abs(got - want) / want, `b=${v.b} q=(${v.qYes},${v.qNo})`).toBeLessThan(1e-9);
    }
  });

  it("priceYes() agrees to 1e-12 absolute on all vectors", () => {
    for (const v of vectors.points) {
      const got = priceYes(tok(v.qYes), tok(v.qNo), tok(v.b));
      expect(Math.abs(got - Number(BigInt(v.priceYesWad)) / 1e18), `b=${v.b}`).toBeLessThan(1e-12);
    }
  });

  it("replays the random trade sequences to the same share totals and a non-negative cost", () => {
    for (const seq of vectors.sequences) {
      const b = tok(seq.b);
      let qY = 0, qN = 0;
      for (const op of seq.ops) {
        const s = { qYes: qY, qNo: qN, b };
        const shares = tok(op.shares);
        const outcome = op.outcome === 0 ? "YES" : "NO";
        const q = op.action === "buy" ? quoteBuy(s, outcome, shares) : quoteSell(s, outcome, shares);
        expect(q.amount).toBeGreaterThan(0);
        const d = op.action === "buy" ? shares : -shares;
        if (outcome === "YES") qY += d; else qN += d;
        expect(Math.abs(qY - tok(op.qYesAfter)) + Math.abs(qN - tok(op.qNoAfter))).toBeLessThan(1e-6);
        // true cost after each step matches the reference's high-precision value
        expect(Math.abs(cost(qY, qN, b) - tok(op.trueCostCeilAfter)) / Math.max(1, tok(op.trueCostCeilAfter))).toBeLessThan(1e-9);
      }
    }
  });
});

describe("quote properties", () => {
  const s = { qYes: 0, qNo: 0, b: 100 };

  it("a fresh market is 50/50 and buying YES raises the YES price", () => {
    expect(priceYes(0, 0, 100)).toBe(0.5);
    const q = quoteBuy(s, "YES", 30);
    expect(q.yesPriceAfter).toBeGreaterThan(0.5);
    expect(q.avgPrice).toBeGreaterThan(0.5);
    expect(q.avgPrice).toBeLessThan(1);
    expect(q.priceImpactPct).toBeGreaterThan(0);
  });

  it("buying NO lowers the YES price; selling reverses a buy up to the spread", () => {
    expect(quoteBuy(s, "NO", 30).yesPriceAfter).toBeLessThan(0.5);
    const bought = quoteBuy(s, "YES", 40);
    const after = { ...s, qYes: 40 };
    const sold = quoteSell(after, "YES", 40);
    expect(sold.amount).toBeCloseTo(bought.amount, 9); // exact LMSR reversibility before on-chain rounding margin
  });

  it("price impact grows with size", () => {
    expect(quoteBuy(s, "YES", 80).priceImpactPct).toBeGreaterThan(quoteBuy(s, "YES", 8).priceImpactPct);
  });

  it("sharesForBudget inverts quoteBuy and respects the per-trade limits", () => {
    const shares = sharesForBudget(s, "YES", 25);
    expect(quoteBuy(s, "YES", shares).amount).toBeCloseTo(25, 6);
    expect(sharesForBudget(s, "YES", 0)).toBe(0);
    expect(sharesForBudget(s, "YES", 1e9)).toBe(100); // capped at b shares
  });

  it("flags trades the contract would reject", () => {
    expect(buyProblem(s, "YES", 0)).toMatch(/too small/);
    expect(buyProblem(s, "YES", 101)).toMatch(/Too large/);
    expect(buyProblem(s, "YES", 50)).toBeNull();
    const skewed = { qYes: MAX_DIVERGENCE_RATIO * 100 - 10, qNo: 0, b: 100 };
    expect(maxBuyShares(skewed, "YES")).toBeCloseTo(10, 9);
    expect(buyProblem(skewed, "YES", 20)).toMatch(/price limit/);
    expect(buyProblem(skewed, "NO", 20)).toBeNull();
  });

  it("slippage limits round in the user's safe direction", () => {
    expect(withSlippage(1_000_000n, 100, "max")).toBe(1_010_000n);
    expect(withSlippage(1_000_001n, 100, "max")).toBe(1_010_002n);
    expect(withSlippage(1_000_000n, 100, "min")).toBe(990_000n);
  });
});

describe("error messages", () => {
  const revert = (errorName: string) => {
    const inner = new ContractFunctionRevertedError({ abi: [], functionName: "buy", message: "reverted" });
    Object.defineProperty(inner, "data", { value: { errorName, args: [] } });
    return new BaseError("call failed", { cause: inner });
  };

  it("maps every known custom error to a human sentence", () => {
    for (const name of Object.keys(CONTRACT_MESSAGES)) expect(humanizeError(revert(name))).toBe(CONTRACT_MESSAGES[name]);
  });

  it("recognises wallet rejection however it is wrapped", () => {
    const rejected = new BaseError("x", { cause: new UserRejectedRequestError(new Error("denied")) });
    expect(isUserRejection(rejected)).toBe(true);
    expect(humanizeError(rejected)).toMatch(/rejected the request/);
    expect(humanizeError({ code: 4001, message: "User rejected the request." })).toMatch(/rejected the request/);
  });

  it("falls back to readable text for network and unknown errors", () => {
    expect(humanizeError(new Error("The current chain of the wallet (id: 1) does not match the target chain"))).toMatch(/different network/);
    expect(humanizeError(new Error("insufficient funds for gas"))).toMatch(/network fees/);
    expect(humanizeError(new Error("Failed to fetch"))).toMatch(/Could not reach the network/);
    expect(humanizeError(new Error("some odd failure"))).toMatch(/Transaction failed: some odd failure/);
    expect(humanizeError(undefined)).toMatch(/Nothing was sent/);
  });

  it("finds a contract error name in a plain message too", () => {
    expect(humanizeError(new Error("execution reverted: TradingClosed()"))).toBe(CONTRACT_MESSAGES.TradingClosed);
  });
});

describe("sign-in message", () => {
  it("is a valid EIP-4361 message with a checksummed address", () => {
    const msg = buildSiweMessage({
      domain: "localhost:5173", address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", statement: "Sign in (TEST tokens only).",
      uri: "http://localhost:5173", chainId: 31337, nonce: "abc12345", issuedAt: new Date("2026-11-04T10:00:00.000Z"),
    });
    expect(msg.split("\n")).toEqual([
      "localhost:5173 wants you to sign in with your Ethereum account:",
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "",
      "Sign in (TEST tokens only).",
      "",
      "URI: http://localhost:5173",
      "Version: 1",
      "Chain ID: 31337",
      "Nonce: abc12345",
      "Issued At: 2026-11-04T10:00:00.000Z",
      "Expiration Time: 2026-11-04T10:10:00.000Z",
    ]);
  });
});

describe("formatting", () => {
  it("shows token amounts without a currency symbol", () => {
    expect(tokens("1234500000000000000000")).toBe("1,234.50");
    expect(tokens("500000000000000000", 3)).toBe("0.500");
    expect(tokens(null)).toBe("-");
    expect(price("0.65234")).toBe("0.652");
    expect(shortAddr("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toBe("0x7099…79C8");
  });

  it("describes time relative to now", () => {
    const now = new Date("2026-11-04T12:00:00Z").getTime();
    expect(relative("2026-11-04T15:00:00Z", now)).toBe("in 3h");
    expect(relative("2026-11-02T12:00:00Z", now)).toBe("2d ago");
    expect(duration(7200)).toBe("2 h");
    expect(dateTime("2026-11-04T12:00:00Z")).toContain("2026");
  });
});
