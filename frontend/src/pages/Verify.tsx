import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAppConfig, txUrl } from "../blockchain/config";
import { Facts, FileDrop } from "../components/ui/data";
import { Alert, Skeleton } from "../components/ui/feedback";
import { IconAlert, IconCheck, IconClock, IconFile, IconX } from "../components/ui/icons";
import { Button, Card, CardHeader, cx, Field, HashText, Input, PageHeader, StatusBadge, Tabs } from "../components/ui/primitives";
import { useVerification } from "../hooks/queries";
import type { VerifyResult } from "../hooks/queries";
import { bytes, dateTime, shortAddr, typeLabel } from "../lib/format";
import { normalizeHash, sha256File } from "../lib/hash";
import type { Verdict } from "../lib/types";

const VERDICT_UI: Record<Verdict, { word: string; tone: string; icon: ReactElement }> = {
  verified: { word: "VERIFIED", tone: "border-okline bg-okbg text-ok", icon: <IconCheck width={28} height={28} /> },
  revoked: { word: "REVOKED", tone: "border-badline bg-badbg text-bad", icon: <IconX width={28} height={28} /> },
  expired: { word: "EXPIRED", tone: "border-warnline bg-warnbg text-warn", icon: <IconClock width={28} height={28} /> },
  not_verified: { word: "NOT VERIFIED", tone: "border-badline bg-badbg text-bad", icon: <IconAlert width={28} height={28} /> },
};

const unix = (s: number | null) => (s ? dateTime(s * 1000) : null);

export function Verify() {
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<"file" | "hash">(() => (normalizeHash(params.get("hash") ?? "") ? "hash" : "file"));
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [hashing, setHashing] = useState<number | null>(null);
  const [hash, setHash] = useState<string | null>(() => normalizeHash(params.get("hash") ?? ""));
  const [typed, setTyped] = useState(params.get("hash") ?? "");
  const [typedError, setTypedError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const result = useVerification(hash);

  useEffect(() => {
    const h = normalizeHash(params.get("hash") ?? "");
    if (h && h !== hash) { setHash(h); setTyped(h); setMode("hash"); }
    // only react to the URL changing, not to our own state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  async function onFiles([f]: File[]) {
    setFileError(null);
    setFile({ name: f.name, size: f.size });
    setHash(null);
    if (f.size === 0) return setFileError("This file is empty, so there is nothing to verify.");
    try {
      setHashing(0);
      const h = await sha256File(f, setHashing);
      setHash(h);
      setParams({}, { replace: true });
    } catch {
      setFileError("This file could not be read. Check that it is still available and try again.");
    } finally {
      setHashing(null);
    }
  }

  function submitTyped(e: React.FormEvent) {
    e.preventDefault();
    const h = normalizeHash(typed);
    if (!h) return setTypedError("Enter a SHA-256 fingerprint: 64 hexadecimal characters, optionally starting with 0x.");
    setTypedError(null);
    setFile(null);
    setHash(h);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Verify a document" description="Check whether a file matches a fingerprint registered on the blockchain. The file is hashed inside your browser and never uploaded." />

      <Card>
        <div className="px-5 pt-3">
          <Tabs label="Verification input" value={mode} onChange={setMode} tabs={[{ id: "file", label: "Upload a file" }, { id: "hash", label: "Paste a fingerprint" }]} />
        </div>
        <div className="p-5" role="tabpanel" id={`panel-${mode}`} aria-labelledby={`tab-${mode}`}>
          {mode === "file" ? (
            <div className="space-y-3">
              <FileDrop label="Choose the document to verify" hint="PDF, image, archive, text — any file. Hashed locally with SHA-256." onFiles={onFiles} disabled={hashing !== null} />
              {file && (
                <div className="flex items-center gap-3 rounded-md border border-line bg-surface2 px-3 py-2 text-sm">
                  <IconFile className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <span className="shrink-0 text-xs text-muted num">{bytes(file.size)}</span>
                </div>
              )}
              {hashing !== null && (
                <div role="status" aria-label="Computing fingerprint">
                  <div className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(hashing * 100)}%` }} /></div>
                  <p className="mt-1 text-xs text-muted">Computing SHA-256 fingerprint… {Math.round(hashing * 100)}%</p>
                </div>
              )}
              {fileError && <Alert tone="bad">{fileError}</Alert>}
            </div>
          ) : (
            <form onSubmit={submitTyped} className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="flex-1">
                <Field label="SHA-256 fingerprint" error={typedError} hint="As shown on a Verity record or proof file.">
                  <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" className="mono" />
                </Field>
              </div>
              <Button type="submit" className="sm:mt-[26px]">Verify</Button>
            </form>
          )}
        </div>
      </Card>

      {hash && (
        <div className="mt-6" aria-live="polite">
          {result.isLoading && <VerdictSkeleton />}
          {result.isError && <Alert tone="bad" title="Verification could not be completed">{(result.error as Error).message} No result was produced; this is not a "not verified" verdict.</Alert>}
          {result.data && <VerdictPanel hash={hash} data={result.data} />}
        </div>
      )}

      <Understanding />
    </div>
  );
}

function VerdictSkeleton() {
  return <Card className="p-6" ><div role="status" aria-label="Checking the registry" className="space-y-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div></Card>;
}

function VerdictPanel({ hash, data }: { hash: string; data: VerifyResult }) {
  const cfg = useAppConfig();
  const { chain, api } = data;
  const ui = VERDICT_UI[chain.verdict];
  const reg = api?.registration;
  const issuerName = reg?.issuer.organization_name;
  const tx = reg?.transaction_hash;
  const reason = api && !data.disagreement ? api.reason : DEFAULT_REASON[chain.verdict];

  return (
    <Card as="section" aria-labelledby="verdict-title" className="overflow-hidden">
      <div className={cx("flex items-start gap-4 border-b px-6 py-5", ui.tone)}>
        <span aria-hidden>{ui.icon}</span>
        <div className="min-w-0">
          <h2 id="verdict-title" className="text-xl font-bold tracking-wide">{ui.word}</h2>
          <p className="mt-1 text-sm text-ink2">{reason}</p>
        </div>
      </div>

      <div className="space-y-5 p-6">
        {data.disagreement && <Alert tone="warn" title="The API and the blockchain disagree">The result above comes from the blockchain contract, which is authoritative. The indexed details below may be out of date.</Alert>}
        {data.apiError && chain.verdict !== "not_verified" && <Alert tone="info" title="Some details are unavailable">The verdict was read directly from the blockchain, but the Verity API could not be reached for the organisation name and transaction details.</Alert>}
        {data.proofsUnavailable && <Alert tone="warn" title="Batch membership could not be checked">The proof service was unreachable, so this result cannot rule out that the document belongs to a registered batch. Try again shortly.</Alert>}

        <Facts items={[
          { label: "Document fingerprint (SHA-256)", value: <HashText value={hash} label="fingerprint" /> },
          ...(chain.issuer ? [
            { label: "Issued by", value: (
              <span>
                {issuerName ? <strong className="font-semibold">{issuerName}</strong> : <span className="text-muted">Unnamed issuer</span>}
                <span className="mono block text-muted">{chain.issuer}</span>
                {chain.issuerAuthorized === false && <span className="mt-1 block text-xs text-warn">No longer an authorised issuer. This registration predates the removal.</span>}
                {chain.issuerAuthorized === true && <span className="mt-1 block text-xs text-ok">Currently authorised by the registry</span>}
              </span>
            ) },
            { label: "Registered", value: unix(chain.registeredAt) },
          ] : []),
          ...(chain.kind === "document" ? [
            { label: "Version", value: `${chain.version} of ${chain.latestVersion}${chain.version === chain.latestVersion ? " (latest)" : ` — a newer version (${chain.latestVersion}) exists`}` },
            { label: "Document type", value: typeLabel(chain.documentType) },
          ] : []),
          ...(chain.kind === "batch" ? [{ label: "Registered in batch", value: <span>#{chain.batchId}<span className="mono block break-all text-muted">Merkle root {chain.merkleRoot}</span></span> }] : []),
          ...(reg?.title ? [{ label: "Title", value: reg.title }] : []),
          ...(chain.expiresAt ? [{ label: chain.verdict === "expired" ? "Expired" : "Expires", value: unix(chain.expiresAt) }] : []),
          ...(chain.revokedAt ? [{ label: "Revoked", value: <span>{unix(chain.revokedAt)}{reg?.revoked_by && <span className="mono block text-muted">by {shortAddr(reg.revoked_by)}</span>}</span> }] : []),
          ...(tx ? [{ label: "Registration transaction", value: <span className="inline-flex flex-wrap items-center gap-2"><HashText value={tx} short label="transaction hash" />{txUrl(cfg, tx) && <a className="text-accent underline" href={txUrl(cfg, tx)!} target="_blank" rel="noopener noreferrer">View on explorer</a>}</span> }] : []),
        ]} />

        {chain.verdict === "not_verified" && (
          <div className="rounded-md bg-surface2 p-4 text-sm text-ink2">
            <p className="font-medium text-ink">Why can verification fail?</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>The document was never registered with Verity.</li>
              <li>It was changed after registration, even by a single byte or by re-saving it. Fingerprints are exact.</li>
              <li>You are checking a different copy or format (for example a scan or a re-export) than the one that was registered.</li>
            </ul>
          </div>
        )}

        {chain.verdict !== "not_verified" && chain.kind === "document" && (
          <p className="text-sm"><Link className="text-accent underline" to={`/documents/${hash}`}>View full registration record and version history</Link></p>
        )}
        <p className="text-xs text-muted">Checked against contract <span className="mono">{shortAddr(cfg.registry_address)}</span> on {cfg.chain_name}. <StatusBadge status={chain.verdict} /></p>
      </div>
    </Card>
  );
}

const DEFAULT_REASON: Record<Verdict, string> = {
  verified: "This fingerprint is registered on the blockchain and has not been revoked.",
  revoked: "The issuer revoked this document. It must no longer be relied on.",
  expired: "The registration exists, but its validity period has ended.",
  not_verified: "No registration exists for this fingerprint.",
};

function Understanding() {
  return (
    <Card className="mt-8">
      <CardHeader title="What verification means" description="Verity answers narrow questions precisely. It does not answer every question." />
      <div className="grid gap-px bg-line sm:grid-cols-2">
        <div className="bg-surface p-5">
          <h3 className="text-sm font-semibold text-ok">A VERIFIED result tells you</h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-ink2">
            <li><strong>Integrity:</strong> your file is byte-for-byte identical to the one that was registered.</li>
            <li><strong>Origin:</strong> this wallet address registered that fingerprint, at the time shown.</li>
            <li><strong>Status:</strong> the issuer has not revoked it, as of the latest block.</li>
          </ul>
        </div>
        <div className="bg-surface p-5">
          <h3 className="text-sm font-semibold text-warn">It does not tell you</h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-ink2">
            <li><strong>Truth:</strong> that the document's claims are accurate.</li>
            <li><strong>Legitimacy:</strong> that the issuing organisation is who it says it is. The name is a label set by the registry's managers; confirm the issuer address through a channel you trust.</li>
            <li><strong>Authorship of content:</strong> only that the issuer vouched for this exact file.</li>
          </ul>
        </div>
      </div>
    </Card>
  );
}
