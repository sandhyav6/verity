import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";
import type { MarketStatus } from "../lib/types";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

export function Card({ title, subtitle, actions, children, className }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-xl border border-edge bg-surface p-4 sm:p-5", className)}>
      {(title || actions) && (
        <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            {title && <h2 className="text-base font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-sm text-ink2">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border border-edge bg-surface p-4">
      <div className="text-sm text-ink2">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Button({ variant = "primary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "yes" | "no" | "ghost" }) {
  const styles = {
    primary: "bg-accent text-white hover:opacity-90",
    secondary: "border border-line bg-surface text-ink hover:bg-wash",
    yes: "bg-yes text-white hover:opacity-90",
    no: "bg-no text-white hover:opacity-90",
    ghost: "text-ink2 hover:bg-wash",
  }[variant];
  return <button {...p} className={cx("inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50", styles, className)} />;
}

const STATUS: Record<MarketStatus, { label: string; cls: string; icon: string }> = {
  active: { label: "Trading open", cls: "bg-wash text-goodtext", icon: "●" },
  closed: { label: "Awaiting resolution", cls: "bg-wash text-ink2", icon: "◐" },
  resolved: { label: "Resolved", cls: "bg-wash text-ink", icon: "✓" },
  invalid: { label: "Voided", cls: "bg-wash text-ink2", icon: "⊘" },
};

/** Status always pairs an icon with a label: colour is never the only signal. */
export function StatusBadge({ status }: { status: MarketStatus }) {
  const s = STATUS[status];
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", s.cls)}><span aria-hidden>{s.icon}</span>{s.label}</span>;
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "good" | "bad" }) {
  const t = { neutral: "bg-wash text-ink2", warn: "bg-wash text-ink", good: "bg-wash text-goodtext", bad: "bg-wash text-crit" }[tone];
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs", t)}>{children}</span>;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line p-8 text-center" role="status">
      <p className="font-medium text-ink">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-ink2">{children}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div className="rounded-xl border border-edge bg-surface p-4 text-sm" role="alert">
      <p className="font-medium text-crit">⚠ Could not load this data</p>
      <p className="mt-1 text-ink2">{msg}</p>
      {retry && <Button variant="secondary" className="mt-3" onClick={retry}>Try again</Button>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <p className="py-6 text-center text-sm text-muted" role="status" aria-live="polite">{label}</p>;
}

export function TxLink({ hash, url }: { hash: string; url?: string | null }) {
  const short = `${hash.slice(0, 10)}…${hash.slice(-6)}`;
  return url ? <a className="num-col text-accent underline" href={url} target="_blank" rel="noreferrer">{short}</a> : <Link className="num-col text-accent underline" to={`/transactions?hash=${hash}`}>{short}</Link>;
}

export function Banner({ tone = "info", children }: { tone?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  const icon = { info: "ℹ", warn: "⚠", error: "⛔", ok: "✓" }[tone];
  return <div className="flex gap-2 rounded-lg border border-edge bg-wash px-3 py-2 text-sm text-ink" role={tone === "error" ? "alert" : "status"}><span aria-hidden>{icon}</span><div>{children}</div></div>;
}

export function Field({ label, hint, children, error }: { label: string; hint?: ReactNode; children: ReactNode; error?: string | null }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && !error && <span className="mt-1 block text-xs text-muted">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-crit" role="alert">{error}</span>}
    </label>
  );
}

export const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted";

export function Table({ head, children, caption }: { head: string[]; children: ReactNode; caption?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead><tr className="border-b border-grid text-xs text-muted">{head.map((h) => <th key={h} scope="col" className="px-2 py-2 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-grid">{children}</tbody>
      </table>
    </div>
  );
}

export const Td = ({ children, className }: { children: ReactNode; className?: string }) => <td className={cx("px-2 py-2 align-top", className)}>{children}</td>;
