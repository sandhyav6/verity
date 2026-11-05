import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { COLORS, ChartCard, TipBox } from "./ChartCard";

export interface SeriesPoint { label: string; value: number; sub?: string }

/**
 * EXTERNAL data series (e.g. an economic indicator over reporting periods). Separate from the
 * blockchain probability chart on purpose; one point renders as one point.
 */
export function SeriesLine({ title, subtitle, unit, points, empty }: { title: string; subtitle?: string; unit: string; points: SeriesPoint[]; empty: React.ReactNode }) {
  return (
    <ChartCard title={title} subtitle={subtitle} columns={["Period", unit]} rows={points.map((p) => [p.label, p.value])} empty={empty}>
      <div className="h-52 w-full" role="img" aria-label={`${title}: ${points.length} observations`}>
        <ResponsiveContainer>
          <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={COLORS.grid} />
            <XAxis dataKey="label" stroke={COLORS.axis} tick={{ fill: COLORS.muted, fontSize: 12 }} tickLine={false} />
            <YAxis stroke={COLORS.axis} tick={{ fill: COLORS.muted, fontSize: 12 }} tickLine={false} axisLine={false} width={44} domain={["auto", "auto"]} />
            <Tooltip cursor={{ stroke: COLORS.axis }} content={({ active, payload }) => {
              const p = active && (payload?.[0]?.payload as SeriesPoint | undefined);
              return p ? <TipBox title={p.label} lines={[{ label: unit, value: String(p.value), color: "var(--accent)" }, ...(p.sub ? [{ label: "Note", value: p.sub }] : [])]} /> : null;
            }} />
            <Line dataKey="value" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" isAnimationActive={false}
              dot={{ r: 4, fill: "var(--accent)", stroke: COLORS.surface, strokeWidth: 2 }} activeDot={{ r: 6, stroke: COLORS.surface, strokeWidth: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}
