import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

// Local development only. Public testnet (Sepolia) is added in Phase 7; there is
// intentionally no mainnet network configured anywhere in this project.
export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  networks: {
    // A separately started `hardhat node`. RPC_URL lets tests use another port.
    localhost: { type: "http", url: process.env.RPC_URL ?? "http://127.0.0.1:8545" },
    // Optional public TESTNET demo. Only defined when both variables are set; the key stays in your shell
    // or secret store and is never committed. scripts/deploy.ts additionally refuses any other chain id.
    ...(process.env.SEPOLIA_RPC_URL && process.env.DEPLOYER_PRIVATE_KEY
      ? { sepolia: { type: "http" as const, url: process.env.SEPOLIA_RPC_URL, accounts: [process.env.DEPLOYER_PRIVATE_KEY] } }
      : {}),
  },
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          evmVersion: "cancun",
          optimizer: { enabled: true, runs: 200 },
        },
      },
    },
  },
});
