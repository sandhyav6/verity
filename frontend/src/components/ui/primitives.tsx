import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { Link } from "react-router-dom";
import { IconCheck, IconChevronRight, IconCopy, Spinner } from "./icons";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ------------------------------------------------------------------ Button

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accentink hover:opacity-90 border border-transparent",
  secondary: "bg-surface text-ink border border-linestrong hover:bg-surface2",
  ghost: "bg-transparent text-ink2 border border-transparent hover:bg-surface2",
  danger: "bg-bad text-white border border-transparent hover:opacity-90",
};
const SIZES = { sm: "h-8 px-3 text-[13px]", md: "h-10 px-4 text-sm", lg: "h-11 px-5 text-[15px]" };

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: keyof typeof SIZES;
  loading?: boolean;
}
export function Button({ variant = "primary", size = "md", loading, disabled, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx("inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50", VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

/** A link that looks like a button (navigation must be an anchor, not a button). */
export function ButtonLink({ to, variant = "primary", size = "md", className, children, external }: { to: string; variant?: Variant; size?: keyof typeof SIZES; className?: string; children: ReactNode; external?: boolean }) {
  const cls = cx("inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors", VARIANTS[variant], SIZES[size], className);
  return external ? (
    <a href={to} target="_blank" rel="noopener noreferrer" className={cls}>{children}</a>
  ) : (
    <Link to={to} className={cls}>{children}</Link>
  );
}

// ------------------------------------------------------------------ Form fields

const FieldCtx = createContext<{ id: string; describedBy?: string; invalid?: boolean } | null>(null);

export function Field({ label, hint, error, children, optional }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; optional?: boolean }) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <FieldCtx.Provider value={{ id, describedBy, invalid: !!error }}>
      <div className="space-y-1.5">
        <label htmlFor={id} className="flex items-baseline gap-2 text-sm font-medium text-ink">
          {label}
          {optional && <span className="text-xs font-normal text-muted">optional</span>}
        </label>
        {children}
        {hint && <p id={`${id}-hint`} className="text-xs text-muted">{hint}</p>}
        {error && <p id={`${id}-err`} role="alert" className="text-xs font-medium text-bad">{error}</p>}
      </div>
    </FieldCtx.Provider>
  );
}

const control = "w-full rounded-md border bg-surface px-3 text-sm text-ink placeholder:text-muted transition-colors focus-visible:border-accent disabled:opacity-60";
const controlBorder = (invalid?: boolean) => (invalid ? "border-bad" : "border-linestrong");

function useField() {
  const f = useContext(FieldCtx);
  return { id: f?.id, "aria-describedby": f?.describedBy, "aria-invalid": f?.invalid || undefined, invalid: f?.invalid };
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const { invalid, ...a11y } = useField();
  return <input {...a11y} className={cx(control, controlBorder(invalid), "h-10", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { invalid, ...a11y } = useField();
  return <textarea {...a11y} className={cx(control, controlBorder(invalid), "min-h-20 py-2", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  const { invalid, ...a11y } = useField();
  return <select {...a11y} className={cx(control, controlBorder(invalid), "h-10 pr-8", className)} {...rest}>{children}</select>;
}

// ------------------------------------------------------------------ Layout atoms

export function Card({ children, className, as: Tag = "section", ...rest }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" } & React.HTMLAttributes<HTMLElement>) {
  return <Tag className={cx("rounded-lg border border-line bg-surface shadow-[var(--shadow)]", className)} {...rest}>{children}</Tag>;
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function PageHeader({ title, description, actions, breadcrumbs }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumbs?: { label: string; to?: string }[] }) {
  return (
    <header className="mb-6">
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-ink">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Breadcrumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2">
      <ol className="flex flex-wrap items-center gap-1 text-[13px] text-muted">
        {items.map((it, i) => (
          <li key={i} className="flex items-center gap-1">
            {i > 0 && <IconChevronRight width={13} height={13} />}
            {it.to && i < items.length - 1 ? <Link to={it.to} className="hover:text-ink hover:underline">{it.label}</Link> : <span aria-current={i === items.length - 1 ? "page" : undefined} className={i === items.length - 1 ? "text-ink2" : ""}>{it.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

// ------------------------------------------------------------------ Badges

type Tone = "neutral" | "ok" | "warn" | "bad" | "info" | "accent";
const TONES: Record<Tone, string> = {
  neutral: "bg-surface2 text-ink2 border-line",
  ok: "bg-okbg text-ok border-okline",
  warn: "bg-warnbg text-warn border-warnline",
  bad: "bg-badbg text-bad border-badline",
  info: "bg-infobg text-ink2 border-line",
  accent: "bg-accentsoft text-accent border-transparent",
};
export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", TONES[tone], className)}>{children}</span>;
}

const STATUS_TONE: Record<string, [Tone, string]> = {
  valid: ["ok", "Valid"],
  verified: ["ok", "Verified"],
  revoked: ["bad", "Revoked"],
  expired: ["warn", "Expired"],
  not_verified: ["bad", "Not verified"],
};
/** Colour is never the only signal: every status carries an icon and a word. */
export function StatusBadge({ status }: { status: string }) {
  const [tone, label] = STATUS_TONE[status] ?? ["neutral", status];
  return (
    <Badge tone={tone}>
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}

// ------------------------------------------------------------------ Tooltip & copy

export function Tooltip({ text, children }: { text: string; children: ReactElement }) {
  const id = useId();
  return (
    <span className="group relative inline-flex">
      <span aria-describedby={id} className="inline-flex">{children}</span>
      <span id={id} role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 hidden w-max max-w-64 -translate-x-1/2 rounded-md bg-nav px-2.5 py-1.5 text-xs text-navink shadow-lg group-focus-within:block group-hover:block">
        {text}
      </span>
    </span>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      aria-label={done ? "Copied" : `${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          timer.current = window.setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable (insecure context): the value stays selectable */
        }
      }}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface2 hover:text-ink"
    >
      {done ? <IconCheck width={14} height={14} /> : <IconCopy width={14} height={14} />}
    </button>
  );
}

/** A hash or address: monospaced, wrapped, selectable, copyable. */
export function HashText({ value, label, short }: { value: string; label?: string; short?: boolean }) {
  const shown = short && value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <span className="mono break-all" title={value}>{shown}</span>
      <CopyButton value={value} label={`Copy ${label ?? "value"}`} />
    </span>
  );
}

// ------------------------------------------------------------------ Tabs

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          id={`tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const i = tabs.findIndex((x) => x.id === value);
            if (e.key === "ArrowRight") onChange(tabs[(i + 1) % tabs.length].id);
            if (e.key === "ArrowLeft") onChange(tabs[(i - 1 + tabs.length) % tabs.length].id);
          }}
          className={cx("-mb-px border-b-2 px-3 py-2 text-sm font-medium", value === t.id ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
