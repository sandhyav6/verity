// Exit 0 if the deployment recorded in a deployments/*.json file is still live on the node, 1 otherwise.
// Lets docker compose re-run the deployer safely: a surviving chain is left alone, a reset chain is redeployed.
//   node scripts/check-deployed.mjs deployments/compose.json http://hardhat-node:8545
import { existsSync, readFileSync } from "node:fs";

const [file, rpc] = process.argv.slice(2);
if (!file || !rpc || !existsSync(file)) process.exit(1);
try {
  const { registry } = JSON.parse(readFileSync(file, "utf8"));
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [registry, "latest"] }) });
  const { result } = await res.json();
  process.exit(typeof result === "string" && result.length > 2 ? 0 : 1);
} catch {
  process.exit(1);
}
