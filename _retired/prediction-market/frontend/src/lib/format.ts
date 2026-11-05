import { formatUnits } from "viem";

/** Test-token amounts: 18-decimal wei strings -> "1,234.56". Never currency symbols. */
export function tokens(wei: string | bigint | null | undefined, dp = 2): string {
  if (wei === null || wei === undefined) return "-";
  const v = Number(formatUnits(BigInt(wei), 18));
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function tokensNum(wei: string | bigint): number {
  return Number(formatUnits(BigInt(wei), 18));
}

export function pct(p: string | number, dp = 1): string {
  return (Number(p) * 100).toFixed(dp) + "%";
}

/** Prices are tokens-per-share (0 to 1), shown as e.g. 0.652. */
export function price(p: string | number | null | undefined, dp = 3): string {
  return p === null || p === undefined ? "-" : Number(p).toFixed(dp);
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function shortHash(h: string): string {
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function dateOnly(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function compact(n: number): string {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** "in 3h", "2d ago". Used for closing times and data freshness. */
export function relative(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(s);
  const [n, unit] = abs < 3600 ? [Math.max(1, Math.round(abs / 60)), "m"] : abs < 86400 ? [Math.round(abs / 3600), "h"] : [Math.round(abs / 86400), "d"];
  return s >= 0 ? `in ${n}${unit}` : `${n}${unit} ago`;
}

export function duration(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}
