import { Field, inputCls } from "./ui";

export interface EvForm {
  proposed_outcome: "YES" | "NO" | "INVALID"; source_name: string; source_url: string; evidence_retrieved_at: string; observation_period: string;
  raw_evidence_reference: string; raw_evidence_hash: string; normalized_result: string; unit: string; notes: string;
}

export const blankEvidence = (): EvForm => ({
  proposed_outcome: "YES", source_name: "", source_url: "", evidence_retrieved_at: new Date().toISOString().slice(0, 16), observation_period: "",
  raw_evidence_reference: "", raw_evidence_hash: "", normalized_result: "", unit: "", notes: "",
});

/** The body the API expects for propose/dispute evidence. */
export function evidencePayload(e: EvForm) {
  return { ...e, evidence_retrieved_at: new Date(e.evidence_retrieved_at).toISOString(), unit: e.unit || null, notes: e.notes || null };
}

/** Client-side completeness check; the API validates again. */
export function evidenceProblem(e: EvForm): string | null {
  if (e.source_name.trim().length < 3) return "Name the source.";
  if (!/^https?:\/\/\S+$/.test(e.source_url.trim())) return "The source must be a web address (https://…).";
  if (e.observation_period.trim().length < 5) return "State the observation period.";
  if (e.raw_evidence_reference.trim().length < 3) return "Say where the raw data can be found.";
  if (!/^0x[0-9a-fA-F]{64}$/.test(e.raw_evidence_hash.trim())) return "The raw data hash must be 0x followed by 64 hex characters.";
  if (!e.normalized_result.trim()) return "Give the result you extracted from the data.";
  if (Number.isNaN(Date.parse(e.evidence_retrieved_at))) return "Say when you retrieved the data.";
  return null;
}

export function EvidenceForm({ value, onChange, outcomeLabel = "Outcome the evidence supports" }: { value: EvForm; onChange: (v: EvForm) => void; outcomeLabel?: string }) {
  const set = (k: keyof EvForm, v: string) => onChange({ ...value, [k]: v });
  const input = (k: keyof EvForm, label: string, type = "text") => (
    <Field label={label}><input type={type} className={inputCls} value={value[k]} onChange={(e) => set(k, e.target.value)} /></Field>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={outcomeLabel}><select className={inputCls} value={value.proposed_outcome} onChange={(e) => set("proposed_outcome", e.target.value)}>{(["YES", "NO", "INVALID"] as const).map((o) => <option key={o}>{o}</option>)}</select></Field>
      {input("normalized_result", "Result extracted from the data")}
      {input("source_name", "Source name")}
      {input("source_url", "Source URL")}
      {input("evidence_retrieved_at", "Retrieved at", "datetime-local")}
      {input("observation_period", "Observation period")}
      {input("raw_evidence_reference", "Raw evidence reference (URL / archive id)")}
      {input("raw_evidence_hash", "Raw evidence hash (0x + 64 hex)")}
      {input("unit", "Unit")}
      {input("notes", "Notes")}
    </div>
  );
}
