import { expect } from "chai";
import { ethers, networkHelpers, deploySystem, createMarket, fund, deadline, E18, Outcome, Status, Verdict, DAY, HOUR } from "./helpers.js";

const EV = ethers.id("evidence-A");
const EV_DISPUTE = ethers.id("counter-evidence-B");
const RATIONALE = ethers.id("arbiter-rationale");
const URI = "https://example.invalid/e.json"; // test fixture
const BOND = 100n * E18;
const ProposalState = { None: 0n, Proposed: 1n, Finalized: 2n, Cancelled: 3n, Disputed: 4n } as const;

async function setup(opts: { challengeWindow?: number; bondedWindow?: number } = {}) {
  const sys = await deploySystem(opts.challengeWindow ?? 0, opts.bondedWindow ?? HOUR, BOND);
  const m = await createMarket(sys, 100n * E18);
  const market = m.market;
  // proposer = dave, disputer = carol; both funded for bonds. Traders hold positions so settlement is real.
  for (const u of [sys.alice, sys.bob, sys.carol, sys.dave, sys.outsider]) await fund(sys, u, 1_000n * E18);
  await market.connect(sys.alice).buy(Outcome.Yes, 30n * E18, 1000n * E18, await deadline());
  await market.connect(sys.bob).buy(Outcome.No, 20n * E18, 1000n * E18, await deadline());
  await networkHelpers.time.increaseTo(m.tradingClose);
  return { sys, market, addr: await market.getAddress(), ...m, proposer: sys.dave, disputer: sys.carol };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const propose = (c: Ctx, v: number = Verdict.Yes, who = c.proposer) => c.sys.rm.connect(who).proposeBonded(c.addr, v, EV, URI);
const dispute = (c: Ctx, who = c.disputer) => c.sys.rm.connect(who).dispute(c.addr, EV_DISPUTE, URI);
const arbitrate = (c: Ctx, v: number, who = c.sys.arbiter) => c.sys.rm.connect(who).arbitrate(c.addr, v, RATIONALE);
const bal = (c: Ctx, who: { address: string }): Promise<bigint> => c.sys.token.balanceOf(who.address);
const state = async (c: Ctx) => (await c.sys.rm.proposals(c.addr)).state;

/** The invariant behind every test: escrow accounting equals the real token balance. */
async function escrowOk(c: Ctx) {
  const rmAddr = await c.sys.rm.getAddress();
  expect(await c.sys.token.balanceOf(rmAddr)).to.equal(await c.sys.rm.totalLockedBonds());
}

describe("ResolutionManager: bonded proposals (Stage 3)", () => {
  it("anyone can propose by escrowing the bond, with no approval step", async () => {
    const c = await setup();
    const before = await bal(c, c.proposer);
    const tx = await propose(c);
    await expect(tx).to.emit(c.sys.rm, "ResolutionProposed").withArgs(c.addr, Verdict.Yes, EV, URI, c.proposer.address, (d: bigint) => d > 0n, BOND);
    expect(before - (await bal(c, c.proposer))).to.equal(BOND);
    const p = await c.sys.rm.proposals(c.addr);
    expect(p.bond).to.equal(BOND);
    expect(p.disputeBond).to.equal(BOND);
    expect(p.challengeDeadline - p.proposedAt).to.equal(BigInt(HOUR));
    expect(await c.sys.rm.totalLockedBonds()).to.equal(BOND);
    await escrowOk(c);
    console.log(`      gas: proposeBonded = ${(await tx.wait())!.gasUsed}`);
  });

  it("is refused for the creator, unknown markets, empty evidence, open markets, duplicates and empty wallets", async () => {
    const c = await setup();
    await expect(propose(c, Verdict.Yes, c.sys.creator)).to.be.revertedWithCustomError(c.sys.rm, "CreatorCannotResolve");
    await expect(c.sys.rm.connect(c.proposer).proposeBonded(c.sys.alice.address, Verdict.Yes, EV, URI)).to.be.revertedWithCustomError(c.sys.rm, "UnknownMarket");
    await expect(c.sys.rm.connect(c.proposer).proposeBonded(c.addr, Verdict.Yes, ethers.ZeroHash, URI)).to.be.revertedWithCustomError(c.sys.rm, "EmptyEvidence");
    const nobody = c.sys.admin; // has no tokens
    await expect(propose(c, Verdict.Yes, nobody)).to.be.revertedWithCustomError(c.sys.token, "ERC20InsufficientBalance");
    await propose(c);
    await expect(propose(c, Verdict.No, c.sys.outsider)).to.be.revertedWithCustomError(c.sys.rm, "ProposalExists");

    const open = await createMarket(c.sys, 100n * E18, "still-open");
    await expect(c.sys.rm.connect(c.proposer).proposeBonded(await open.market.getAddress(), Verdict.Yes, EV, URI)).to.be.revertedWithCustomError(c.sys.rm, "MarketNotResolvable");
  });

  it("an undisputed proposal finalizes after the window, permissionlessly, and the bond comes back", async () => {
    const c = await setup();
    const start = await bal(c, c.proposer);
    await propose(c);
    await expect(c.sys.rm.connect(c.sys.outsider).finalize(c.addr)).to.be.revertedWithCustomError(c.sys.rm, "ChallengeWindowActive");
    await networkHelpers.time.increase(HOUR);
    const tx = await c.sys.rm.connect(c.sys.outsider).finalize(c.addr);
    await expect(tx).to.emit(c.sys.rm, "ResolutionFinalized");
    console.log(`      gas: finalize (bonded, undisputed) = ${(await tx.wait())!.gasUsed}`);
    expect(await c.market.status()).to.equal(Status.Resolved);
    expect(await c.market.winningOutcome()).to.equal(BigInt(Outcome.Yes));
    expect(await bal(c, c.proposer)).to.equal(start); // bond returned in full
    expect(await c.sys.rm.totalLockedBonds()).to.equal(0n);
    await escrowOk(c);
  });

  it("the admin can withdraw a mistaken undisputed proposal and the bond is refunded", async () => {
    const c = await setup();
    const start = await bal(c, c.proposer);
    await propose(c);
    await c.sys.rm.cancelProposal(c.addr);
    expect(await bal(c, c.proposer)).to.equal(start);
    expect(await state(c)).to.equal(ProposalState.Cancelled);
    await escrowOk(c);
    await propose(c, Verdict.No, c.sys.outsider); // a fresh proposal is possible afterwards
  });
});

describe("ResolutionManager: disputes", () => {
  it("anyone but the proposer can dispute inside the window by posting a matching bond", async () => {
    const c = await setup();
    await propose(c);
    await expect(dispute(c, c.proposer)).to.be.revertedWithCustomError(c.sys.rm, "CannotDisputeOwnProposal");
    await expect(c.sys.rm.connect(c.disputer).dispute(c.addr, ethers.ZeroHash, URI)).to.be.revertedWithCustomError(c.sys.rm, "EmptyEvidence");

    const before = await bal(c, c.disputer);
    const tx = await dispute(c);
    await expect(tx).to.emit(c.sys.rm, "ResolutionDisputed").withArgs(c.addr, c.disputer.address, EV_DISPUTE, URI, BOND);
    console.log(`      gas: dispute = ${(await tx.wait())!.gasUsed}`);
    expect(before - (await bal(c, c.disputer))).to.equal(BOND);
    expect(await state(c)).to.equal(ProposalState.Disputed);
    expect(await c.sys.rm.totalLockedBonds()).to.equal(2n * BOND);
    await escrowOk(c);
    await expect(dispute(c, c.sys.outsider)).to.be.revertedWithCustomError(c.sys.rm, "NoPendingProposal"); // one dispute per proposal
  });

  it("cannot be disputed once the window has ended, and a disputed proposal cannot be finalized or cancelled", async () => {
    const c = await setup();
    await propose(c);
    await networkHelpers.time.increase(HOUR);
    await expect(dispute(c)).to.be.revertedWithCustomError(c.sys.rm, "ChallengeWindowOver");

    const d = await setup();
    await propose(d);
    await dispute(d);
    await networkHelpers.time.increase(HOUR);
    await expect(d.sys.rm.finalize(d.addr)).to.be.revertedWithCustomError(d.sys.rm, "DisputedProposalNeedsArbiter");
    await expect(d.sys.rm.cancelProposal(d.addr)).to.be.revertedWithCustomError(d.sys.rm, "DisputedProposalNeedsArbiter");
  });

  it("an unbonded resolver proposal can be disputed too, but only while its window is open", async () => {
    const open = await setup({ challengeWindow: HOUR });
    await open.sys.rm.connect(open.sys.resolver).propose(open.addr, Verdict.Yes, EV, URI);
    await dispute(open);
    expect(await state(open)).to.equal(ProposalState.Disputed);

    const devMode = await setup({ challengeWindow: 0 }); // Stage 1 dev mode: no window, no disputes
    await devMode.sys.rm.connect(devMode.sys.resolver).propose(devMode.addr, Verdict.Yes, EV, URI);
    await expect(dispute(devMode)).to.be.revertedWithCustomError(devMode.sys.rm, "ChallengeWindowOver");
  });

  it("the dispute bond is the amount snapshotted at proposal time, even if the admin changes parameters", async () => {
    const c = await setup();
    await propose(c);
    await c.sys.rm.setBondParameters(HOUR, 500n * E18);
    const before = await bal(c, c.disputer);
    await dispute(c);
    expect(before - (await bal(c, c.disputer))).to.equal(BOND);
  });
});

describe("ResolutionManager: arbitration and bond settlement", () => {
  it("upholding the proposal: the proposer wins the disputer's bond and the market resolves", async () => {
    const c = await setup();
    const p0 = await bal(c, c.proposer), d0 = await bal(c, c.disputer);
    await propose(c, Verdict.Yes);
    await dispute(c);
    const tx = await arbitrate(c, Verdict.Yes);
    await expect(tx).to.emit(c.sys.rm, "DisputeResolved").withArgs(c.addr, c.sys.arbiter.address, Verdict.Yes, RATIONALE, true);
    console.log(`      gas: arbitrate = ${(await tx.wait())!.gasUsed}`);
    expect(await bal(c, c.proposer)).to.equal(p0 + BOND);
    expect(await bal(c, c.disputer)).to.equal(d0 - BOND);
    expect(await c.market.status()).to.equal(Status.Resolved);
    expect(await c.market.winningOutcome()).to.equal(BigInt(Outcome.Yes));
    expect(await state(c)).to.equal(ProposalState.Finalized);
    expect(await c.sys.rm.totalLockedBonds()).to.equal(0n);
    await escrowOk(c);
  });

  it("overturning it: the disputer wins the proposer's bond and the arbiter's verdict is applied", async () => {
    const c = await setup();
    const p0 = await bal(c, c.proposer), d0 = await bal(c, c.disputer);
    await propose(c, Verdict.Yes);
    await dispute(c);
    await arbitrate(c, Verdict.No);
    expect(await bal(c, c.proposer)).to.equal(p0 - BOND);
    expect(await bal(c, c.disputer)).to.equal(d0 + BOND);
    expect(await c.market.winningOutcome()).to.equal(BigInt(Outcome.No));
    // the NO holder can now redeem; the YES holder cannot
    await c.market.connect(c.sys.bob).redeem();
    await expect(c.market.connect(c.sys.alice).redeem()).to.be.revertedWithCustomError(c.market, "NothingToRedeem");
    await escrowOk(c);
  });

  it("the arbiter may void the market (INVALID), which overturns a YES/NO proposal", async () => {
    const c = await setup();
    await propose(c, Verdict.Yes);
    await dispute(c);
    await arbitrate(c, Verdict.Invalid);
    expect(await c.market.status()).to.equal(Status.Invalid);
    await c.market.connect(c.sys.alice).refund(); // refunds work after an arbiter void
  });

  it("an unbonded resolver proposal: upheld wins the disputer's bond, overturned returns it", async () => {
    const up = await setup({ challengeWindow: HOUR });
    const r0 = await bal(up, up.sys.resolver), d0 = await bal(up, up.disputer);
    await up.sys.rm.connect(up.sys.resolver).propose(up.addr, Verdict.Yes, EV, URI);
    await dispute(up);
    await arbitrate(up, Verdict.Yes);
    expect(await bal(up, up.sys.resolver)).to.equal(r0 + BOND); // documented: loser's bond to the winner
    expect(await bal(up, up.disputer)).to.equal(d0 - BOND);

    const over = await setup({ challengeWindow: HOUR });
    const d1 = await bal(over, over.disputer);
    await over.sys.rm.connect(over.sys.resolver).propose(over.addr, Verdict.Yes, EV, URI);
    await dispute(over);
    await arbitrate(over, Verdict.No);
    expect(await bal(over, over.disputer)).to.equal(d1); // only their own bond back
    await escrowOk(over);
  });

  it("only an ARBITER_ROLE account, only on a disputed proposal, only with a rationale", async () => {
    const c = await setup();
    await propose(c);
    await expect(arbitrate(c, Verdict.Yes)).to.be.revertedWithCustomError(c.sys.rm, "NotDisputed");
    await dispute(c);
    await expect(arbitrate(c, Verdict.Yes, c.sys.outsider)).to.be.revertedWithCustomError(c.sys.rm, "AccessControlUnauthorizedAccount");
    await expect(c.sys.rm.connect(c.sys.resolver).arbitrate(c.addr, Verdict.Yes, RATIONALE)).to.be.revertedWithCustomError(c.sys.rm, "AccessControlUnauthorizedAccount");
    await expect(c.sys.rm.connect(c.sys.arbiter).arbitrate(c.addr, Verdict.Yes, ethers.ZeroHash)).to.be.revertedWithCustomError(c.sys.rm, "EmptyEvidence");
  });

  it("an arbiter cannot rule on their own proposal, their own dispute, or a market they created", async () => {
    const roleFor = async (c: Ctx, who: { address: string }) => c.sys.rm.grantRole(await c.sys.rm.ARBITER_ROLE(), who.address);

    const a = await setup();
    await roleFor(a, a.proposer);
    await propose(a); await dispute(a);
    await expect(arbitrate(a, Verdict.Yes, a.proposer)).to.be.revertedWithCustomError(a.sys.rm, "ArbiterConflict");

    const b = await setup();
    await roleFor(b, b.disputer);
    await propose(b); await dispute(b);
    await expect(arbitrate(b, Verdict.Yes, b.disputer)).to.be.revertedWithCustomError(b.sys.rm, "ArbiterConflict");

    const d = await setup();
    await roleFor(d, d.sys.creator);
    await propose(d); await dispute(d);
    await expect(arbitrate(d, Verdict.Yes, d.sys.creator)).to.be.revertedWithCustomError(d.sys.rm, "ArbiterConflict");
  });

  it("a decided proposal cannot be re-proposed, re-arbitrated or released", async () => {
    const c = await setup();
    await propose(c); await dispute(c); await arbitrate(c, Verdict.Yes);
    await expect(propose(c, Verdict.No, c.sys.outsider)).to.be.revertedWithCustomError(c.sys.rm, "MarketNotResolvable"); // already resolved
    await expect(arbitrate(c, Verdict.No)).to.be.revertedWithCustomError(c.sys.rm, "NotDisputed");
    await expect(c.sys.rm.releaseBonds(c.addr)).to.be.revertedWithCustomError(c.sys.rm, "NothingToRelease");
  });
});

describe("ResolutionManager: liveness (nobody can lock funds forever)", () => {
  it("a dispute the arbiter never decides can be unwound after the timeout, returning each party's own bond", async () => {
    const c = await setup();
    const p0 = await bal(c, c.proposer), d0 = await bal(c, c.disputer);
    await propose(c); await dispute(c);
    await expect(c.sys.rm.releaseBonds(c.addr)).to.be.revertedWithCustomError(c.sys.rm, "NothingToRelease");
    await networkHelpers.time.increase(14 * DAY);
    const tx = await c.sys.rm.connect(c.sys.outsider).releaseBonds(c.addr);
    await expect(tx).to.emit(c.sys.rm, "BondsReleased").withArgs(c.addr, BOND, BOND);
    expect(await bal(c, c.proposer)).to.equal(p0);
    expect(await bal(c, c.disputer)).to.equal(d0);
    expect(await state(c)).to.equal(ProposalState.Cancelled);
    await escrowOk(c);
    // the market is still unresolved, so someone can propose again, or it voids at its deadline
    await propose(c, Verdict.No, c.sys.outsider);
  });

  it("bonds are returned if the market was settled some other way (voided at its deadline)", async () => {
    const c = await setup();
    const p0 = await bal(c, c.proposer);
    await propose(c);
    await networkHelpers.time.increaseTo(c.resolutionDeadline);
    await networkHelpers.time.increase(7 * DAY);
    await c.market.invalidateExpired(); // anyone may void a market nobody resolved in time
    await expect(c.sys.rm.finalize(c.addr)).to.be.revertedWithCustomError(c.market, "MarketNotActive"); // cannot resolve a voided market
    await c.sys.rm.releaseBonds(c.addr);
    expect(await bal(c, c.proposer)).to.equal(p0);
    await escrowOk(c);
  });

  it("nothing can be released while a proposal is still live and the market is active", async () => {
    const c = await setup();
    await propose(c);
    await expect(c.sys.rm.releaseBonds(c.addr)).to.be.revertedWithCustomError(c.sys.rm, "NothingToRelease");
  });
});

describe("ResolutionManager: parameters and token wiring", () => {
  it("validates bond parameters and keeps them admin-only", async () => {
    const sys = await deploySystem();
    const tokenAddr = await sys.token.getAddress();
    const deploy = (w: number, bw: number, b: bigint) => ethers.deployContract("ResolutionManager", [sys.admin.address, tokenAddr, w, bw, b]);
    await expect(deploy(8 * DAY, HOUR, BOND)).to.be.revertedWithCustomError(sys.rm, "WindowTooLong");
    await expect(deploy(0, 0, BOND)).to.be.revertedWithCustomError(sys.rm, "InvalidBondedWindow");
    await expect(deploy(0, 8 * DAY, BOND)).to.be.revertedWithCustomError(sys.rm, "InvalidBondedWindow");
    await expect(deploy(0, HOUR, E18 - 1n)).to.be.revertedWithCustomError(sys.rm, "InvalidBond");
    await expect(deploy(0, HOUR, 10_001n * E18)).to.be.revertedWithCustomError(sys.rm, "InvalidBond");

    await expect(sys.rm.connect(sys.alice).setBondParameters(HOUR, BOND)).to.be.revertedWithCustomError(sys.rm, "AccessControlUnauthorizedAccount");
    await sys.rm.setBondParameters(2 * HOUR, 250n * E18);
    expect(await sys.rm.bondAmount()).to.equal(250n * E18);
    expect(await sys.rm.bondedChallengeWindow()).to.equal(BigInt(2 * HOUR));
  });

  it("the token's ResolutionManager can be set once; bonds still cannot move between people", async () => {
    const sys = await deploySystem();
    await expect(sys.token.setResolutionManager(sys.alice.address)).to.be.revertedWithCustomError(sys.token, "ResolutionManagerAlreadySet");
    await sys.token.connect(sys.alice).faucet();
    await expect(sys.token.connect(sys.alice).transfer(sys.bob.address, E18)).to.be.revertedWithCustomError(sys.token, "TransferRestricted");
  });
});

describe("ResolutionManager: bond conservation over random paths", () => {
  it("escrow always equals the contract's balance, and total tokens are conserved, whatever happens", async () => {
    // Seeded so a failure is reproducible. Each round picks a path through the state machine.
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let round = 0; round < 12; round++) {
      const c = await setup();
      const everyone = [c.proposer, c.disputer, c.sys.arbiter, c.sys.admin, c.sys.alice, c.sys.bob, c.sys.creator, c.sys.resolver, c.sys.outsider];
      const supplyBefore = await c.sys.token.totalSupply();
      const path = rnd(6);
      await propose(c, rnd(3));
      if (path >= 1) await dispute(c);
      if (path === 1) await arbitrate(c, rnd(3));
      if (path === 2) { await networkHelpers.time.increase(14 * DAY); await c.sys.rm.releaseBonds(c.addr); }
      if (path === 3) { await networkHelpers.time.increase(HOUR); await c.sys.rm.finalize(c.addr).catch(() => undefined); }
      if (path === 4) await c.sys.rm.cancelProposal(c.addr).catch(() => undefined);
      if (path === 0) { await networkHelpers.time.increase(HOUR); await c.sys.rm.finalize(c.addr); }
      await escrowOk(c);
      expect(await c.sys.token.totalSupply()).to.equal(supplyBefore); // bonds only move, never appear or vanish
      if (path === 0 || path === 1) expect(await c.sys.rm.totalLockedBonds()).to.equal(0n);
      void everyone;
    }
  });
});
