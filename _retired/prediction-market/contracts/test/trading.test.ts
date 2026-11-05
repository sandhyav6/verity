import { expect } from "chai";
import { readFileSync } from "node:fs";
import {
  ethers,
  networkHelpers,
  deploySystem,
  createMarket,
  fund,
  deadline,
  E18,
  Outcome,
  DAY,
} from "./helpers.js";

const vectors = JSON.parse(readFileSync(new URL("../reference/vectors.json", import.meta.url), "utf8"));

async function setup(b = 100n * E18) {
  const sys = await deploySystem();
  const m = await createMarket(sys, b);
  for (const u of [sys.alice, sys.bob, sys.carol, sys.dave]) await fund(sys, u, 50_000n * E18);
  return { sys, ...m };
}

describe("PredictionMarket trading (LMSR)", () => {
  it("buying YES raises the YES price; buying NO lowers it; prices sum to 1", async () => {
    const { sys, market } = await setup();
    const p0: bigint = await market.priceYes();
    await market.connect(sys.alice).buy(Outcome.Yes, 20n * E18, 100n * E18, await deadline());
    const p1: bigint = await market.priceYes();
    expect(p1 > p0).to.equal(true);
    await market.connect(sys.bob).buy(Outcome.No, 40n * E18, 100n * E18, await deadline());
    const p2: bigint = await market.priceYes();
    expect(p2 < p1).to.equal(true);
    expect((await market.priceYes()) + (await market.priceNo())).to.equal(E18);
  });

  it("charges exactly the quoted cost, updates positions and emits SharesPurchased", async () => {
    const { sys, market } = await setup();
    const shares = 25n * E18;
    const quote: bigint = await market.quoteBuy(Outcome.Yes, shares);
    const before: bigint = await sys.token.balanceOf(sys.alice.address);
    const tx = await market.connect(sys.alice).buy(Outcome.Yes, shares, quote, await deadline());
    await expect(tx).to.emit(market, "SharesPurchased");
    const after: bigint = await sys.token.balanceOf(sys.alice.address);
    expect(before - after).to.equal(quote);
    expect(await market.yesShares(sys.alice.address)).to.equal(shares);
    expect(await market.qYes()).to.equal(shares);
    expect(await market.costBasis(sys.alice.address)).to.equal(quote);
    console.log(`      gas: buy = ${(await tx.wait())!.gasUsed}`);
  });

  it("does not need a per-market approve (implicit allowance for registered markets)", async () => {
    const { sys, market } = await setup();
    expect(await sys.token.allowance(sys.alice.address, await market.getAddress())).to.equal(2n ** 256n - 1n);
    await market.connect(sys.alice).buy(Outcome.No, 1n * E18, 10n * E18, await deadline());
  });

  it("enforces slippage, deadline, size limits and the divergence cap", async () => {
    const { sys, market } = await setup();
    const q: bigint = await market.quoteBuy(Outcome.Yes, 10n * E18);
    await expect(
      market.connect(sys.alice).buy(Outcome.Yes, 10n * E18, q - 1n, await deadline()),
    ).to.be.revertedWithCustomError(market, "SlippageExceeded");
    await expect(
      market.connect(sys.alice).buy(Outcome.Yes, 10n * E18, q, BigInt(await networkHelpers.time.latest()) - 1n),
    ).to.be.revertedWithCustomError(market, "DeadlineExpired");
    await expect(market.connect(sys.alice).buy(Outcome.Yes, 0, q, await deadline())).to.be.revertedWithCustomError(
      market,
      "TradeTooSmall",
    );
    await expect(
      market.connect(sys.alice).buy(Outcome.Yes, 101n * E18, 10_000n * E18, await deadline()),
    ).to.be.revertedWithCustomError(market, "TradeTooLarge");

    // Push YES until |qY - qN| would exceed 20b: the 21st full-size buy must revert.
    let reverted = false;
    for (let i = 0; i < 25 && !reverted; i++) {
      try {
        await market.connect(sys.alice).buy(Outcome.Yes, 100n * E18, 10_000n * E18, await deadline());
      } catch (e: any) {
        reverted = true;
        expect(String(e.message)).to.contain("DivergenceTooLarge");
      }
    }
    expect(reverted).to.equal(true);
    const price: bigint = await market.priceYes();
    expect(price > (E18 * 999_999_000n) / 1_000_000_000n).to.equal(true); // ~1 but never above 1
    expect(price < E18).to.equal(true);
  });

  it("rejects trading after the close time and with unknown/invalid shares", async () => {
    const { sys, market, tradingClose } = await setup();
    await networkHelpers.time.increaseTo(tradingClose);
    await expect(
      market.connect(sys.alice).buy(Outcome.Yes, E18, 10n * E18, await deadline()),
    ).to.be.revertedWithCustomError(market, "TradingClosed");
    await expect(
      market.connect(sys.alice).sell(Outcome.Yes, E18, 0, await deadline()),
    ).to.be.revertedWithCustomError(market, "TradingClosed");
  });

  it("selling returns less than buying cost (no free money) and keeps accounting exact", async () => {
    const { sys, market } = await setup();
    const shares = 30n * E18;
    const cost: bigint = await market.quoteBuy(Outcome.Yes, shares);
    await market.connect(sys.alice).buy(Outcome.Yes, shares, cost, await deadline());
    const proceeds: bigint = await market.quoteSell(Outcome.Yes, shares);
    expect(proceeds < cost).to.equal(true);
    const tx = await market.connect(sys.alice).sell(Outcome.Yes, shares, proceeds, await deadline());
    await expect(tx).to.emit(market, "SharesSold");
    console.log(`      gas: sell = ${(await tx.wait())!.gasUsed}; round-trip loss = ${cost - proceeds} wei`);
    expect(await market.yesShares(sys.alice.address)).to.equal(0n);
    expect(await market.qYes()).to.equal(0n);
    expect(await sys.token.balanceOf(await market.getAddress())).to.equal(await market.collateral());
  });

  it("cannot sell more than held, and sell slippage is enforced", async () => {
    const { sys, market } = await setup();
    await market.connect(sys.alice).buy(Outcome.Yes, 10n * E18, 100n * E18, await deadline());
    await expect(
      market.connect(sys.alice).sell(Outcome.Yes, 11n * E18, 0, await deadline()),
    ).to.be.revertedWithCustomError(market, "InsufficientShares");
    await expect(
      market.connect(sys.bob).sell(Outcome.Yes, 5n * E18, 0, await deadline()),
    ).to.be.revertedWithCustomError(market, "InsufficientShares");
    const proceeds: bigint = await market.quoteSell(Outcome.Yes, 5n * E18);
    await expect(
      market.connect(sys.alice).sell(Outcome.Yes, 5n * E18, proceeds + 1n, await deadline()),
    ).to.be.revertedWithCustomError(market, "SlippageExceeded");
  });

  it("repeated tiny round trips never profit from rounding", async () => {
    const { sys, market } = await setup(10n * E18);
    const start: bigint = await sys.token.balanceOf(sys.alice.address);
    for (let i = 0; i < 15; i++) {
      const s = 1_000_000_000_000n + BigInt(i); // dust-sized, 1e12 + i wei
      await market.connect(sys.alice).buy(Outcome.Yes, s, 10n * E18, await deadline());
      await market.connect(sys.alice).sell(Outcome.Yes, s, 0, await deadline());
    }
    expect((await sys.token.balanceOf(sys.alice.address)) < start).to.equal(true);
  });

  it("matches the independent reference over random buy/sell sequences and stays solvent", async () => {
    for (const seq of vectors.sequences) {
      const sys = await deploySystem();
      const b = BigInt(seq.b);
      const { market } = await createMarket(sys, b, `seq-${seq.seed}`);
      const users = [sys.alice, sys.bob, sys.carol, sys.dave];
      for (const u of users) await fund(sys, u, 400_000n * E18);

      let minHeadroom: bigint | null = null;
      for (const op of seq.ops) {
        const u = market.connect(users[op.user]);
        const shares = BigInt(op.shares);
        if (op.action === "buy") await u.buy(op.outcome, shares, 10n ** 30n, await deadline());
        else await u.sell(op.outcome, shares, 0, await deadline());

        const qY: bigint = await market.qYes();
        const qN: bigint = await market.qNo();
        expect(qY).to.equal(BigInt(op.qYesAfter));
        expect(qN).to.equal(BigInt(op.qNoAfter));

        const collateral: bigint = await market.collateral();
        const trueCost = BigInt(op.trueCostCeilAfter);
        // Solvency: contract collateral >= true LMSR cost >= max(qY, qN)
        expect(collateral >= trueCost, `step ${op.action}: collateral ${collateral} < true C ${trueCost}`).to.equal(true);
        expect(trueCost >= (qY > qN ? qY : qN)).to.equal(true);
        expect(await sys.token.balanceOf(await market.getAddress())).to.equal(collateral);
        const headroom = collateral - trueCost;
        if (minHeadroom === null || headroom < minHeadroom) minHeadroom = headroom;
      }
      console.log(`      seed ${seq.seed} (b=${b / E18}): ${seq.ops.length} ops OK; min collateral headroom = ${minHeadroom} wei`);
    }
  });

  it("closeMarket is permissionless, only after close, and emits MarketClosed once", async () => {
    const { sys, market, tradingClose } = await setup();
    await expect(market.closeMarket()).to.be.revertedWithCustomError(market, "TradingNotClosed");
    await networkHelpers.time.increaseTo(tradingClose);
    await expect(market.connect(sys.outsider).closeMarket()).to.emit(market, "MarketClosed");
    expect(await market.closedEmitted()).to.equal(true);
  });
});
