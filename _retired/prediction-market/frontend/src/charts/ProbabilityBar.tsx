import { pct } from "../lib/format";

/** Two-segment YES/NO bar with a 2px surface gap between the fills. Labels sit outside the fills. */
export function ProbabilityBar({ yes, size = "md" }: { yes: number; size?: "sm" | "md" | "lg" }) {
  const y = Math.min(1, Math.max(0, yes));
  const h = { sm: "h-2", md: "h-3", lg: "h-4" }[size];
  return (
    <div role="img" aria-label={`YES ${pct(y)}, NO ${pct(1 - y)}`}>
      <div className={`flex w-full gap-[2px] ${h}`}>
        <span className="rounded-l-[4px]" style={{ width: `${y * 100}%`, background: "var(--yes)", minWidth: y > 0 ? 2 : 0 }} />
        <span className="rounded-r-[4px]" style={{ width: `${(1 - y) * 100}%`, background: "var(--no)", minWidth: y < 1 ? 2 : 0 }} />
      </div>
      <div className="mt-1 flex justify-between text-xs text-ink2 num-col">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: "var(--yes)" }} />YES {pct(y)}</span>
        <span>NO {pct(1 - y)}<span className="ml-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: "var(--no)" }} /></span>
      </div>
    </div>
  );
}
