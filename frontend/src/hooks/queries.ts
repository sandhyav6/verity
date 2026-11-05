import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { useAppConfig } from "../blockchain/config";
import { api } from "../lib/api";
import type { AuditEntry, Batch, BatchDocument, DocumentDetail, DocumentVersion, Issuer, Page, ProofEntry, Stats, Verification } from "../lib/types";
import { verifyOnChain } from "../lib/verify";
import type { ChainVerdict, ReadClient } from "../lib/verify";

type Params = Record<string, string | number | boolean | undefined | null>;

export const keys = {
  documents: ["documents"] as const,
  stats: ["stats"] as const,
  audit: ["audit"] as const,
  issuers: ["issuers"] as const,
  batches: ["batches"] as const,
};

export const useDocuments = (params: Params, enabled = true) =>
  useQuery({ queryKey: [...keys.documents, "list", params], queryFn: () => api.get<Page<DocumentVersion>>("/documents", params), placeholderData: keepPreviousData, enabled });

export const useDocument = (hash: string | undefined) =>
  useQuery({ queryKey: [...keys.documents, "one", hash], queryFn: () => api.get<DocumentDetail>(`/documents/${hash}`), enabled: !!hash, retry: (n, e) => (e as { status?: number }).status !== 404 && n < 1 });

export const useStats = (scope: "mine" | "global", enabled = true) =>
  useQuery({ queryKey: [...keys.stats, scope], queryFn: () => api.get<Stats>("/stats", { scope }), enabled });

export const useAudit = (params: Params) =>
  useQuery({ queryKey: [...keys.audit, params], queryFn: () => api.get<Page<AuditEntry>>("/audit", params), placeholderData: keepPreviousData });

export const useIssuers = (params: Params) =>
  useQuery({ queryKey: [...keys.issuers, "list", params], queryFn: () => api.get<Page<Issuer>>("/issuers", params), placeholderData: keepPreviousData });

export const useIssuer = (address: string | undefined) =>
  useQuery({ queryKey: [...keys.issuers, "one", address], queryFn: () => api.get<Issuer>(`/issuers/${address}`), enabled: !!address, retry: false });

export const useBatches = (params: Params, enabled = true) =>
  useQuery({ queryKey: [...keys.batches, "list", params], queryFn: () => api.get<Page<Batch>>("/batches", params), placeholderData: keepPreviousData, enabled });

export const useBatch = (id: string | undefined) =>
  useQuery({ queryKey: [...keys.batches, "one", id], queryFn: () => api.get<Batch>(`/batches/${id}`), enabled: !!id, retry: false });

export const useBatchDocuments = (id: string | undefined, params: Params, enabled: boolean) =>
  useQuery({ queryKey: [...keys.batches, "docs", id, params], queryFn: () => api.get<Page<BatchDocument>>(`/batches/${id}/documents`, params), enabled: !!id && enabled, placeholderData: keepPreviousData });

export interface VerifyResult {
  /** Authoritative: read from the contract by this browser. */
  chain: ChainVerdict;
  /** Decoration from our API (organisation name, transaction hash, public title). Null if the API was unreachable. */
  api: Verification | null;
  apiError: string | null;
  /** True when the API's verdict differs from the contract's: the contract wins and the UI says so. */
  disagreement: boolean;
  /** True when batch proofs could not be fetched, so "not verified" cannot rule out membership of a batch. */
  proofsUnavailable: boolean;
}

/**
 * Verify a fingerprint. The verdict comes from the contract via this browser's own RPC connection, not from our
 * API. The API is consulted for context and for Merkle-proof hints; it can never upgrade a verdict.
 */
export function useVerification(hash: string | null) {
  const cfg = useAppConfig();
  const client = usePublicClient();
  return useQuery({
    queryKey: ["verify", hash, cfg.registry_address],
    enabled: !!hash,
    retry: false,
    staleTime: 10_000,
    queryFn: async (): Promise<VerifyResult> => {
      const h = hash as string;
      const apiResult = api.post<Verification>("/verify", { document_hash: h }).then((v) => ({ v, e: null as string | null }), (e: Error) => ({ v: null, e: e.message }));
      if (!client) throw new Error("No blockchain connection is available in this browser.");
      let proofsUnavailable = false;
      const fetchProofs = async (): Promise<ProofEntry[]> => {
        try {
          return (await api.get<{ entries: ProofEntry[] }>(`/proofs/${h}`)).entries;
        } catch {
          proofsUnavailable = true; // surfaced to the user below, not hidden
          return [];
        }
      };
      const chain = await verifyOnChain(client as unknown as ReadClient, cfg.registry_address, h, fetchProofs);
      const { v, e } = await apiResult;
      return { chain, api: v, apiError: e, disagreement: !!v && v.verdict !== chain.verdict, proofsUnavailable: proofsUnavailable && chain.verdict === "not_verified" };
    },
  });
}
