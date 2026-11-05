import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { WagmiProvider } from "wagmi";
import { App } from "./App";
import { AppConfigProvider, makeWagmiConfig } from "./blockchain/config";
import { installDevWallet } from "./dev/devWallet";
import "./index.css";
import { api } from "./lib/api";
import type { PublicConfig } from "./lib/types";

const root = createRoot(document.getElementById("root")!);

async function boot() {
  try {
    // Contract addresses and chain come from the backend, so the frontend has nothing to hand-copy.
    const cfg = await api.get<PublicConfig>("/config");
    await installDevWallet(cfg.rpc_url); // no-op unless a dev build with ?devWallet=<n> against local Hardhat
    const wagmi = makeWagmiConfig(cfg);
    const queries = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 4_000, refetchOnWindowFocus: false } } });
    root.render(
      <StrictMode>
        <AppConfigProvider value={cfg}>
          <WagmiProvider config={wagmi}>
            <QueryClientProvider client={queries}>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </QueryClientProvider>
          </WagmiProvider>
        </AppConfigProvider>
      </StrictMode>,
    );
  } catch (e) {
    root.render(
      <div className="mx-auto max-w-xl p-8 text-sm" role="alert">
        <h1 className="text-lg font-semibold">Cannot reach the Verity API</h1>
        <p className="mt-2">Verity loads its network and registry contract address from the API. Start the backend and reload. ({e instanceof Error ? e.message : "unknown error"})</p>
      </div>,
    );
  }
}
void boot();
