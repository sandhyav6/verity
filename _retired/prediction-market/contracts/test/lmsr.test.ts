import { expect } from "chai";
import { readFileSync } from "node:fs";
import { ethers, absDiff, E18 } from "./helpers.js";

const vectors = JSON.parse(readFileSync(new URL("../reference/vectors.json", import.meta.url), "utf8"));

describe("LMSRMath vs independent mpmath reference", () => {
  let h: any;
  before(async () => {
    h = await ethers.deployContract("LMSRHarness");
  });

  it("cost() matches the 50-digit reference within the safety margin", async () => {
    let worst = 0n;
    let worstRatio = 0;
    for (const v of vectors.points) {
      const b = BigInt(v.b);
      const got: bigint = await h.cost(BigInt(v.qYes), BigInt(v.qNo), b);
      const lo = BigInt(v.costFloor);
      const hi = BigInt(v.costCeil);
      const err = got < lo ? lo - got : got > hi ? got - hi : 0n;
      const m: bigint = await h.margin(b);
      expect(err <= m, `cost error ${err} wei > margin ${m} for b=${b} q=(${v.qYes},${v.qNo})`).to.equal(true);
      if (err > worst) worst = err;
      worstRatio = Math.max(worstRatio, Number(err) / Number(m));
    }
    console.log(`      max cost error: ${worst} wei; worst error/margin = ${worstRatio.toFixed(4)}`);
  });

  it("priceYes() matches the reference to within 1e-15 absolute", async () => {
    let worst = 0n;
    for (const v of vectors.points) {
      const got: bigint = await h.priceYes(BigInt(v.qYes), BigInt(v.qNo), BigInt(v.b));
      const err = absDiff(got, BigInt(v.priceYesWad));
      if (err > worst) worst = err;
      expect(err <= 1000n, `price error ${err} (b=${v.b} q=(${v.qYes},${v.qNo}))`).to.equal(true);
    }
    console.log(`      max price error: ${worst} (WAD units; 1e18 = 1.0)`);
  });

  it("fresh market is priced 50/50 and costs b*ln2", async () => {
    const b = 100n * E18;
    expect(await h.priceYes(0, 0, b)).to.equal(E18 / 2n);
    const c: bigint = await h.cost(0, 0, b);
    // 100 * ln2 = 69.3147180559945309...
    expect(absDiff(c, 69_314_718_055_994_530_941n) <= 2000n).to.equal(true);
  });

  it("cost is symmetric in YES/NO and price(Y)+price(N)=1", async () => {
    const b = 50n * E18;
    expect(await h.cost(7n * E18, 3n * E18, b)).to.equal(await h.cost(3n * E18, 7n * E18, b));
    const py: bigint = await h.priceYes(7n * E18, 3n * E18, b);
    const pn: bigint = await h.priceYes(3n * E18, 7n * E18, b);
    expect(absDiff(py + pn, E18) <= 2n).to.equal(true);
  });

  it("subsidy covers the true maximum loss b*ln2", async () => {
    for (const b of [10n, 100n, 100_000n].map((x) => x * E18)) {
      const s: bigint = await h.initialSubsidy(b);
      const trueLoss = (b * 693147180559945309n) / E18; // truncated ln2, so subsidy must exceed it
      expect(s > trueLoss).to.equal(true);
    }
  });
});
