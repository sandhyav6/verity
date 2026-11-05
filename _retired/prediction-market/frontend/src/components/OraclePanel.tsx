import { useState } from "react";
import { useReadContract } from "wagmi";
import { resolutionManagerAbi } from "../blockchain/abis";
import { addr, useAppConfig } from "../blockchain/config";
import { useResolution } from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { useTx } from "../hooks/useTx";
import { useWallet } from "../hooks/useWallet";
import { ApiError, api } from "../lib/api";
import { dateTime, shortAddr, shortHash, tokens } from "../lib/format";
import type { Market, ProposePrepared, Proposal } from "../lib/types";
import { EvidenceForm, blankEvidence, evidencePayload, evidenceProblem, type EvForm } from "./EvidenceForm";
import { Banner, Button, Card, Field, Pill, TxLink, inputCls } from "./ui";

const ARBITER_TIMEOUT_MS = 14 * 86400_000; // mirrors ResolutionManager.ARBITER_TIMEOUT

const apiUrl = (path: string) => `${import.meta.env.VITE_API_URL ?? "http://localhost:8000"}${path}`;

/**
 * Challenge, finalize, arbitrate and unwind a pending resolution (Stage 3). Every state change is an
 * on-chain transaction signed by the user's wallet; the backend only stores the evidence documents.
 * Deadlines are compared with the API's `server_time` so they match the contract's clock.
 */
export function OraclePanel({ market }: { market: Market }) {
  const cfg = useAppConfig();
  const w = useWallet();
  const auth = useAuth();
  const tx = useTx();
  const res = useResolution(market.id);
  const [ev, setEv] = useState<EvForm>({ ...blankEvidence(), proposed_outcome: "NO" });
  const [prepared, setPrepared] = useState<ProposePrepared | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<"YES" | "NO" | "INVALID">("YES");
  const [rationale, setRationale] = useState("");
  const [note, setNote] = useState<ProposePrepared | null>(null);
  const [busy, setBusy] = useState(false);

  const rm = addr(cfg.resolution_manager_address);
  const { data: arbiterRole } = useReadContract({ address: rm, abi: resolutionManagerAbi, functionName: "ARBITER_ROLE" });
  const { data: isArbiter } = useReadContract({ address: rm, abi: resolutionManagerAbi, functionName: "hasRole", args: arbiterRole && w.address ? [arbiterRole, w.address] : undefined, query: { enabled: !!arbiterRole && !!w.address } });
  const pending = res.data?.proposals.find((p: Proposal) => p.state === "proposed" || p.state === "disputed");
  // the dispute bond this proposal requires is fixed on-chain when it was proposed
  const { data: onchain } = useReadContract({ address: rm, abi: resolutionManagerAbi, functionName: "proposals", args: [addr(market.contract_address)], query: { enabled: !!pending, refetchInterval: 8000 } });
  if (market.status !== "closed" || !pending || !res.data) return null;

  const now = new Date(res.data.server_time).getTime();
  const windowOpen = new Date(pending.challenge_deadline).getTime() > now;
  const me = w.address?.toLowerCase();
  const isProposer = me === pending.resolver_address.toLowerCase();
  const disputeBond = onchain ? (onchain as readonly unknown[])[7] as bigint : undefined;
  const timedOut = pending.state === "disputed" && pending.disputed_at !== null && now >= new Date(pending.disputed_at).getTime() + ARBITER_TIMEOUT_MS;
  const ready = w.isConnected && !w.wrongNetwork;
  const refresh = [["resolution", market.id], ["market", market.id], ["markets"], ["evidence", market.id], ["portfolio"]] as (readonly unknown[])[];
  const marketAddr = addr(market.contract_address);

  async function api409<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true); setMsg(null);
    try { return await fn(); } catch (e) { setMsg(e instanceof ApiError ? (e.status === 401 ? "Sign in with your wallet first (top right)." : e.detail) : "Request failed."); } finally { setBusy(false); }
  }

  const prepareDispute = async () => {
    const problem = evidenceProblem(ev);
    if (problem) return setMsg(problem);
    const p = await api409(() => api.post<ProposePrepared>(`/resolutions/${market.id}/dispute`, evidencePayload(ev)));
    if (p) setPrepared(p);
  };
  const sendDispute = () => prepared && tx.send({ address: rm, abi: resolutionManagerAbi, functionName: "dispute", args: [marketAddr, prepared.evidence_hash as `0x${string}`, prepared.evidence_uri], label: `Dispute · market #${market.id}`, invalidate: refresh });
  const finalize = () => tx.send({ address: rm, abi: resolutionManagerAbi, functionName: "finalize", args: [marketAddr], label: `Finalize · market #${market.id}`, invalidate: [...refresh, ["overview"]] });
  const release = () => tx.send({ address: rm, abi: resolutionManagerAbi, functionName: "releaseBonds", args: [marketAddr], label: `Release bonds · market #${market.id}`, invalidate: refresh });
  const prepareNote = async () => {
    const n = await api409(() => api.post<ProposePrepared>(`/resolutions/${market.id}/arbitration-note`, { verdict, rationale, references: [] }));
    if (n) setNote(n);
  };
  const decide = () => note && tx.send({ address: rm, abi: resolutionManagerAbi, functionName: "arbitrate", args: [marketAddr, note.verdict, note.evidence_hash as `0x${string}`], label: `Arbitrate ${verdict} · market #${market.id}`, invalidate: [...refresh, ["overview"]] });

  return (
    <Card title="Challenge this result" subtitle={pending.state === "proposed" ? "A result has been proposed. Anyone can dispute it before the challenge window ends." : "This result is disputed and waiting for the arbiter."}>
      <div className="space-y-3 text-sm">
        <p><Pill tone={pending.state === "disputed" ? "warn" : "neutral"}>{pending.state === "disputed" ? "⚖ disputed" : "◐ proposed"}</Pill>{" "}
          <strong>{pending.proposed_outcome}</strong> by <span className="num-col">{shortAddr(pending.resolver_address)}</span>{" "}
          {pending.bond !== "0" ? <>with a bond of <span className="num-col">{tokens(pending.bond)}</span> test tokens</> : <>(trusted resolver, no bond)</>}</p>
        <p className="text-ink2">Evidence <span className="num-col">{shortHash(pending.evidence_hash)}</span>{" "}
          {pending.evidence_available && <a className="text-accent underline" href={apiUrl(`/resolutions/${market.id}/evidence/${pending.evidence_hash}`)} target="_blank" rel="noreferrer">view</a>}</p>

        {pending.state === "proposed" && (
          <p className="text-ink2">{windowOpen ? <>Challenge window ends <strong>{dateTime(pending.challenge_deadline)}</strong>.</> : <>The challenge window ended {dateTime(pending.challenge_deadline)}.</>}</p>
        )}

        {pending.state === "disputed" && (
          <div className="rounded-lg border border-edge p-3">
            <p>Disputed by <span className="num-col">{shortAddr(pending.disputer_address ?? "")}</span> with a bond of <span className="num-col">{tokens(pending.dispute_bond)}</span> test tokens{pending.disputed_at ? `, ${dateTime(pending.disputed_at)}` : ""}.</p>
            {pending.dispute_evidence_hash && <p className="mt-1 text-xs text-ink2">Their evidence <span className="num-col">{shortHash(pending.dispute_evidence_hash)}</span> {pending.dispute_evidence_available && <a className="text-accent underline" href={apiUrl(`/resolutions/${market.id}/evidence/${pending.dispute_evidence_hash}`)} target="_blank" rel="noreferrer">view</a>}</p>}
            <p className="mt-2 text-xs text-ink2">A single trusted arbiter decides. Whoever loses forfeits their bond to the other side. This is not a decentralized vote.</p>
          </div>
        )}

        {/* ---- dispute */}
        {pending.state === "proposed" && windowOpen && (
          !ready ? <Banner>Connect your wallet on {cfg.chain_name} to dispute.</Banner>
            : isProposer ? <Banner>You made this proposal, so you cannot dispute it.</Banner>
            : !auth.signedIn ? <Banner tone="warn">Sign in (top right) to prepare a dispute.</Banner>
            : (
              <details className="rounded-lg border border-edge p-3"><summary className="cursor-pointer font-medium text-accent">Dispute this result{disputeBond !== undefined ? ` (bond ${tokens(disputeBond)} test tokens)` : ""}</summary>
                <p className="mt-2 text-xs text-ink2">You will escrow a matching bond. If the arbiter agrees with you, you win the proposer's bond too; if not, you lose yours. Test tokens have no monetary value.</p>
                <div className="mt-3"><EvidenceForm value={ev} onChange={(v) => { setEv(v); setPrepared(null); }} outcomeLabel="Outcome you say is correct" /></div>
                <Button className="mt-3" onClick={prepareDispute} disabled={busy}>1. Store my evidence</Button>
                {prepared && <div className="mt-3 rounded-lg border border-edge p-3"><p className="text-xs">Evidence hash <span className="num-col break-all">{prepared.evidence_hash}</span></p>
                  <Button className="mt-2" variant="no" onClick={sendDispute} disabled={tx.busy}>{tx.state.phase === "awaiting_wallet" ? "Confirm in wallet…" : "2. Post bond and dispute"}</Button></div>}
              </details>
            )
        )}

        {/* ---- finalize an undisputed result */}
        {pending.state === "proposed" && !windowOpen && <Button onClick={finalize} disabled={!ready || tx.busy}>Finalize this result</Button>}

        {/* ---- arbiter */}
        {pending.state === "disputed" && isArbiter === true && ready && (
          <div className="rounded-lg border-2 border-line p-3">
            <p className="font-medium">You are the arbiter</p>
            <div className="mt-2 grid gap-3">
              <Field label="Your ruling"><select className={inputCls} value={verdict} onChange={(e) => { setVerdict(e.target.value as typeof verdict); setNote(null); }}>{["YES", "NO", "INVALID"].map((o) => <option key={o}>{o}</option>)}</select></Field>
              <Field label="Reasoning (at least 30 characters)" hint="Refer to both parties' evidence. It is stored and hashed on-chain."><textarea className={inputCls} rows={3} value={rationale} onChange={(e) => { setRationale(e.target.value); setNote(null); }} /></Field>
            </div>
            <Button className="mt-2" onClick={prepareNote} disabled={busy || rationale.trim().length < 30}>1. Store reasoning</Button>
            {note && <Button className="ml-2 mt-2" onClick={decide} disabled={tx.busy}>{tx.state.phase === "awaiting_wallet" ? "Confirm in wallet…" : "2. Decide on-chain"}</Button>}
          </div>
        )}
        {pending.state === "disputed" && isArbiter !== true && <p className="text-xs text-muted">Only the arbiter can decide. If no decision is made within 14 days, anyone can unwind the dispute and every bond is returned.</p>}

        {/* ---- liveness */}
        {timedOut && <div><Banner tone="warn">The arbiter has not decided within 14 days. Anyone can now unwind this dispute and return each party's own bond.</Banner><Button className="mt-2" variant="secondary" onClick={release} disabled={!ready || tx.busy}>Release bonds</Button></div>}

        {msg && <Banner tone="error">{msg}</Banner>}
        {tx.state.phase === "pending" && tx.state.hash && <Banner>Submitted <TxLink hash={tx.state.hash} />…</Banner>}
        {tx.state.phase === "confirmed" && <Banner tone="ok">Confirmed on-chain. The page updates once the indexer sees it.</Banner>}
        {tx.state.phase === "failed" && <Banner tone="error">{tx.state.error}</Banner>}
      </div>
    </Card>
  );
}
