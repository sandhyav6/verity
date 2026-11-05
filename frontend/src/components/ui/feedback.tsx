import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, cx } from "./primitives";
import { IconAlert, IconCheck, IconInfo, IconX } from "./icons";

// ------------------------------------------------------------------ Alert

type AlertTone = "info" | "ok" | "warn" | "bad";
const ALERT: Record<AlertTone, string> = {
  info: "bg-infobg border-line text-ink2",
  ok: "bg-okbg border-okline text-ok",
  warn: "bg-warnbg border-warnline text-warn",
  bad: "bg-badbg border-badline text-bad",
};
export function Alert({ tone = "info", title, children, action }: { tone?: AlertTone; title?: string; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === "ok" ? IconCheck : tone === "info" ? IconInfo : IconAlert;
  return (
    <div role={tone === "bad" || tone === "warn" ? "alert" : "status"} className={cx("flex items-start gap-3 rounded-md border px-4 py-3 text-sm", ALERT[tone])}>
      <Icon className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cx(title && "mt-0.5", "text-ink2")}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

// ------------------------------------------------------------------ Empty / error / loading

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {children && <p className="mt-1 max-w-md text-sm text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = "Something went wrong" }: { error: unknown; onRetry?: () => void; title?: string }) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-10 text-center">
      <IconAlert className="mb-2 text-bad" width={22} height={22} />
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      <p className="mt-1 max-w-md text-sm text-muted">{message}</p>
      {onRetry && <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("skeleton", className ?? "h-4 w-full")} />;
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-3 p-5">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4">
          {Array.from({ length: cols }, (_, c) => <Skeleton key={c} className={cx("h-5", c === 0 ? "w-1/3" : "flex-1")} />)}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Dialog

export function Dialog({ open, onClose, title, description, children, footer }: { open: boolean; onClose: () => void; title: string; description?: string; children?: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement;
    const node = ref.current;
    const focusable = () => Array.from(node?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter((e) => !e.hasAttribute("disabled"));
    (focusable()[0] ?? node)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const f = focusable();
        if (f.length === 0) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      (returnTo.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby={description ? "dlg-desc" : undefined} tabIndex={-1} className="max-h-[90vh] w-full overflow-auto rounded-t-xl border border-line bg-surface shadow-2xl sm:max-w-md sm:rounded-xl">
        <div className="px-5 pt-5">
          <h2 id="dlg-title" className="text-lg font-semibold text-ink">{title}</h2>
          {description && <p id="dlg-desc" className="mt-1 text-sm text-muted">{description}</p>}
        </div>
        {children && <div className="px-5 py-4">{children}</div>}
        {footer && <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, description, confirmLabel, danger, loading, onConfirm, onClose, children }: {
  open: boolean; title: string; description?: string; confirmLabel: string; danger?: boolean; loading?: boolean; onConfirm: () => void; onClose: () => void; children?: ReactNode;
}) {
  return (
    <Dialog open={open} onClose={loading ? () => {} : onClose} title={title} description={description}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
      </>}>
      {children}
    </Dialog>
  );
}

// ------------------------------------------------------------------ Toasts

interface Toast { id: number; tone: "ok" | "bad" | "info"; message: string }
const ToastCtx = createContext<{ push: (message: string, tone?: Toast["tone"]) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-3), { id, tone, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "bad" ? 9000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-4">
        {toasts.map((t) => (
          <div key={t.id} role={t.tone === "bad" ? "alert" : "status"} className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm shadow-lg">
            <span className={cx("mt-0.5", t.tone === "ok" ? "text-ok" : t.tone === "bad" ? "text-bad" : "text-accent")}>{t.tone === "ok" ? <IconCheck /> : t.tone === "bad" ? <IconAlert /> : <IconInfo />}</span>
            <p className="flex-1 text-ink">{t.message}</p>
            <button type="button" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="text-muted hover:text-ink"><IconX width={16} height={16} /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const c = useContext(ToastCtx);
  if (!c) throw new Error("ToastProvider missing");
  return c;
}
