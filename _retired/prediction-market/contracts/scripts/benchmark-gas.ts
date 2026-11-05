// Measures gas for every on-chain operation on the in-process Hardhat network and prints JSON.
//   npx hardhat run scripts/benchmark-gas.ts
// Numbers are exact receipts' gasUsed (not estimates). Repeated operations report min / median / max.
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();
const E18 = 10n ** 18n;
const [admin, creator, resolver, alice, bob, carol, dave, , arbiter] = await ethers.getSigners();

const gas = async (tx: any): Promise<number> => Number((await (await tx).wait())!.gasUsed);
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { runs: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
};
const out: Record<string, unknown> = {};

// ---- deployment
const deployGas = async (name: string, args: unknown[]) => {
  const c = await ethers.deployContract(name, args as never[]);
  const r = await c.deploymentTransaction()!.wait();
  return { c, gas: Number(r!.gasUsed) };
};
const token = await deployGas("TestToken", [admin.address]);
const rm = await deployGas("ResolutionManager", [admin.address, await token.c.getAddress(), 0, 3600, 100n * E18]);
const impl = await deployGas("PredictionMarket", []);
const factory = await deployGas("MarketFactory", [admin.address, await token.c.getAddress(), await impl.c.getAddress(), await rm.c.getAddress(), 3600]);
out.deployment = { TestToken: token.gas, ResolutionManager: rm.gas, PredictionMarket_implementation: impl.gas, MarketFactory: factory.gas,
  total: token.gas + rm.gas + impl.gas + factory.gas };

await token.c.setFactory(await factory.c.getAddress());
await token.c.setResolutionManager(await rm.c.getAddress());
await rm.c.setRegistry(await factory.c.getAddress());
await factory.c.grantRole(await factory.c.CREATOR_ROLE(), creator.address);
await rm.c.grantRole(await rm.c.RESOLVER_ROLE(), resolver.address);
await rm.c.grantRole(await rm.c.ARBITER_ROLE(), arbiter.address);
await token.c.adminMint(creator.address, 200_000n * E18);
for (const u of [alice, bob, carol, dave]) await token.c.adminMint(u.address, 10_000n * E18);

const create = async (seed: string, b = 100n * E18) => {
  const now = BigInt(await networkHelpers.time.latest());
  const tx = await factory.c.connect(creator).createMarket({ metadataHash: ethers.id(seed), category: 1, tradingClose: now + 7200n, resolutionDeadline: now + 30n * 86400n, liquidityB: b });
  const receipt = await tx.wait();
  const ev = receipt!.logs.map((l: any) => { try { return factory.c.interface.parseLog(l); } catch { return null; } }).find((l: any) => l?.name === "MarketCreated");
  return { market: await ethers.getContractAt("PredictionMarket", ev!.args.market), gas: Number(receipt!.gasUsed), close: now + 7200n };
};

// ---- market creation (different liquidity values: gas should not depend on b)
const creations: number[] = [];
for (let i = 0; i < 5; i++) creations.push((await create(`bench-create-${i}`, BigInt(10 + i * 1000) * E18)).gas);
out.createMarket = stats(creations);

// ---- trading
const m = await create("bench-trading");
const dl = BigInt(Date.now()) + 10n ** 9n;
const firstBuy = await gas(m.market.connect(alice).buy(0, 10n * E18, 10n ** 30n, dl)); // storage slots newly written
const buys: number[] = [], sells: number[] = [];
for (let i = 0; i < 20; i++) buys.push(await gas(m.market.connect(alice).buy(i % 2, (1n + BigInt(i % 5)) * E18, 10n ** 30n, dl)));
for (let i = 0; i < 10; i++) sells.push(await gas(m.market.connect(alice).sell(0, E18 / 2n, 0, dl)));
await m.market.connect(bob).buy(1, 20n * E18, 10n ** 30n, dl);
out.buy = { first_by_a_new_user: firstBuy, repeated: stats(buys) };
out.sell = stats(sells);
out.quoteBuy_view_gas_estimate = Number(await m.market.quoteBuy.estimateGas(0, 10n * E18)); // the LMSR cost evaluation on-chain
out.priceYes_view_gas_estimate = Number(await m.market.priceYes.estimateGas());

// ---- resolution paths and settlement
await networkHelpers.time.increaseTo(m.close);
const resolverPath = await gas(rm.c.connect(resolver).propose(await m.market.getAddress(), 0, ethers.id("e"), "uri"));
const resolve = await gas(rm.c.finalize(await m.market.getAddress()));
const redeem = await gas(m.market.connect(alice).redeem());
const residual = await gas(m.market.connect(creator).claimResidual());
out.resolution = { propose_resolver_no_bond: resolverPath, finalize_and_resolve_market: resolve, redeem, claimResidual: residual };

const o = await create("bench-oracle");
await networkHelpers.time.increaseTo(o.close);
const oa = await o.market.getAddress();
const proposeBonded = await gas(rm.c.connect(dave).proposeBonded(oa, 0, ethers.id("a"), "uri"));
const dispute = await gas(rm.c.connect(carol).dispute(oa, ethers.id("b"), "uri"));
const arbitrate = await gas(rm.c.connect(arbiter).arbitrate(oa, 1, ethers.id("r")));
out.oracle = { proposeBonded, dispute, arbitrate };
out.faucet = await gas(token.c.connect(bob).faucet().catch(async () => token.c.connect(creator).faucet()));

console.log(JSON.stringify(out, null, 2));
