import { useState } from "react";
import { Link } from "react-router-dom";
import { useReadContract } from "wagmi";
import { resolutionManagerAbi } from "../blockchain/abis";
import { addr, useAppConfig } from "../blockchain/config";
import { EvidenceForm, blankEvidence, evidencePayload, evidenceProblem, type EvForm } from "../components/EvidenceForm";
import { Banner, Button, Card, Empty, ErrorState, Field, Loading, Pill, Table, Td, TxLink, inputCls } from "../components/ui";
import { useDataSources, useMarkets, useResolution } from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { useTx } from "../hooks/useTx";
import { useWallet } from "../hooks/useWallet";
import { ApiError, api } from "../lib/api";
import { dateTime, relative, shortHash, tokens } from "../lib/format";
import type { Draft, Market, ProposePrepared } from "../lib/types";

function ResolveCard({ m, canResolve, canBond, bond }: { m: Market; canResolve: boolean; canBond: boolean; bond: bigint | undefined }) {
  const cfg = useAppConfig();
  const tx = useTx();
  const res = useResolution(m.id);
  const [ev, setEv] = useState<EvForm>(blankEvidence());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [prepared, setPrepared] = useState<ProposePrepared | null>(null);
  const [msg, setMsg] = useState<{ tone: "error" | "ok" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = res.data?.proposals.find((p) => p.state === "proposed" || p.state === "disputed");
  const rm = addr(cfg.resolution_manager_address);
  // compare with the API's clock (block time), not the browser's, so deadlines match the contract
  const waiting = !!pending && new Date(pending.challenge_deadline) > new Date(res.data?.server_time ?? Date.now());
  const bonded = !canResolve && canBond; // anyone else proposes with a bond
  const canPropose = canResolve || canBond;

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true); setMsg(null);
    try { return await fn(); } catch (e) { setMsg({ tone: "error", text: e instanceof ApiError ? e.detail : e instanceof Error ? e.message : "Failed" }); } finally { setBusy(false); }
  }

  const getDraft = () => run(async () => {
    const d = await api.post<Draft>(`/resolutions/${m.id}/draft-from-data`);
    setDraft(d);
    const e = d.evidence as Record<string, string | null>;
    setEv({ proposed_outcome: d.suggested_outcome, source_name: e.source_name ?? "", source_url: e.source_url ?? "", evidence_retrieved_at: (e.evidence_retrieved_at ?? "").slice(0, 16), observation_period: e.observation_period ?? "", raw_evidence_reference: e.raw_evidence_reference ?? "", raw_evidence_hash: e.raw_evidence_hash ?? "", normalized_result: e.normalized_result ?? "", unit: e.unit ?? "", notes: e.notes ?? "" });
    setMsg({ tone: "info", text: "Draft loaded from the data source. Review every field before you prepare the evidence." });
  });

  const prepare = () => run(async () => {
    const problem = evidenceProblem(ev);
    if (problem) { setMsg({ tone: "error", text: problem }); return; }
    setPrepared(await api.post<ProposePrepared>(`/resolutions/${m.id}/propose${bonded ? "?bonded=true" : ""}`, evidencePayload(ev)));
    setMsg({ tone: "ok", text: "Evidence stored and hashed. Nothing is proposed until you submit it on-chain below." });
  });

  const invalidate = [["resolution", m.id], ["market", m.id], ["markets"], ["overview"]] as (readonly unknown[])[];
  const submit = async () => {
    if (!prepared) return;
    await tx.send({
      address: rm, abi: resolutionManagerAbi, functionName: bonded ? "proposeBonded" : "propose",
      args: [addr(m.contract_address), prepared.verdict, prepared.evidence_hash as `0x${string}`, prepared.evidence_uri],
      label: `${bonded ? "Propose with bond" : "Propose"} ${ev.proposed_outcome} · market #${m.id}`, invalidate,
    });
  };
  const finalize = () => tx.send({ address: rm, abi: resolutionManagerAbi, functionName: "finalize", args: [addr(m.contract_address)], label: `Finalize · market #${m.id}`, invalidate });

  return (
    <Card title={<Link className="hover:underline" to={`/markets/${m.id}`}>#{m.id} {m.question}</Link>} subtitle={`Closed ${relative(m.trading_close_time)} · resolution deadline ${dateTime(m.resolution_deadline)}`}>
      <div className="flex flex-wrap gap-2 text-xs"><Pill>{m.category}</Pill><Pill tone={m.data_rule ? "good" : "neutral"}>{m.data_rule ? "has automatic data rule" : "manual evidence only"}</Pill><Pill>{m.trade_count} trades</Pill></div>

      {pending && (
        <div className="mt-3 rounded-lg border border-edge p-3 text-sm">
          <p><strong>{pending.state === "disputed" ? "Disputed" : "Proposal pending"}:</strong> {pending.proposed_outcome} · evidence <span className="num-col">{shortHash(pending.evidence_hash)}</span>
            {pending.bond !== "0" && <> · bond {tokens(pending.bond)} tokens</>} · challenge window ends {dateTime(pending.challenge_deadline)}</p>
          {pending.state === "disputed"
            ? <p className="mt-1 text-ink2">Waiting for the arbiter. <Link className="text-accent underline" to={`/markets/${m.id}`}>Open the market</Link> to see both sides' evidence and to arbitrate.</p>
            : <>
                <Button className="mt-2" disabled={tx.busy || waiting} onClick={finalize}>{waiting ? "Waiting for challenge window" : "Finalize resolution"}</Button>
                {waiting && <p className="mt-1 text-xs text-ink2">Anyone can still dispute this on <Link className="text-accent underline" to={`/markets/${m.id}`}>the market page</Link>.</p>}
              </>}
        </div>
      )}

      {canPropose && !pending && (
        <div className="mt-3 space-y-3">
          {bonded && <Banner>You do not hold the resolver role, but anyone can propose a result by escrowing a bond{bond !== undefined ? ` of ${tokens(bond)} test tokens` : ""}. The bond comes back if nobody disputes you or the arbiter agrees with you; if the arbiter rules against you, the challenger gets it. Test tokens have no monetary value.</Banner>}
          {canResolve && m.data_rule && <Button variant="secondary" onClick={getDraft} disabled={busy}>Draft outcome from {m.data_rule.provider} data</Button>}
          {draft && <Banner tone="warn"><strong>Suggested: {draft.suggested_outcome}</strong> (human review required). {draft.warnings.join(" ")}</Banner>}
          <details open={!!draft}><summary className="cursor-pointer text-sm font-medium text-accent">Evidence for the proposed outcome</summary>
            <div className="mt-3"><EvidenceForm value={ev} onChange={(v) => { setEv(v); setPrepared(null); }} /></div>
            <Button className="mt-3" onClick={prepare} disabled={busy}>1. Store evidence &amp; get hash</Button>
          </details>
          {prepared && (
            <div className="rounded-lg border border-edge p-3 text-sm">
              <p>Evidence hash <span className="num-col break-all">{prepared.evidence_hash}</span></p>
              <Button className="mt-2" onClick={submit} disabled={tx.busy}>{tx.state.phase === "awaiting_wallet" ? "Confirm in wallet…" : bonded ? "2. Post bond and propose on-chain" : "2. Submit proposal on-chain"}</Button>
            </div>
          )}
        </div>
      )}
      {!canPropose && !pending && <p className="mt-3 text-sm text-ink2">Connect and sign in to propose a result. Resolvers propose directly; anyone else can propose with a bond.</p>}
      <div className="mt-3 space-y-2">
        {msg && <Banner tone={msg.tone === "error" ? "error" : msg.tone === "ok" ? "ok" : "info"}>{msg.text}</Banner>}
        {tx.state.phase === "pending" && tx.state.hash && <Banner>Submitted <TxLink hash={tx.state.hash} />…</Banner>}
        {tx.state.phase === "confirmed" && <Banner tone="ok">Confirmed on-chain.</Banner>}
        {tx.state.phase === "failed" && <Banner tone="error">{tx.state.error}</Banner>}
      </div>
    </Card>
  );
}

function ManualData() {
  const [f, setF] = useState({ provider: "rbi", metric: "policy_repo_rate", source_url: "", document_sha256: "", retrieved_at: new Date().toISOString().slice(0, 16), observed_at: "", publication_date: "", period_start: "", period_end: "", value: "", text: "", location: "", notes: "" });
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const nul = (v: string) => (v === "" ? null : v);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await api.post<{ outcome: string; record: { id: number } }>("/data/submissions", {
        ...f, retrieved_at: new Date(f.retrieved_at).toISOString(), observed_at: new Date(f.observed_at || f.retrieved_at).toISOString(),
        publication_date: nul(f.publication_date), period_start: nul(f.period_start), period_end: nul(f.period_end), value: nul(f.value), text: nul(f.text), location: nul(f.location), notes: nul(f.notes),
      });
      setMsg({ tone: "ok", text: `Record #${r.record.id} ${r.outcome}.` });
    } catch (err) { setMsg({ tone: "error", text: err instanceof ApiError ? err.detail : "Failed" }); }
  }
  return (
    <Card title="Enter a record from an official document" subtitle="For sources this site does not crawl (RBI, MoSPI, ISRO, cricket boards). Download and archive the document yourself, hash it, and transcribe the value. It will be labelled as manually entered.">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Provider"><select className={inputCls} value={f.provider} onChange={(e) => set("provider", e.target.value)}>{["rbi", "mospi", "isro", "bcci", "espncricinfo"].map((p) => <option key={p}>{p}</option>)}</select></Field>
        <Field label="Metric" hint="e.g. policy_repo_rate, cpi_inflation_yoy, mission_milestone, match_result"><input className={inputCls} value={f.metric} onChange={(e) => set("metric", e.target.value)} /></Field>
        <Field label="Official document URL (https)"><input className={inputCls} value={f.source_url} onChange={(e) => set("source_url", e.target.value)} /></Field>
        <Field label="SHA-256 of the archived document"><input className={inputCls} value={f.document_sha256} onChange={(e) => set("document_sha256", e.target.value)} /></Field>
        <Field label="Value (numbers)"><input className={inputCls} value={f.value} onChange={(e) => set("value", e.target.value)} /></Field>
        <Field label="Text (milestones, results)"><input className={inputCls} value={f.text} onChange={(e) => set("text", e.target.value)} /></Field>
        <Field label="Retrieved at"><input type="datetime-local" className={inputCls} value={f.retrieved_at} onChange={(e) => set("retrieved_at", e.target.value)} /></Field>
        <Field label="Observed at"><input type="datetime-local" className={inputCls} value={f.observed_at} onChange={(e) => set("observed_at", e.target.value)} /></Field>
        <Field label="Publication date"><input type="date" className={inputCls} value={f.publication_date} onChange={(e) => set("publication_date", e.target.value)} /></Field>
        <Field label="Period start / end"><div className="flex gap-2"><input type="date" className={inputCls} value={f.period_start} onChange={(e) => set("period_start", e.target.value)} /><input type="date" className={inputCls} value={f.period_end} onChange={(e) => set("period_end", e.target.value)} /></div></Field>
        <div className="sm:col-span-2"><Button type="submit">Save record</Button></div>
        {msg && <div className="sm:col-span-2"><Banner tone={msg.tone}>{msg.text}</Banner></div>}
      </form>
    </Card>
  );
}

export function Admin() {
  const cfg = useAppConfig();
  const w = useWallet();
  const auth = useAuth();
  const closed = useMarkets({ status: "closed", sort: "closing", order: "asc", limit: 50 });
  const done = useMarkets({ status: "resolved", sort: "created_at", order: "desc", limit: 10 });
  const sources = useDataSources();
  const rm = addr(cfg.resolution_manager_address);
  const { data: role } = useReadContract({ address: rm, abi: resolutionManagerAbi, functionName: "RESOLVER_ROLE" });
  const { data: isResolver } = useReadContract({ address: rm, abi: resolutionManagerAbi, functionName: "hasRole", args: role && w.address ? [role, w.address] : undefined, query: { enabled: !!role && !!w.address } });
  const { data: bond } = useReadContract({ address: rm, abi: resolutionManagerAbi, functionName: "bondAmount" });
  const { data: bondedWindow } = useReadContract({ address: rm, abi: resolutionManagerAbi, functionName: "bondedChallengeWindow" });
  const canResolve = !!isResolver && auth.signedIn;
  const canBond = auth.signedIn && w.isConnected && !w.wrongNetwork;

  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-semibold">Resolution dashboard</h1>
        <p className="mt-1 text-sm text-ink2">A result is proposed with documented evidence (by a trusted resolver, or by anyone who escrows a test-token bond). It becomes final after a challenge window unless someone disputes it with a matching bond; a disputed result is decided by a single trusted arbiter. <strong>This is not a decentralized oracle.</strong> Bonds discourage careless or frivolous claims; they do not make the final ruling trustless, and an undisputed false result is accepted. The contracts enforce who can do what.</p>
        {bond !== undefined && <p className="mt-1 text-xs text-muted">Current bond: {tokens(bond as bigint)} test tokens · challenge window for bonded proposals: {bondedWindow !== undefined ? `${Math.round(Number(bondedWindow) / 60)} min` : "…"}</p>}</div>

      {!w.isConnected ? <Banner tone="warn">Connect a wallet. You can read this page without one, but only signed-in wallets can act.</Banner>
        : !auth.signedIn ? <Banner tone="warn">Sign in (top right) to use backend tools.</Banner>
        : isResolver ? <Banner tone="ok">Your wallet holds the resolver role: you can propose without a bond.</Banner> : <Banner>Your wallet is not a resolver. You can still propose a result with a bond, or dispute others' proposals on the market page{auth.isAdmin ? ", and enter source records below" : ""}.</Banner>}

      <section className="space-y-3"><h2 className="text-lg font-semibold">Awaiting resolution</h2>
        {closed.isLoading ? <Loading /> : closed.error ? <ErrorState error={closed.error} /> : !closed.data?.items.length ? <Empty title="No market is waiting for a result">Markets appear here after trading closes and before they are resolved.</Empty> : closed.data.items.map((m) => <ResolveCard key={m.id} m={m} canResolve={canResolve} canBond={canBond} bond={bond as bigint | undefined} />)}
      </section>

      <Card title="Evidence retrieval status" subtitle="What the data worker holds for each source.">
        {sources.isLoading ? <Loading /> : sources.error ? <ErrorState error={sources.error} /> : (
          <Table head={["Provider", "Access", "Records", "Freshness", "Last retrieved"]}>
            {sources.data!.map((s) => <tr key={s.provider}><Td>{s.provider}</Td><Td>{s.mode}</Td><Td className="num-col">{s.records}</Td><Td>{s.freshness}</Td><Td>{s.last_retrieved_at ? dateTime(s.last_retrieved_at) : "-"}</Td></tr>)}
          </Table>
        )}
      </Card>

      <Card title="Resolution history">
        {!done.data?.items.length ? <p className="text-sm text-ink2" role="status">No market has been resolved yet.</p> : (
          <Table head={["Market", "Outcome", "Resolved"]}>{done.data.items.map((m) => <tr key={m.id}><Td><Link className="hover:underline" to={`/markets/${m.id}`}>{m.question.slice(0, 70)}</Link></Td><Td>{m.winning_outcome}</Td><Td>{m.resolved_at ? dateTime(m.resolved_at) : "-"}</Td></tr>)}</Table>
        )}
      </Card>

      {auth.isAdmin ? <ManualData /> : <p className="text-xs text-muted">Entering records from official documents requires an administrator account.</p>}
      <p className="text-xs text-muted">Resolution manager {cfg.resolution_manager_address}</p>
    </div>
  );
}
