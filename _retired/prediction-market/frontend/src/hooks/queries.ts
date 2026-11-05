import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type {
  CategoryStat, Evidence, ExternalRecord, Market, MarketStat, Overview, Page, Portfolio, Resolution, Snapshot, SourceStatus, Trade, TxStatus,
} from "../lib/types";

type P = Record<string, string | number | boolean | undefined | null>;
const LIVE = 8_000; // poll interval for views that should feel live

export const useMarkets = (params: P) => useQuery({ queryKey: ["markets", params], queryFn: () => api.get<Page<Market>>("/markets", params), refetchInterval: LIVE * 2 });
export const useMarket = (id: number) => useQuery({ queryKey: ["market", id], queryFn: () => api.get<Market>(`/markets/${id}`), refetchInterval: LIVE, enabled: Number.isFinite(id) });
export const useHistory = (id: number) => useQuery({ queryKey: ["history", id], queryFn: () => api.get<Page<Snapshot>>(`/markets/${id}/history`, { limit: 1000 }), refetchInterval: LIVE });
export const useMarketTrades = (id: number) => useQuery({ queryKey: ["trades", "market", id], queryFn: () => api.get<Page<Trade>>(`/markets/${id}/trades`, { limit: 20 }), refetchInterval: LIVE });
export const useEvidence = (id: number) => useQuery({ queryKey: ["evidence", id], queryFn: () => api.get<Evidence[]>(`/markets/${id}/evidence`) });
export const useResolution = (id: number) => useQuery({ queryKey: ["resolution", id], queryFn: () => api.get<Resolution>(`/resolutions/${id}`), refetchInterval: LIVE });
export const useTrades = (params: P) => useQuery({ queryKey: ["trades", params], queryFn: () => api.get<Page<Trade>>("/trades", params), refetchInterval: LIVE });
export const usePortfolio = (address?: string) => useQuery({ queryKey: ["portfolio", address], queryFn: () => api.get<Portfolio>(`/portfolio/${address}`), enabled: !!address, refetchInterval: LIVE });
export const useOverview = () => useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/analytics/overview"), refetchInterval: LIVE * 2 });
export const useCategories = () => useQuery({ queryKey: ["categories"], queryFn: () => api.get<CategoryStat[]>("/analytics/categories"), refetchInterval: LIVE * 2 });
export const useMarketStats = () => useQuery({ queryKey: ["marketStats"], queryFn: () => api.get<MarketStat[]>("/analytics/markets", { limit: 50 }), refetchInterval: LIVE * 2 });
export const useDataRecords = (category: string, params: P) => useQuery({ queryKey: ["data", category, params], queryFn: () => api.get<Page<ExternalRecord>>(`/data/${category}`, params) });
export const useDataSources = () => useQuery({ queryKey: ["dataSources"], queryFn: () => api.get<SourceStatus[]>("/data/sources") });
export const useTxStatus = (hash?: string) => useQuery({ queryKey: ["tx", hash], queryFn: () => api.get<TxStatus>(`/transactions/${hash}`), enabled: !!hash, refetchInterval: (q) => (q.state.data?.status === "success" || q.state.data?.status === "failed" ? false : 4_000) });
