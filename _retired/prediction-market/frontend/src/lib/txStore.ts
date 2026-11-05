// Transactions submitted from this browser session, kept in sessionStorage so the Transactions page
// can show them (and their live status) before the indexer has seen them. Per-viewer convenience only.
export interface TrackedTx { hash: `0x${string}`; label: string; submittedAt: number }
const KEY = "pm.trackedTxs";
const listeners = new Set<() => void>();
let cache: TrackedTx[] | null = null;

function load(): TrackedTx[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as TrackedTx[];
  } catch {
    cache = [];
  }
  return cache;
}

export function getTrackedTxs(): TrackedTx[] {
  return load();
}

export function trackTx(tx: TrackedTx): void {
  cache = [tx, ...load().filter((t) => t.hash !== tx.hash)].slice(0, 30);
  try {
    sessionStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage unavailable: the in-memory list still works */
  }
  listeners.forEach((l) => l());
}

export function subscribeTxs(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
