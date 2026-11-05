import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";
import { AppConfigProvider } from "../blockchain/config";
import type { Market, PublicConfig } from "../lib/types";

export const CONFIG: PublicConfig = {
  chain_id: 31337, chain_name: "Hardhat Local", rpc_url: "http://127.0.0.1:8545", explorer_tx_url: "",
  factory_address: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9", token_address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  resolution_manager_address: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", indexer_confirmations: 0, siwe_domain: "localhost:5173",
  notice: "TEST tokens only: no monetary value.",
};

export function renderWithProviders(ui: ReactElement, opts: { route?: string; path?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <AppConfigProvider value={CONFIG}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[opts.route ?? "/"]}>
          {opts.path ? <Routes><Route path={opts.path} element={ui} /></Routes> : ui}
        </MemoryRouter>
      </QueryClientProvider>
    </AppConfigProvider>,
  );
  return { ...view, client };
}

/** Replace global fetch with a router of path-regex -> JSON body. Unmatched calls fail loudly. */
export function mockApi(routes: [RegExp, unknown | ((url: URL) => unknown)][]) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    for (const [re, body] of routes) {
      if (re.test(url.pathname)) {
        const data = typeof body === "function" ? (body as (u: URL) => unknown)(url) : body;
        if (data instanceof Response) return data;
        return new Response(typeof data === "string" ? data : JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ detail: `unmocked ${url.pathname}` }), { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export const page = <T,>(items: T[], over: Partial<{ total: number; limit: number; offset: number }> = {}) => ({ items, total: items.length, limit: 20, offset: 0, ...over });

export function market(over: Partial<Market> = {}): Market {
  return {
    id: 1, contract_address: "0xd8058efe0198ae9dd7d563e1b4938dcbc86a1f81", question: "Will Chennai receive more than 100 mm of rain in October?",
    description: "Test fixture market.", category: "weather", yes_definition: "Above 100 mm", no_definition: "100 mm or less",
    resolution_source: { name: "Open-Meteo", url: "https://open-meteo.com", dataset: "precipitation_sum" }, resolution_criteria: "Sum of daily values.",
    resolution_spec: null, data_rule: null, resolution_data_note: null, metadata_verified: true, metadata_hash: "0x" + "ab".repeat(32), status: "active",
    winning_outcome: null, yes_price: "0.5", no_price: "0.5", liquidity_parameter: "100000000000000000000", q_yes: "0", q_no: "0",
    collateral: "69314718055994530942", volume: "0", trade_count: 0, created_by: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    created_at: "2026-11-04T10:00:00Z", trading_close_time: new Date(Date.now() + 86400_000).toISOString(),
    resolution_deadline: new Date(Date.now() + 5 * 86400_000).toISOString(), resolved_at: null, ...over,
  };
}
