import { expect } from "chai";
import { ethers, networkHelpers, deploySystem, createMarket, E18, DAY, HOUR } from "./helpers.js";

describe("TestToken", () => {
  it("faucet mints a fixed amount and enforces the per-address cooldown", async () => {
    const sys = await deploySystem();
    await sys.token.connect(sys.alice).faucet();
    expect(await sys.token.balanceOf(sys.alice.address)).to.equal(1000n * E18);
    await expect(sys.token.connect(sys.alice).faucet()).to.be.revertedWithCustomError(sys.token, "FaucetCooldown");
    await networkHelpers.time.increase(DAY);
    await sys.token.connect(sys.alice).faucet();
    expect(await sys.token.balanceOf(sys.alice.address)).to.equal(2000n * E18);
  });

  it("is clearly labelled as a test token", async () => {
    const sys = await deploySystem();
    expect(await sys.token.name()).to.contain("no monetary value");
  });

  it("blocks peer-to-peer transfers (restricted transfer)", async () => {
    const sys = await deploySystem();
    await sys.token.connect(sys.alice).faucet();
    await expect(sys.token.connect(sys.alice).transfer(sys.bob.address, E18)).to.be.revertedWithCustomError(
      sys.token,
      "TransferRestricted",
    );
    await sys.token.connect(sys.alice).approve(sys.bob.address, E18);
    await expect(
      sys.token.connect(sys.bob).transferFrom(sys.alice.address, sys.carol.address, E18),
    ).to.be.revertedWithCustomError(sys.token, "TransferRestricted");
  });

  it("enforces the supply cap and only the owner can mint", async () => {
    const sys = await deploySystem();
    const cap: bigint = await sys.token.MAX_SUPPLY();
    await expect(sys.token.adminMint(sys.alice.address, cap)).to.be.revertedWithCustomError(
      sys.token,
      "SupplyCapExceeded",
    );
    await expect(sys.token.connect(sys.alice).adminMint(sys.alice.address, 1n)).to.be.revertedWithCustomError(
      sys.token,
      "OwnableUnauthorizedAccount",
    );
  });

  it("renouncing minting disables adminMint but not the faucet", async () => {
    const sys = await deploySystem();
    await sys.token.renounceMinting();
    await expect(sys.token.adminMint(sys.alice.address, 1n)).to.be.revertedWithCustomError(
      sys.token,
      "MintingDisabled",
    );
    await sys.token.connect(sys.alice).faucet();
  });

  it("factory can be set once; only the factory can register markets", async () => {
    const sys = await deploySystem();
    await expect(sys.token.setFactory(sys.alice.address)).to.be.revertedWithCustomError(
      sys.token,
      "FactoryAlreadySet",
    );
    await expect(sys.token.connect(sys.alice).registerMarket(sys.alice.address)).to.be.revertedWithCustomError(
      sys.token,
      "NotFactory",
    );
  });
});

describe("MarketFactory", () => {
  const base = async (sys: any) => {
    const now = BigInt(await networkHelpers.time.latest());
    return {
      metadataHash: ethers.id("x"),
      category: 1,
      tradingClose: now + BigInt(2 * DAY),
      resolutionDeadline: now + BigInt(9 * DAY),
      liquidityB: 100n * E18,
    };
  };

  it("creates a funded market at 50/50 and emits MarketCreated", async () => {
    const sys = await deploySystem();
    const { market, id, receipt, metadataHash } = await createMarket(sys, 100n * E18);
    expect(id).to.equal(1n);
    expect(await sys.factory.isMarket(await market.getAddress())).to.equal(true);
    expect(await sys.factory.marketById(1)).to.equal(await market.getAddress());
    expect(await market.priceYes()).to.equal(E18 / 2n);
    expect(await market.metadataHash()).to.equal(metadataHash);
    const collateral: bigint = await market.collateral();
    expect(await sys.token.balanceOf(await market.getAddress())).to.equal(collateral);
    expect(collateral > 69n * E18 && collateral < 70n * E18).to.equal(true);
    console.log(`      gas: createMarket = ${receipt.gasUsed}`);
  });

  it("only CREATOR_ROLE can create markets", async () => {
    const sys = await deploySystem();
    const p = await base(sys);
    await expect(sys.factory.connect(sys.alice).createMarket(p)).to.be.revertedWithCustomError(
      sys.factory,
      "AccessControlUnauthorizedAccount",
    );
  });

  it("rejects invalid parameters", async () => {
    const sys = await deploySystem();
    const f = sys.factory.connect(sys.creator);
    const p = await base(sys);
    const bad = (over: object, err: string) =>
      expect(f.createMarket({ ...p, ...over })).to.be.revertedWithCustomError(sys.factory, err);

    await bad({ metadataHash: ethers.ZeroHash }, "InvalidMetadataHash");
    await bad({ category: 4 }, "InvalidCategory");
    await bad({ liquidityB: 9n * E18 }, "InvalidLiquidity");
    await bad({ liquidityB: 100_001n * E18 }, "InvalidLiquidity");
    await bad({ tradingClose: p.tradingClose - BigInt(2 * DAY) + BigInt(HOUR / 2) }, "InvalidTimes");
    await bad({ resolutionDeadline: p.tradingClose }, "InvalidTimes");
  });

  it("rejects duplicate metadata hashes", async () => {
    const sys = await deploySystem();
    await createMarket(sys, 100n * E18, "dup");
    await expect(createMarket(sys, 100n * E18, "dup")).to.be.revertedWithCustomError(sys.factory, "DuplicateMetadata");
  });

  it("fails if the creator cannot afford the subsidy", async () => {
    const sys = await deploySystem();
    const poor = sys.alice;
    await sys.factory.grantRole(await sys.factory.CREATOR_ROLE(), poor.address);
    const p = await base(sys);
    await expect(sys.factory.connect(poor).createMarket(p)).to.be.revertedWithCustomError(
      sys.token,
      "ERC20InsufficientBalance",
    );
  });

  it("neither the implementation nor a deployed clone can be re-initialized", async () => {
    const sys = await deploySystem();
    const { market } = await createMarket(sys);
    const args = [sys.token.target, sys.creator.address, sys.rm.target, ethers.id("y"), 1, 2, 100n * E18] as const;
    await expect(sys.implementation.initialize(...args)).to.be.revertedWithCustomError(
      sys.implementation,
      "InvalidInitialization",
    );
    await expect(market.initialize(...args)).to.be.revertedWithCustomError(market, "InvalidInitialization");
  });

  it("refuses zero addresses and zero liquidity at initialization (found by Slither)", async () => {
    const sys = await deploySystem();
    // Deploy a bare EIP-1167 clone ourselves so we can call initialize() directly with bad values.
    const impl = (await sys.implementation.getAddress()).slice(2).toLowerCase();
    const initcode = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" + impl + "5af43d82803e903d91602b57fd5bf3";
    const tx = await sys.admin.sendTransaction({ data: initcode });
    const clone = await ethers.getContractAt("PredictionMarket", (await tx.wait())!.contractAddress!);
    const good = [sys.token.target, sys.creator.address, sys.rm.target, ethers.id("z"), 1, 2, 100n * E18] as const;
    const bad = (i: number, v: unknown) => good.map((x, j) => (j === i ? v : x)) as unknown as typeof good;
    await expect(clone.initialize(...bad(0, ethers.ZeroAddress))).to.be.revertedWithCustomError(clone, "ZeroAddress");
    await expect(clone.initialize(...bad(1, ethers.ZeroAddress))).to.be.revertedWithCustomError(clone, "ZeroAddress");
    await expect(clone.initialize(...bad(2, ethers.ZeroAddress))).to.be.revertedWithCustomError(clone, "ZeroAddress");
    await expect(clone.initialize(...bad(6, 0n))).to.be.revertedWithCustomError(clone, "InvalidLiquidity");
  });
});
