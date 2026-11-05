import { createContext, useContext } from "react";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { defineChain } from "viem";
import type { PublicConfig } from "../lib/types";

const Ctx = createContext<PublicConfig | null>(null);
export const AppConfigProvider = Ctx.Provider;

export function useAppConfig(): PublicConfig {
  const c = useContext(Ctx);
  if (!c) throw new Error("AppConfigProvider missing");
  return c;
}

export const addr = (a: string) => a as `0x${string}`;

/** The single chain this deployment talks to, taken from the backend's /config (never hard-coded). */
export function makeChain(cfg: PublicConfig) {
  return defineChain({
    id: cfg.chain_id,
    name: cfg.chain_name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc_url] } },
    ...(cfg.explorer_tx_url ? { blockExplorers: { default: { name: "Explorer", url: new URL(cfg.explorer_tx_url).origin } } } : {}),
  });
}

export function makeWagmiConfig(cfg: PublicConfig) {
  const chain = makeChain(cfg);
  return createConfig({
    chains: [chain],
    connectors: [injected()], // MetaMask (or any injected EIP-1193 wallet)
    transports: { [chain.id]: http(cfg.rpc_url) } as Record<number, ReturnType<typeof http>>,
    ssr: false,
  });
}

/** Link to a transaction on the configured block explorer, if there is one (none on a local chain). */
export function txUrl(cfg: PublicConfig, hash: string): string | null {
  return cfg.explorer_tx_url ? cfg.explorer_tx_url + hash : null;
}
