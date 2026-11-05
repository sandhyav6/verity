export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function shortHash(h: string): string {
  return h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h;
}

export function dateTime(iso: string | number): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function dateOnly(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function relative(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(s);
  const [n, unit] = abs < 60 ? [abs, "s"] : abs < 3600 ? [Math.round(abs / 60), "m"] : abs < 86400 ? [Math.round(abs / 3600), "h"] : [Math.round(abs / 86400), "d"];
  return s >= 0 ? `in ${n}${unit}` : `${n}${unit} ago`;
}

const TYPE_LABELS: Record<string, string> = {
  other: "Other",
  academic_certificate: "Academic certificate",
  internship_certificate: "Internship certificate",
  research_publication: "Research publication",
  compliance_document: "Compliance document",
  audit_report: "Audit report",
  legal_agreement: "Legal agreement",
  software_release: "Software release",
  official_report: "Official report",
};
export const typeLabel = (t: string | null | undefined) => (t ? (TYPE_LABELS[t] ?? t) : "-");
export const DOCUMENT_TYPES = Object.keys(TYPE_LABELS);

const ACTION_LABELS: Record<string, string> = {
  "document.registered": "Document registered",
  "document.revoked": "Document revoked",
  "issuer.authorized": "Issuer authorised",
  "issuer.removed": "Issuer removed",
  "batch.registered": "Batch registered",
  "batch.revoked": "Batch revoked",
  "batch.document_revoked": "Batch document revoked",
};
export const ACTIONS = Object.keys(ACTION_LABELS);
export const actionLabel = (a: string) => ACTION_LABELS[a] ?? a;
