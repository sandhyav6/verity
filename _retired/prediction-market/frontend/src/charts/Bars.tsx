import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { compact, tokens, tokensNum } from "../lib/format";
import { COLORS, ChartCard, TipBox } from "./ChartCard";

const axisTick = { fill: COLORS.muted, fontSize: 12 };
// Bars are capped at 24px with a 4px rounded data end and a square baseline.
const BAR = { barSize: 20, radius: [4, 4, 0, 0] as [number, number, number, number], isAnimationActive: false };

export interface Point { label: string; value: number; tip?: string; extra?: { label: string; value: string }[] }

/** One-series column chart (counts or token volume per bucket). */
export function ColumnChart({ title, subtitle, points, valueLabel, format = (v) => String(v), empty, tableValue }: {
  title: string; subtitle?: ReactNode; points: Point[]; valueLabel: string; format?: (v: number) => string; empty: ReactNode; tableValue?: (p: Point) => string;
}) {
  return (
    <ChartCard title={title} subtitle={subtitle} columns={["Bucket", valueLabel]} rows={points.map((p) => [p.label, tableValue ? tableValue(p) : format(p.value)])} empty={empty}>
      <div className="h-56 w-full" role="img" aria-label={`${title}: ${points.length} buckets`}>
        <ResponsiveContainer>
          <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={COLORS.grid} />
            <XAxis dataKey="label" stroke={COLORS.axis} tick={axisTick} tickLine={false} />
            <YAxis tickFormatter={(v) => compact(v)} stroke={COLORS.axis} tick={axisTick} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
            <Tooltip cursor={{ fill: "var(--wash)" }} content={({ active, payload }) => {
              const p = active && (payload?.[0]?.payload as Point | undefined);
              return p ? <TipBox title={p.label} lines={[{ label: valueLabel, value: tableValue ? tableValue(p) : format(p.value), color: "var(--accent)" }, ...(p.extra ?? [])]} /> : null;
            }} />
            <Bar dataKey="value" fill="var(--accent)" {...BAR} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

/** Horizontal bars with the value at the bar tip (direct labels), for a few named categories. */
export function HBarChart({ title, subtitle, points, valueLabel, empty }: { title: string; subtitle?: ReactNode; points: Point[]; valueLabel: string; empty: ReactNode }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <ChartCard title={title} subtitle={subtitle} columns={["Category", valueLabel]} rows={points.map((p) => [p.label, String(p.value)])} empty={empty}>
      <ul className="space-y-2" aria-label={title}>
        {points.map((p) => (
          <li key={p.label} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-3 text-sm" title={p.tip}>
            <span className="capitalize text-ink2">{p.label}</span>
            <span className="h-5 rounded-r-[4px]" style={{ width: `${(p.value / max) * 100}%`, minWidth: 4, background: "var(--accent)" }} />
            <span className="num-col font-medium text-ink">{p.value}</span>
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}

/** Token volume helper: wei strings -> chart points. */
export const volumePoint = (label: string, wei: string, trades: number): Point => ({
  label, value: tokensNum(wei), extra: [{ label: "Trades", value: String(trades) }],
});
export const tokenFormat = (v: number) => tokens(BigInt(Math.round(v * 1e6)) * 10n ** 12n, 2);
