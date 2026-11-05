import { useEffect, useId, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";
import { cx, Button } from "./primitives";
import { IconCheck, IconChevronDown, IconUpload } from "./icons";
import { EmptyState, ErrorState, TableSkeleton } from "./feedback";

// ------------------------------------------------------------------ Table (stacks into labelled cards on phones)

export interface Column<T> { key: string; header: string; cell: (row: T) => ReactNode; className?: string; align?: "right" }

export function DataTable<T>({ columns, rows, rowKey, loading, error, onRetry, empty }: {
  columns: Column<T>[]; rows: T[] | undefined; rowKey: (row: T) => string; loading?: boolean; error?: unknown; onRetry?: () => void; empty?: ReactNode;
}) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (loading || !rows) return <TableSkeleton cols={Math.min(columns.length, 5)} />;
  if (rows.length === 0) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm max-md:block">
        <thead className="max-md:hidden">
          <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
            {columns.map((c) => <th key={c.key} scope="col" className={cx("px-5 py-2.5 font-medium", c.align === "right" && "text-right")}>{c.header}</th>)}
          </tr>
        </thead>
        <tbody className="max-md:block">
          {rows.map((r) => (
            <tr key={rowKey(r)} className="border-b border-line last:border-0 hover:bg-surface2 max-md:block max-md:px-4 max-md:py-3">
              {columns.map((c) => (
                <td key={c.key} data-label={c.header}
                  className={cx("px-5 py-3 align-middle max-md:flex max-md:items-baseline max-md:justify-between max-md:gap-4 max-md:px-0 max-md:py-1 max-md:before:shrink-0 max-md:before:text-xs max-md:before:text-muted max-md:before:content-[attr(data-label)]", c.align === "right" && "md:text-right", c.className)}>
                  <span className="min-w-0 max-md:text-right">{c.cell(r)}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= limit) return total > 0 ? <p className="px-5 py-3 text-xs text-muted">{total} result{total === 1 ? "" : "s"}</p> : null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
      <p className="text-xs text-muted num">{offset + 1}–{Math.min(offset + limit, total)} of {total}</p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Previous</Button>
        <span className="text-xs text-muted num" aria-current="page">Page {page} of {pages}</span>
        <Button variant="secondary" size="sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next</Button>
      </div>
    </nav>
  );
}

// ------------------------------------------------------------------ File drop

export function FileDrop({ onFiles, multiple, disabled, label, hint }: { onFiles: (files: File[]) => void; multiple?: boolean; disabled?: boolean; label: string; hint?: string }) {
  const [over, setOver] = useState(false);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const pick = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!disabled) pick(e.dataTransfer.files);
  };
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cx("relative rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors focus-within:border-accent", over ? "border-accent bg-accentsoft" : "border-linestrong bg-surface2", disabled && "opacity-60")}
    >
      <input ref={input} id={id} type="file" multiple={multiple} disabled={disabled} className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" onChange={(e) => { pick(e.target.files); e.target.value = ""; }} aria-label={label} />
      <IconUpload className="mx-auto mb-2 text-muted" width={26} height={26} />
      <p className="text-sm font-medium text-ink">{label}</p>
      <p className="mt-1 text-xs text-muted">{hint ?? "Drag and drop, or click to browse"}</p>
    </div>
  );
}

// ------------------------------------------------------------------ Stepper

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol aria-label="Progress" className="flex items-center gap-2 overflow-x-auto pb-1">
      {steps.map((s, i) => (
        <li key={s} aria-current={i === current ? "step" : undefined} className="flex items-center gap-2">
          <span className={cx("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold", i < current ? "bg-accent text-accentink" : i === current ? "border-2 border-accent text-accent" : "border border-linestrong text-muted")}>
            {i < current ? <IconCheck width={13} height={13} /> : i + 1}
          </span>
          <span className={cx("whitespace-nowrap text-sm", i === current ? "font-medium text-ink" : "text-muted")}>{s}</span>
          {i < steps.length - 1 && <span aria-hidden className="mx-1 h-px w-6 bg-line" />}
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------ Dropdown menu

export function DropdownMenu({ label, children, align = "right", buttonClassName }: { label: ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; buttonClassName?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
  };
  return (
    <div ref={root} className="relative" onKeyDown={onKey}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={cx("inline-flex h-10 items-center gap-2 rounded-md border border-linestrong bg-surface px-3 text-sm font-medium text-ink hover:bg-surface2", buttonClassName)}>
        {label}
        <IconChevronDown width={15} height={15} />
      </button>
      {open && (
        <div role="menu" className={cx("absolute z-40 mt-1.5 w-64 rounded-lg border border-line bg-surface p-1.5 shadow-xl", align === "right" ? "right-0" : "left-0")}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, danger }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={cx("flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-surface2", danger ? "text-bad" : "text-ink")}>
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ Key/value list

export function Facts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted">{i.label}</dt>
          <dd className="mt-1 break-words text-sm text-ink">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}
