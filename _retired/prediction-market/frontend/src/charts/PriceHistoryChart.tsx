import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { dateTime, pct } from "../lib/format";
import type { Snapshot } from "../lib/types";
import { COLORS, ChartCard, TipBox } from "./ChartCard";

/**
 * YES probability after each real trade (contract state from the indexed events). Nothing is
 * interpolated or back-filled: with one trade you see one point, with none you see an empty state.
 */
export function PriceHistoryChart({ history }: { history: Snapshot[] }) {
  const data = history.map((h) => ({ t: new Date(h.timestamp).getTime(), p: Number(h.yes_price), block: h.block_number }));
  // short histories (minutes or hours) need clock times on the axis; longer ones need dates
  const span = data.length > 1 ? data[data.length - 1].t - data[0].t : 0;
  const tick = (t: number) => (span < 36 * 3600_000 ? new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  const rows = history.map((h) => [dateTime(h.timestamp), pct(h.yes_price, 2), pct(1 - Number(h.yes_price), 2), h.block_number]);
  return (
    <ChartCard
      title="YES probability over time"
      subtitle={data.length === 1 ? "1 trade so far: a single observation, no curve is drawn." : "Probability implied by the market after each trade."}
      columns={["Time", "YES", "NO", "Block"]}
      rows={rows}
      empty={<p className="py-10 text-center text-sm text-ink2" role="status">No trades yet, so there is no price history. The market opens at 50% / 50%.</p>}
    >
      <div className="h-64 w-full" role="img" aria-label={`YES probability chart with ${data.length} observations`}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} stroke={COLORS.grid} />
            <XAxis dataKey="t" type="number" scale="time" domain={data.length === 1 ? [data[0].t - 3600_000, data[0].t + 3600_000] : ["dataMin", "dataMax"]} tickFormatter={tick} stroke={COLORS.axis} tick={{ fill: COLORS.muted, fontSize: 12 }} tickLine={false} />
            <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v) => `${v * 100}%`} stroke={COLORS.axis} tick={{ fill: COLORS.muted, fontSize: 12 }} tickLine={false} axisLine={false} width={44} />
            <ReferenceLine y={0.5} stroke={COLORS.axis} />
            <Tooltip cursor={{ stroke: COLORS.axis }} content={({ active, payload }) => {
              const d = active && payload?.[0]?.payload;
              return d ? <TipBox title={dateTime(new Date(d.t).toISOString())} lines={[{ label: "YES", value: pct(d.p, 2), color: COLORS.yes }, { label: "NO", value: pct(1 - d.p, 2), color: COLORS.no }, { label: "Block", value: String(d.block) }]} /> : null;
            }} />
            <Line type="stepAfter" dataKey="p" stroke={COLORS.yes} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" isAnimationActive={false}
              dot={{ r: 4, fill: COLORS.yes, stroke: COLORS.surface, strokeWidth: 2 }} activeDot={{ r: 6, fill: COLORS.yes, stroke: COLORS.surface, strokeWidth: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}
