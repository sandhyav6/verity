import { useState, type ReactNode } from "react";
import { Card, Table, Td } from "../components/ui";

/** Series colours come from CSS tokens so light/dark swap in one place. YES = slot 1, NO = slot 2. */
export const COLORS = { yes: "var(--yes)", no: "var(--no)", aqua: "var(--aqua)", grid: "var(--grid)", axis: "var(--line)", muted: "var(--muted)", surface: "var(--surface)" };

export interface Legend { label: string; color: string }

/**
 * Chart wrapper: title/subtitle name the chart, a legend is shown when there are 2+ series, and a
 * table view is always available (the accessible alternative, and the relief for low-contrast hues).
 */
export function ChartCard({ title, subtitle, legend, columns, rows, children, empty }: {
  title: string; subtitle?: ReactNode; legend?: Legend[]; columns: string[]; rows: (string | number)[][]; children: ReactNode; empty?: ReactNode;
}) {
  const [table, setTable] = useState(false);
  const hasData = rows.length > 0;
  return (
    <Card
      title={title}
      subtitle={subtitle}
      actions={hasData ? <button className="rounded-md border border-line px-2 py-1 text-xs text-ink2 hover:bg-wash" aria-pressed={table} onClick={() => setTable((t) => !t)}>{table ? "Show chart" : "Show table"}</button> : undefined}
    >
      {!hasData ? empty : table ? (
        <div className="max-h-72 overflow-y-auto"><Table head={columns} caption={title}>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <Td key={j} className="num-col">{c}</Td>)}</tr>)}</Table></div>
      ) : (
        <>
          {legend && legend.length >= 2 && (
            <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink2" aria-label="Legend">
              {legend.map((l) => <li key={l.label} className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: l.color }} />{l.label}</li>)}
            </ul>
          )}
          {children}
        </>
      )}
    </Card>
  );
}

/** Shared tooltip: surface background, hairline border, text in ink tokens (never the series colour). */
export function TipBox({ title, lines }: { title: string; lines: { label: string; value: string; color?: string }[] }) {
  return (
    <div className="rounded-lg border border-edge bg-surface px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium text-ink">{title}</div>
      {lines.map((l) => <div key={l.label} className="flex items-center gap-2 text-ink2">{l.color && <span className="inline-block h-2 w-2 rounded-full" style={{ background: l.color }} />}<span>{l.label}</span><span className="ml-auto pl-3 font-medium text-ink num-col">{l.value}</span></div>)}
    </div>
  );
}
