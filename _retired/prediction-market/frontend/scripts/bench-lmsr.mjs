// Times the browser-side indicative LMSR maths (the same module the UI uses).
//   node scripts/bench-lmsr.mjs        (Node 22.18+/24 strips TypeScript types natively)
import { cost, priceYes, quoteBuy, sharesForBudget } from "../src/lib/lmsr.ts";

const time = (name, n, fn) => {
  fn(); // warm up
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn(i);
  const ns = Number(process.hrtime.bigint() - t0);
  return { name, calls: n, ns_per_call: Math.round(ns / n), calls_per_second: Math.round((n / ns) * 1e9) };
};

const s = { qYes: 120, qNo: 40, b: 100 };
const out = [
  time("cost()", 2_000_000, (i) => cost(120 + (i % 7), 40, 100)),
  time("priceYes()", 2_000_000, (i) => priceYes(120 + (i % 7), 40, 100)),
  time("quoteBuy()", 500_000, (i) => quoteBuy(s, "YES", 1 + (i % 50))),
  time("sharesForBudget() (80-step bisection)", 50_000, (i) => sharesForBudget(s, "YES", 5 + (i % 30))),
];
console.log(JSON.stringify(out));
