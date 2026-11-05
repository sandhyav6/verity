import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ColumnChart } from "../charts/Bars";
import { SeriesLine } from "../charts/SeriesLine";
import { Banner, Card, Empty, ErrorState, Loading, Pill, inputCls } from "../components/ui";
import { useDataRecords, useDataSources } from "../hooks/queries";
import { api } from "../lib/api";
import { dateOnly, dateTime, duration } from "../lib/format";
import type { Category, ExternalRecord } from "../lib/types";

const TABS: { path: string; cat: Category; label: string }[] = [
  { path: "economic", cat: "economy", label: "Economy" },
  { path: "weather", cat: "weather", label: "Weather" },
  { path: "sports", cat: "sports", label: "Sports" },
  { path: "technology", cat: "technology", label: "Technology" },
];

const STATUS_TEXT: Record<ExternalRecord["validation_status"], { label: string; tone: "good" | "warn" | "bad" | "neutral" }> = {
  valid: { label: "✓ valid", tone: "good" },
  incomplete: { label: "◐ incomplete: some days not published yet", tone: "warn" },
  invalid: { label: "✗ failed validation", tone: "bad" },
  manual_submitted: { label: "✎ entered by an administrator, not verified by this site", tone: "neutral" },
};

/** Real daily precipitation, parsed from the exact provider response we stored (never regenerated). */
function DailyRain({ r }: { r: ExternalRecord }) {
  const { data } = useQuery({ queryKey: ["raw", r.raw_payload_hash], queryFn: () => api.text(r.raw_payload_reference) });
  if (!data) return null;
  let pts: { label: string; value: number }[] = [];
  try {
    const d = JSON.parse(data).daily;
    pts = (d.time as string[]).map((t, i) => ({ label: t.slice(5), value: d.precipitation_sum[i] })).filter((p) => p.value !== null);
  } catch {
    return null;
  }
  return <ColumnChart title="Daily precipitation (mm)" subtitle="From the stored provider response; days still missing are not drawn." points={pts} valueLabel="mm" format={(v) => v.toFixed(1)} empty={null} />;
}

function Record({ r }: { r: ExternalRecord }) {
  const st = STATUS_TEXT[r.validation_status];
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2"><Pill>{r.provider}</Pill><Pill tone={st.tone}>{st.label}</Pill>
        <Pill tone={r.freshness.state === "stale" ? "warn" : "neutral"}>{r.freshness.state === "manual" ? "manual record" : `${r.freshness.state} · checked ${duration(r.freshness.age_seconds)} ago`}</Pill>
        {!r.is_latest && <Pill tone="warn">superseded by a revision</Pill>}</div>
      <p className="mt-3 text-2xl font-semibold">{r.value !== null ? <>{Number(r.value)} <span className="text-base font-normal text-ink2">{r.unit}</span></> : r.text ?? <span className="text-base font-normal text-ink2">no total yet</span>}</p>
      <p className="text-sm text-ink2">{r.metric.replace(/_/g, " ")}{r.location ? ` · ${r.location}` : ""}{r.period_start ? ` · ${dateOnly(r.period_start)} to ${r.period_end ? dateOnly(r.period_end) : ""}` : ""}</p>
      {r.validation_notes.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-ink2">{r.validation_notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <Item k="Observation time" v={dateTime(r.observed_at)} />
        <Item k="Retrieved" v={dateTime(r.retrieved_at)} />
        <Item k="Source" v={<a className="break-all text-accent underline" href={r.source_url} target="_blank" rel="noreferrer">{r.source_url.slice(0, 90)}</a>} />
        <Item k="Dataset" v={[r.dataset, r.dataset_version].filter(Boolean).join(" · ") || "-"} />
        {r.grid_latitude && <Item k="Model grid point used" v={`${Number(r.grid_latitude)}, ${Number(r.grid_longitude)}`} />}
        <Item k="Raw data SHA-256" v={<span className="num-col break-all">{r.raw_payload_hash}</span>} />
        <div className="sm:col-span-2"><Item k="How it was derived" v={r.transformation} /></div>
      </dl>
      {r.attribution && <p className="mt-2 text-xs text-ink2">{r.attribution}</p>}
      {r.provider === "open-meteo" && <div className="mt-3"><Banner tone="warn">This is <strong>reanalysis model data</strong> on a coarse grid, not a ground-station observation.</Banner></div>}
      {r.dataset && r.metric === "precipitation_sum_total" && <div className="mt-3"><DailyRain r={r} /></div>}
    </Card>
  );
}
const Item = ({ k, v }: { k: string; v: React.ReactNode }) => <div><dt className="text-muted">{k}</dt><dd className="text-ink">{v}</dd></div>;

export function DataExplorer() {
  const [tab, setTab] = useState(TABS[0]);
  const [status, setStatus] = useState("");
  const [history, setHistory] = useState(false);
  const sources = useDataSources();
  const recs = useDataRecords(tab.path, { validation_status: status || undefined, latest_only: !history, limit: 50 });

  // economic indicators: a time series per numeric metric once there are 2+ reporting periods
  const series = new Map<string, ExternalRecord[]>();
  for (const r of recs.data?.items ?? []) if (r.value !== null && r.period_end && r.category === "economy") series.set(r.metric, [...(series.get(r.metric) ?? []), r]);

  return (
    <div className="space-y-5">
      <div><h1 className="text-2xl font-semibold">Data Explorer</h1>
        <Banner>This is <strong>external, real-world data</strong> used to resolve markets. It is not produced by the blockchain or by traders, and it is kept separate from market activity.</Banner></div>

      <Card title="Sources" subtitle="How each source is accessed, and what we actually hold.">
        {sources.isLoading ? <Loading /> : sources.error ? <ErrorState error={sources.error} /> : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {sources.data!.filter((s) => s.category === tab.cat).map((s) => (
              <li key={s.provider} className="rounded-lg border border-edge p-3 text-sm">
                <p className="font-medium">{s.provider} <Pill>{s.mode}</Pill></p>
                <p className="mt-1 text-xs text-ink2">{s.terms_note}</p>
                <p className="mt-1 text-xs">{s.records === 0 ? "No records held yet." : `${s.records} record(s); last retrieved ${s.last_retrieved_at ? dateTime(s.last_retrieved_at) : "-"}.`}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Data category">
        {TABS.map((t) => <button key={t.path} role="tab" aria-selected={tab.path === t.path} onClick={() => setTab(t)} className={`rounded-lg px-3 py-2 text-sm ${tab.path === t.path ? "bg-accent text-white" : "border border-line text-ink2 hover:bg-wash"}`}>{t.label}</button>)}
        <select className={`${inputCls} ml-auto w-auto`} aria-label="Validation status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any validation status</option><option value="valid">Valid</option><option value="incomplete">Incomplete</option><option value="invalid">Invalid</option><option value="manual_submitted">Entered manually</option>
        </select>
        <label className="flex items-center gap-1 text-sm text-ink2"><input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />Include superseded revisions</label>
      </div>

      {[...series.entries()].filter(([, rs]) => rs.length >= 1).map(([metric, rs]) => (
        <SeriesLine key={metric} title={metric.replace(/_/g, " ")} subtitle="By reporting period (official figures entered by an administrator)" unit={rs[0].unit ?? ""} points={[...rs].sort((a, b) => a.period_end!.localeCompare(b.period_end!)).map((r) => ({ label: r.period_end!, value: Number(r.value), sub: r.provider }))} empty={null} />
      ))}

      {recs.isLoading ? <Loading /> : recs.error ? <ErrorState error={recs.error} retry={() => recs.refetch()} /> : !recs.data?.items.length ? (
        <Empty title={`No ${tab.label.toLowerCase()} data yet`}>
          {tab.cat === "weather" ? "Weather records are fetched from Open-Meteo for the markets that need them (or on an administrator's request)." : "These records are entered by an administrator from official documents; this site does not crawl those sources. Nothing is pre-loaded or simulated."}
        </Empty>
      ) : <div className="space-y-4">{recs.data.items.map((r) => <Record key={r.id} r={r} />)}</div>}
    </div>
  );
}
