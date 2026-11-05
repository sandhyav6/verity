import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useReadContract } from "wagmi";
import { marketFactoryAbi, testTokenAbi } from "../blockchain/abis";
import { addr, useAppConfig } from "../blockchain/config";
import { Banner, Button, Card, Empty, Field, TxLink, inputCls } from "../components/ui";
import { useAuth } from "../hooks/useAuth";
import { useTx } from "../hooks/useTx";
import { useWallet } from "../hooks/useWallet";
import { ApiError, api } from "../lib/api";
import { tokens } from "../lib/format";
import { EMPTY_FORM, subsidyEstimate, toPayload, validateMarketForm, type FormErrors, type MarketForm } from "../lib/marketForm";
import type { CreatePrepared, Market, Page } from "../lib/types";

export function CreateMarket() {
  const cfg = useAppConfig();
  const w = useWallet();
  const auth = useAuth();
  const tx = useTx();
  const [f, setF] = useState<MarketForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [prepared, setPrepared] = useState<CreatePrepared | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [step, setStep] = useState<"idle" | "registering">("idle");

  const { data: role } = useReadContract({ address: addr(cfg.factory_address), abi: marketFactoryAbi, functionName: "CREATOR_ROLE" });
  const { data: allowed } = useReadContract({ address: addr(cfg.factory_address), abi: marketFactoryAbi, functionName: "hasRole", args: role && w.address ? [role, w.address] : undefined, query: { enabled: !!role && !!w.address } });
  const { data: balance } = useReadContract({ address: addr(cfg.token_address), abi: testTokenAbi, functionName: "balanceOf", args: w.address ? [w.address] : undefined, query: { enabled: !!w.address } });

  const b = Number(f.liquidity);
  const subsidy = Number.isFinite(b) ? subsidyEstimate(b) : 0;
  const set = <K extends keyof MarketForm>(k: K, v: MarketForm[K]) => { setF((p) => ({ ...p, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };
  const text = (k: keyof MarketForm, label: string, hint?: string, area = false) => (
    <Field label={label} hint={hint} error={errors[k]}>
      {area ? <textarea className={inputCls} rows={3} value={f[k] as string} onChange={(e) => set(k, e.target.value as never)} />
        : <input className={inputCls} value={f[k] as string} onChange={(e) => set(k, e.target.value as never)} />}
    </Field>
  );

  const created = useQuery({
    queryKey: ["created", prepared?.metadata_hash],
    queryFn: async () => (await api.get<Page<Market>>("/markets", { sort: "created_at", order: "desc", limit: 10 })).items.find((m) => m.metadata_hash === prepared!.metadata_hash) ?? null,
    enabled: !!prepared && tx.state.phase === "confirmed", refetchInterval: (q) => (q.state.data ? false : 2000),
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setApiError(null);
    const errs = validateMarketForm(f);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setStep("registering");
    try {
      // 1. store the definition off-chain; the backend returns the hash and exact on-chain parameters
      const p = await api.post<CreatePrepared>("/markets", toPayload(f));
      setPrepared(p);
      // 2. the creator's own wallet creates the market (the backend cannot)
      const fp = p.factory_params;
      await tx.send({
        address: addr(cfg.factory_address), abi: marketFactoryAbi, functionName: "createMarket",
        args: [{ metadataHash: fp.metadataHash as `0x${string}`, category: fp.category, tradingClose: BigInt(fp.tradingClose), resolutionDeadline: BigInt(fp.resolutionDeadline), liquidityB: BigInt(fp.liquidityB) }],
        label: `Create market: ${f.question.slice(0, 40)}`, invalidate: [["markets"], ["overview"]],
      });
    } catch (err) {
      setApiError(err instanceof ApiError ? (err.status === 401 ? "Sign in with your wallet first (top right)." : err.detail) : "Could not register the market definition.");
    } finally {
      setStep("idle");
    }
  }

  if (!w.isConnected) return <Empty title="Connect a wallet to create a market" action={<Button onClick={w.connect}>Connect wallet</Button>}>Only wallets approved as market creators can create markets.</Empty>;

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div><h1 className="text-2xl font-semibold">Create a market</h1>
        <p className="mt-1 text-sm text-ink2">A market must be answerable YES or NO from a named source, using only information that will exist before the resolution deadline. If a reasonable person could argue either way after the fact, rewrite it.</p></div>

      {allowed === false && <Banner tone="warn">This wallet does not hold the market-creator role, so the on-chain step will be rejected. Creator access is granted by the deployment administrator (it prevents spam and ambiguous markets).</Banner>}
      {!auth.signedIn && <Banner tone="warn">You also need to <strong>sign in</strong> (top right) so the backend can store the market definition.</Banner>}
      {w.wrongNetwork && <Banner tone="warn">Switch your wallet to {cfg.chain_name} first.</Banner>}

      <Card title="The question">
        <div className="grid gap-4">
          {text("question", "Question", "A single YES/NO question ending with “?”")}
          {text("description", "Description", "Background a trader needs.", true)}
          <Field label="Category" error={errors.category}>
            <select className={inputCls} value={f.category} onChange={(e) => set("category", e.target.value)}>{["economy", "weather", "sports", "technology"].map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}</select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">{text("yesDefinition", "YES means…")}{text("noDefinition", "NO means…")}</div>
        </div>
      </Card>

      <Card title="How it is resolved" subtitle="Every field is required: a market that cannot be resolved objectively should not be created.">
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">{text("sourceName", "Source name", "e.g. Open-Meteo Historical Weather API")}{text("sourceUrl", "Source web address")}</div>
          {text("sourceDataset", "Exact dataset / station / table", "e.g. daily precipitation_sum, ERA5 model, point 13.08N 80.27E")}
          {text("criteria", "Resolution criteria", "Precisely how the outcome is computed, including the threshold.", true)}
          <div className="grid gap-4 sm:grid-cols-2">{text("measurement", "What is measured")}{text("unit", "Unit")}</div>
          {text("observationPeriod", "Observation period", "e.g. 1 November to 30 November 2026 inclusive")}
          {text("revisionPolicy", "Revision policy", "Does the first published value or a later revision count?")}
          {text("missingDataPolicy", "If data is missing", "e.g. the market is voided after the deadline and traders are refunded")}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Trading closes" error={errors.closeAt}><input type="datetime-local" className={inputCls} value={f.closeAt} onChange={(e) => set("closeAt", e.target.value)} /></Field>
            <Field label="Resolution deadline" error={errors.deadlineAt}><input type="datetime-local" className={inputCls} value={f.deadlineAt} onChange={(e) => set("deadlineAt", e.target.value)} /></Field>
          </div>
        </div>
      </Card>

      {f.category === "weather" && (
        <Card title="Automatic data rule (optional)" subtitle="Lets the resolution tool draft an outcome from Open-Meteo reanalysis data. A human still reviews and submits it.">
          <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.useRule} onChange={(e) => set("useRule", e.target.checked)} />Resolve this market from Open-Meteo precipitation data</label>
          {errors.useRule && <p className="text-xs text-crit" role="alert">{errors.useRule}</p>}
          {f.useRule && (
            <div className="grid gap-4 sm:grid-cols-3">
              {text("location", "Place name")}{text("latitude", "Latitude")}{text("longitude", "Longitude")}
              <Field label="Period start" error={errors.ruleEnd}><input type="date" className={inputCls} value={f.ruleStart} onChange={(e) => set("ruleStart", e.target.value)} /></Field>
              <Field label="Period end"><input type="date" className={inputCls} value={f.ruleEnd} onChange={(e) => set("ruleEnd", e.target.value)} /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="YES if total is"><select className={inputCls} value={f.operator} onChange={(e) => set("operator", e.target.value)}>{[">", ">=", "<", "<="].map((o) => <option key={o}>{o}</option>)}</select></Field>
                {text("threshold", "Threshold (mm)")}
              </div>
              <p className="text-xs text-ink2 sm:col-span-3">The value comes from a weather <em>model</em> on a ~25 km grid (ERA5), not a rain gauge, and the latest ~6 days are not available yet. Do not describe it as official station data.</p>
            </div>
          )}
        </Card>
      )}

      <Card title="Liquidity and funding">
        <Field label="Liquidity parameter b (tokens)" hint="Higher b = prices move less per trade. Allowed: 10 to 100,000." error={errors.liquidity}>
          <input className={`${inputCls} max-w-xs`} inputMode="numeric" value={f.liquidity} onChange={(e) => set("liquidity", e.target.value)} />
        </Field>
        <p className="mt-2 text-sm text-ink2">You fund the market maker's maximum possible loss: about <strong className="num-col">{subsidy.toFixed(2)}</strong> test tokens (b × ln 2). You get back whatever is not needed after settlement. Your balance: <span className="num-col">{balance !== undefined ? tokens(balance as bigint) : "…"}</span>{balance !== undefined && Number(balance) / 1e18 < subsidy && <span className="text-crit"> (not enough; use “Get test tokens” or ask the administrator)</span>}</p>
      </Card>

      <div className="space-y-2">
        <Button type="submit" disabled={tx.busy || step === "registering" || w.wrongNetwork}>
          {step === "registering" ? "Saving definition…" : tx.state.phase === "awaiting_wallet" ? "Confirm in your wallet…" : tx.state.phase === "pending" ? "Creating on-chain…" : "Create market"}
        </Button>
        {Object.keys(errors).length > 0 && <p className="text-sm text-crit" role="alert">Please fix the {Object.keys(errors).length} highlighted field(s).</p>}
        {apiError && <Banner tone="error">{apiError}</Banner>}
        {tx.state.phase === "pending" && tx.state.hash && <Banner>Submitted <TxLink hash={tx.state.hash} />…</Banner>}
        {tx.state.phase === "failed" && <Banner tone="error">{tx.state.error}</Banner>}
        {tx.state.phase === "confirmed" && <Banner tone="ok">{created.data ? <>Market created. <Link className="underline" to={`/markets/${created.data.id}`}>Open market #{created.data.id}</Link></> : "Created on-chain. Waiting for the indexer to pick it up…"}</Banner>}
      </div>
    </form>
  );
}
