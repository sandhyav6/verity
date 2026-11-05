import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";
import { AppConfigProvider } from "../blockchain/config";
import { ToastProvider } from "../components/ui/feedback";
import type { DocumentVersion, PublicConfig } from "../lib/types";

export const CONFIG: PublicConfig = {
  chain_id: 31337, chain_name: "Hardhat Local", rpc_url: "http://127.0.0.1:8545", explorer_tx_url: "",
  registry_address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", indexer_confirmations: 0, siwe_domain: "localhost:5173",
  max_upload_bytes: 25 * 1024 * 1024,
  document_types: { "0": "other", "1": "academic_certificate", "2": "internship_certificate", "3": "research_publication", "4": "compliance_document", "5": "audit_report", "6": "legal_agreement", "7": "software_release", "8": "official_report" },
};

export function renderWithProviders(ui: ReactElement, opts: { route?: string; path?: string; config?: Partial<PublicConfig> } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <AppConfigProvider value={{ ...CONFIG, ...opts.config }}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter initialEntries={[opts.route ?? "/"]}>
            {opts.path ? <Routes><Route path={opts.path} element={ui} /></Routes> : ui}
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AppConfigProvider>,
  );
  return { ...view, client };
}

/** Replace global fetch with a router of path-regex -> JSON body. Unmatched calls fail loudly (404). */
export function mockApi(routes: [RegExp, unknown | ((url: URL, init?: RequestInit) => unknown)][]) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    for (const [re, body] of routes) {
      if (re.test(url.pathname)) {
        const data = typeof body === "function" ? (body as (u: URL, i?: RequestInit) => unknown)(url, init) : body;
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

export const HASH_A = "0x" + "ab".repeat(32);
export const ISSUER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

export function version(over: Partial<DocumentVersion> = {}): DocumentVersion {
  return {
    document_hash: HASH_A, document_id: "0x" + "cd".repeat(32), version_number: 1, is_latest: true,
    issuer: { address: ISSUER, organization_name: "Northfield University", currently_authorized: true },
    document_type: "academic_certificate", status: "valid", registered_at: "2026-11-04T10:00:00Z", expires_at: null, revoked_at: null,
    revoked_by: null, transaction_hash: "0x" + "12".repeat(32), revocation_transaction_hash: null, explorer_url: null, block_number: 7,
    metadata_hash: "0x" + "ef".repeat(32), title: "BSc Certificate", metadata: { holder: "A. Student" }, visibility: "public",
    metadata_verified: true, content_type: "application/pdf", size_bytes: 2048, file_available: true, ...over,
  };
}
