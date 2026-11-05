// Deploys VerityRegistry to a LOCAL/TEST network and writes deployments/<name>.json.
// There is intentionally no mainnet network in hardhat.config.ts.
//
//   npx hardhat node                                          (terminal 1)
//   npx hardhat run scripts/deploy.ts --network localhost     (terminal 2)
//
// Local roles (default Hardhat accounts): #0 admin + issuer manager, #1 issuer ("Northfield University"),
// #2 issuer ("Harbor Audit LLP"). Override with ISSUERS='[{"address":"0x..","name":"Org"}]' (JSON).
import { mkdirSync, writeFileSync } from "node:fs";
import { network } from "hardhat";

const { ethers } = await network.getOrCreate();

// Refuse anything but a local chain (31337) or Sepolia (11155111), checked before any transaction is sent.
const ALLOWED_CHAIN_IDS: Record<number, string> = { 31337: "local Hardhat", 11155111: "Sepolia testnet" };
const chainId = Number((await ethers.provider.getNetwork()).chainId);
if (!(chainId in ALLOWED_CHAIN_IDS)) {
  throw new Error(`Refusing to deploy to chain ${chainId}: only ${Object.entries(ALLOWED_CHAIN_IDS).map(([id, n]) => `${id} (${n})`).join(" and ")} are allowed.`);
}
console.log(`Deploying to ${ALLOWED_CHAIN_IDS[chainId]} (chain ${chainId})`);

const [admin, issuer1, issuer2] = await ethers.getSigners();
const adminDelay = Number(process.env.ADMIN_TRANSFER_DELAY ?? 0); // seconds; use days on a shared network
const issuers: { address: string; name: string }[] = process.env.ISSUERS
  ? JSON.parse(process.env.ISSUERS)
  : chainId === 31337
    ? [{ address: issuer1.address, name: "Northfield University" }, { address: issuer2.address, name: "Harbor Audit LLP" }]
    : [];

const registry = await ethers.deployContract("VerityRegistry", [admin.address, adminDelay]);
const receipt = await registry.deploymentTransaction()?.wait();
for (const i of issuers) await (await registry.authorizeIssuer(i.address, i.name)).wait();

const out = {
  network: (await ethers.provider.getNetwork()).name,
  chainId,
  deployBlock: Number(receipt?.blockNumber ?? 0),
  registry: await registry.getAddress(),
  roles: { admin: admin.address },
  issuers,
  adminTransferDelay: adminDelay,
};
mkdirSync(new URL("../deployments/", import.meta.url), { recursive: true });
writeFileSync(new URL(`../deployments/${process.env.DEPLOYMENT_NAME ?? "local"}.json`, import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
