import { useState } from "react";
import { useReadContracts } from "wagmi";
import { predictionMarketAbi } from "../blockchain/abis";
import { addr } from "../blockchain/config";
import { pct } from "../lib/format";
import type { Market } from "../lib/types";
import { Button, Card } from "./ui";

const STATUS = ["active", "resolved", "invalid"];

/** Re-reads the market straight from the contract and compares it with the indexed (database) view. */
export function VerifyOnChain({ market }: { market: Market }) {
  const [on, setOn] = useState(false);
  const a = addr(market.contract_address);
  const c = { address: a, abi: predictionMarketAbi } as const;
  const { data, isFetching, error, refetch } = useReadContracts({
    contracts: [{ ...c, functionName: "qYes" }, { ...c, functionName: "qNo" }, { ...c, functionName: "collateral" }, { ...c, functionName: "priceYes" }, { ...c, functionName: "status" }],
    query: { enabled: on },
  });
  const v = (i: number) => (data?.[i]?.status === "success" ? data[i].result : undefined);
  const rows: [string, string, string | undefined][] = [
    ["YES shares outstanding", market.q_yes, v(0)?.toString()],
    ["NO shares outstanding", market.q_no, v(1)?.toString()],
    ["Collateral held", market.collateral, v(2)?.toString()],
    ["YES price", pct(market.yes_price, 2), v(3) !== undefined ? pct(Number(v(3)) / 1e18, 2) : undefined],
    ["Status", market.status === "closed" ? "active" : market.status, v(4) !== undefined ? STATUS[Number(v(4))] : undefined],
  ];
  return (
    <Card title="Verify against the blockchain" subtitle="The database is a fast copy of the chain. Check it against the contract yourself.">
      {!on ? <Button variant="secondary" onClick={() => setOn(true)}>Read from the contract</Button> : (
        <>
          <ul className="space-y-1 text-sm">
            {rows.map(([k, indexed, chain]) => {
              const ok = chain !== undefined && (chain === indexed || (k === "YES price" && Math.abs(parseFloat(chain) - parseFloat(indexed)) < 0.01));
              return <li key={k} className="flex justify-between gap-2"><span className="text-ink2">{k}</span><span className="num-col">{chain === undefined ? "…" : ok ? <span className="text-goodtext">✓ matches</span> : <span className="text-crit">✗ differs (db {indexed}, chain {chain})</span>}</span></li>;
            })}
          </ul>
          {error && <p className="mt-2 text-xs text-crit" role="alert">Could not read the contract: {error.message.slice(0, 120)}</p>}
          <Button variant="ghost" className="mt-2" onClick={() => refetch()} disabled={isFetching}>{isFetching ? "Reading…" : "Re-check"}</Button>
        </>
      )}
    </Card>
  );
}
