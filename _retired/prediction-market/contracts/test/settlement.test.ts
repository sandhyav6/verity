import { expect } from "chai";
import {
  ethers,
  networkHelpers,
  deploySystem,
  createMarket,
  fund,
  deadline,
  E18,
  Outcome,
  Status,
  Verdict,
  DAY,
} from "./helpers.js";

const EVIDENCE = ethers.id("evidence-bundle-v1");
const URI = "https://example.invalid/evidence/1.json"; // test fixture, not a real source

async function setup(challengeWindow = 0) {
  const sys = await deploySystem(challengeWindow);
  const m = await createMarket(sys, 100n * E18);
  for (const u of [sys.alice, sys.bob, sys.carol]) await fund(sys, u, 5_000n * E18);
  return { sys, ...m };
}

async function resolveAs(sys: any, market: any, verdict: number) {
  await sys.rm.connect(sys.resolver).propose(await market.getAddress(), verdict, EVIDENCE, URI);
  return sys.rm.finalize(await market.getAddress());
}

describe("ResolutionManager (Stage 1: admin + evidence)", () => {
  it("rejects proposals before trading closes, from outsiders, for unknown markets, without evidence", async () => {
    const { sys, market, tradingClose } = await setup();
    const addr = await market.getAddress();
    await expect(
      sys.rm.connect(sys.resolver).propose(addr, Verdict.Yes, EVIDENCE, URI),
    ).to.be.revertedWithCustomError(sys.rm, "MarketNotResolvable");

    await networkHelpers.time.increaseTo(tradingClose);
    await expect(sys.rm.connect(sys.outsider).propose(addr, Verdict.Yes, EVIDENCE, URI)).to.be.revertedWithCustomError(
      sys.rm,
      "AccessControlUnauthorizedAccount",
    );
    await expect(
      sys.rm.connect(sys.resolver).propose(sys.alice.address, Verdict.Yes, EVIDENCE, URI),
    ).to.be.revertedWithCustomError(sys.rm, "UnknownMarket");
    await expect(
      sys.rm.connect(sys.resolver).propose(addr, Verdict.Yes, ethers.ZeroHash, URI),
    ).to.be.revertedWithCustomError(sys.rm, "EmptyEvidence");
  });

  it("the market creator cannot resolve their own market even with the resolver role", async () => {
    const { sys, market, tradingClose } = await setup();
    await sys.rm.grantRole(await sys.rm.RESOLVER_ROLE(), sys.creator.address);
    await networkHelpers.time.increaseTo(tradingClose);
    await expect(
      sys.rm.connect(sys.creator).propose(await market.getAddress(), Verdict.Yes, EVIDENCE, URI),
    ).to.be.revertedWithCustomError(sys.rm, "CreatorCannotResolve");
  });

  it("nobody but the ResolutionManager can resolve or invalidate a market directly", async () => {
    const { sys, market, tradingClose } = await setup();
    await networkHelpers.time.increaseTo(tradingClose);
    for (const s of [sys.admin, sys.creator, sys.resolver, sys.outsider]) {
      await expect(market.connect(s).resolve(Outcome.Yes)).to.be.revertedWithCustomError(market, "NotResolutionManager");
      await expect(market.connect(s).invalidate()).to.be.revertedWithCustomError(market, "NotResolutionManager");
    }
  });

  it("stores the proposal with its evidence hash and emits the URI", async () => {
    const { sys, market, tradingClose } = await setup();
    await networkHelpers.time.increaseTo(tradingClose);
    const addr = await market.getAddress();
    await expect(sys.rm.connect(sys.resolver).propose(addr, Verdict.No, EVIDENCE, URI))
      .to.emit(sys.rm, "ResolutionProposed")
      .withArgs(addr, Verdict.No, EVIDENCE, URI, sys.resolver.address, (v: bigint) => v > 0n, 0n);
    const p = await sys.rm.proposals(addr);
    expect(p.evidenceHash).to.equal(EVIDENCE);
    expect(p.proposer).to.equal(sys.resolver.address);
    await expect(
      sys.rm.connect(sys.resolver).propose(addr, Verdict.Yes, EVIDENCE, URI),
    ).to.be.revertedWithCustomError(sys.rm, "ProposalExists");
  });

  it("respects the challenge window; admin can cancel and the resolver can re-propose", async () => {
    const { sys, market, tradingClose } = await setup(3600);
    await networkHelpers.time.increaseTo(tradingClose);
    const addr = await market.getAddress();
    await sys.rm.connect(sys.resolver).propose(addr, Verdict.Yes, EVIDENCE, URI);
    await expect(sys.rm.finalize(addr)).to.be.revertedWithCustomError(sys.rm, "ChallengeWindowActive");

    await expect(sys.rm.connect(sys.resolver).cancelProposal(addr)).to.be.revertedWithCustomError(
      sys.rm,
      "AccessControlUnauthorizedAccount",
    );
    await sys.rm.cancelProposal(addr);
    await expect(sys.rm.finalize(addr)).to.be.revertedWithCustomError(sys.rm, "NoPendingProposal");

    await sys.rm.connect(sys.resolver).propose(addr, Verdict.No, EVIDENCE, URI);
    await networkHelpers.time.increase(3600);
    await sys.rm.connect(sys.outsider).finalize(addr); // permissionless after the window
    expect(await market.status()).to.equal(Status.Resolved);
    expect(await market.winningOutcome()).to.equal(BigInt(Outcome.No));
    await expect(sys.rm.finalize(addr)).to.be.revertedWithCustomError(sys.rm, "NoPendingProposal");
  });

  it("challenge window is bounded and admin-only", async () => {
    const { sys } = await setup();
    await expect(sys.rm.setChallengeWindow(8 * DAY)).to.be.revertedWithCustomError(sys.rm, "WindowTooLong");
    await expect(sys.rm.connect(sys.alice).setChallengeWindow(1)).to.be.revertedWithCustomError(
      sys.rm,
      "AccessControlUnauthorizedAccount",
    );
    await sys.rm.setChallengeWindow(DAY);
    expect(await sys.rm.challengeWindow()).to.equal(BigInt(DAY));
  });
});

describe("Settlement: redeem, residual, double-spend protection", () => {
  async function tradedAndResolvedYes() {
    const ctx = await setup();
    const { sys, market, tradingClose } = ctx;
    await market.connect(sys.alice).buy(Outcome.Yes, 60n * E18, 1000n * E18, await deadline());
    await market.connect(sys.bob).buy(Outcome.No, 40n * E18, 1000n * E18, await deadline());
    await market.connect(sys.carol).buy(Outcome.Yes, 20n * E18, 1000n * E18, await deadline());
    await networkHelpers.time.increaseTo(tradingClose);
    const tx = await resolveAs(sys, market, Verdict.Yes);
    return { ...ctx, resolveTx: tx };
  }

  it("winners redeem 1 token per share; losers cannot; no double redemption", async () => {
    const { sys, market, resolveTx } = await tradedAndResolvedYes();
    console.log(`      gas: finalize/resolve = ${(await resolveTx.wait())!.gasUsed}`);
    expect(await market.status()).to.equal(Status.Resolved);

    const before: bigint = await sys.token.balanceOf(sys.alice.address);
    const tx = await market.connect(sys.alice).redeem();
    await expect(tx).to.emit(market, "SharesRedeemed").withArgs(sys.alice.address, 60n * E18, 60n * E18);
    console.log(`      gas: redeem = ${(await tx.wait())!.gasUsed}`);
    expect((await sys.token.balanceOf(sys.alice.address)) - before).to.equal(60n * E18);

    await expect(market.connect(sys.alice).redeem()).to.be.revertedWithCustomError(market, "NothingToRedeem");
    await expect(market.connect(sys.bob).redeem()).to.be.revertedWithCustomError(market, "NothingToRedeem"); // holds only NO
    await expect(market.connect(sys.outsider).redeem()).to.be.revertedWithCustomError(market, "NothingToRedeem");
    await expect(market.connect(sys.alice).refund()).to.be.revertedWithCustomError(market, "WrongStatus");
  });

  it("collateral exactly covers winners and the creator recovers the rest, once", async () => {
    const { sys, market } = await tradedAndResolvedYes();
    const collateral: bigint = await market.collateral();
    const winning: bigint = await market.qYes(); // 80 shares
    const residual: bigint = await market.residual();
    expect(residual).to.equal(collateral - winning);
    expect(collateral >= winning).to.equal(true); // solvency

    await expect(market.connect(sys.alice).claimResidual()).to.be.revertedWithCustomError(market, "NotCreator");
    const before: bigint = await sys.token.balanceOf(sys.creator.address);
    await market.connect(sys.creator).claimResidual();
    expect((await sys.token.balanceOf(sys.creator.address)) - before).to.equal(residual);
    await expect(market.connect(sys.creator).claimResidual()).to.be.revertedWithCustomError(
      market,
      "ResidualAlreadyClaimed",
    );

    // After the creator withdraws, the market still holds exactly the winners' payout.
    expect(await sys.token.balanceOf(await market.getAddress())).to.equal(winning);
    await market.connect(sys.alice).redeem();
    await market.connect(sys.carol).redeem();
    expect(await sys.token.balanceOf(await market.getAddress())).to.equal(0n);
    expect(await market.collateral()).to.equal(0n);
  });

  it("regression: residual is correct when the creator claims AFTER winners redeemed", async () => {
    const { sys, market } = await tradedAndResolvedYes();
    const expected: bigint = (await market.collateral()) - (await market.qYes());
    await market.connect(sys.alice).redeem();
    await market.connect(sys.carol).redeem();
    expect(await market.residual()).to.equal(expected);
    const before: bigint = await sys.token.balanceOf(sys.creator.address);
    await market.connect(sys.creator).claimResidual();
    expect((await sys.token.balanceOf(sys.creator.address)) - before).to.equal(expected);
    expect(await sys.token.balanceOf(await market.getAddress())).to.equal(0n);
  });

  it("the creator cannot claim residual before settlement; trading and redeeming are blocked early", async () => {
    const { sys, market } = await setup();
    await expect(market.connect(sys.creator).claimResidual()).to.be.revertedWithCustomError(market, "WrongStatus");
    await market.connect(sys.alice).buy(Outcome.Yes, 5n * E18, 100n * E18, await deadline());
    await expect(market.connect(sys.alice).redeem()).to.be.revertedWithCustomError(market, "WrongStatus");
  });

  it("no trading once resolved", async () => {
    const { sys, market } = await tradedAndResolvedYes();
    await expect(
      market.connect(sys.alice).buy(Outcome.Yes, E18, 100n * E18, await deadline()),
    ).to.be.revertedWithCustomError(market, "MarketNotActive");
  });

  it("NO resolution pays NO holders only", async () => {
    const { sys, market, tradingClose } = await setup();
    await market.connect(sys.alice).buy(Outcome.Yes, 30n * E18, 1000n * E18, await deadline());
    await market.connect(sys.bob).buy(Outcome.No, 30n * E18, 1000n * E18, await deadline());
    await networkHelpers.time.increaseTo(tradingClose);
    await resolveAs(sys, market, Verdict.No);
    await expect(market.connect(sys.alice).redeem()).to.be.revertedWithCustomError(market, "NothingToRedeem");
    await market.connect(sys.bob).redeem();
  });
});

describe("Invalid markets: refund by net cost basis", () => {
  it("refunds positive cost basis, pays nothing to profitable sellers, creator recovers the rest", async () => {
    const { sys, market, tradingClose } = await setup();
    // Alice buys, Bob pushes the price, Alice sells at a profit -> Alice's basis is negative.
    await market.connect(sys.alice).buy(Outcome.Yes, 50n * E18, 1000n * E18, await deadline());
    await market.connect(sys.bob).buy(Outcome.Yes, 50n * E18, 1000n * E18, await deadline());
    await market.connect(sys.alice).sell(Outcome.Yes, 50n * E18, 0, await deadline());
    await market.connect(sys.carol).buy(Outcome.No, 10n * E18, 1000n * E18, await deadline());
    expect((await market.costBasis(sys.alice.address)) < 0n).to.equal(true);

    await networkHelpers.time.increaseTo(tradingClose);
    await resolveAs(sys, market, Verdict.Invalid);
    expect(await market.status()).to.equal(Status.Invalid);
    expect(await market.refundScale()).to.equal(E18); // fully covered here

    const bobBasis: bigint = await market.costBasis(sys.bob.address);
    const carolBasis: bigint = await market.costBasis(sys.carol.address);
    const b0: bigint = await sys.token.balanceOf(sys.bob.address);
    await market.connect(sys.bob).refund();
    expect((await sys.token.balanceOf(sys.bob.address)) - b0).to.equal(bobBasis);
    await market.connect(sys.carol).refund();
    await expect(market.connect(sys.bob).refund()).to.be.revertedWithCustomError(market, "NothingToRedeem");
    await expect(market.connect(sys.alice).refund()).to.be.revertedWithCustomError(market, "NothingToRedeem");
    await expect(market.connect(sys.bob).redeem()).to.be.revertedWithCustomError(market, "WrongStatus");

    // Everything refunded; creator gets the remainder; the market ends empty (to the wei).
    await market.connect(sys.creator).claimResidual();
    expect(await sys.token.balanceOf(await market.getAddress())).to.equal(await market.collateral());
    expect((await market.collateral()) < 10n ** 6n).to.equal(true);
    expect(bobBasis > 0n && carolBasis > 0n).to.equal(true);
  });

  it("anyone can void a market nobody resolved, but only after deadline + grace", async () => {
    const { sys, market, resolutionDeadline } = await setup();
    await market.connect(sys.alice).buy(Outcome.Yes, 10n * E18, 100n * E18, await deadline());
    await networkHelpers.time.increaseTo(resolutionDeadline);
    await expect(market.connect(sys.outsider).invalidateExpired()).to.be.revertedWithCustomError(market, "NotYetExpired");
    await networkHelpers.time.increase(7 * DAY);
    await market.connect(sys.outsider).invalidateExpired();
    expect(await market.status()).to.equal(Status.Invalid);
    await market.connect(sys.alice).refund();
    await expect(market.connect(sys.outsider).invalidateExpired()).to.be.revertedWithCustomError(market, "MarketNotActive");
  });
});
