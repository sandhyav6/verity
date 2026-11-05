import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, usePublicClient, useWriteContract } from "wagmi";
import type { Abi } from "viem";
import { useAppConfig } from "../blockchain/config";
import { api } from "../lib/api";
import { humanizeError } from "../lib/errors";
import type { TransactionInfo } from "../lib/types";

export type TxPhase = "idle" | "awaiting_wallet" | "pending" | "confirmed" | "failed";
export interface TxState { phase: TxPhase; hash?: `0x${string}`; error?: string; slow?: boolean }

interface Call {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  /** react-query keys to refresh once the transaction is mined and indexed */
  invalidate?: (readonly unknown[])[];
}

const SLOW_AFTER_MS = 30_000;
const GIVE_UP_AFTER_MS = 5 * 60_000;

/** Resolves true once the backend indexer has processed the transaction's events (or false after `timeoutMs`). */
export async function waitForIndexed(hash: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await api.get<TransactionInfo>(`/transactions/${hash}`)).indexed) return true;
    } catch {
      /* transient API failure: keep polling until the deadline */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/**
 * Send ONE contract transaction with the full life cycle: simulate (a revert or failed gas estimate shows a readable
 * reason BEFORE the wallet opens) -> wallet confirmation -> wait for the receipt. "confirmed" is only reported after
 * a successful on-chain receipt. A ref blocks double submits even if the button is clicked twice in the same tick,
 * and a pending transaction can never hang forever: after 30 s the UI is told it is slow, after 5 min it stops waiting.
 */
export function useTx() {
  const cfg = useAppConfig();
  const publicClient = usePublicClient();
  const { address } = useConnection();
  const write = useWriteContract();
  const qc = useQueryClient();
  const [state, setState] = useState<TxState>({ phase: "idle" });
  const busy = useRef(false);
  const slowTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(slowTimer.current), []);

  const send = useCallback(
    async (call: Call): Promise<`0x${string}` | null> => {
      if (busy.current) return null;
      busy.current = true;
      setState({ phase: "awaiting_wallet" });
      try {
        await publicClient!.simulateContract({ account: address, address: call.address, abi: call.abi, functionName: call.functionName, args: call.args } as never);
        const hash = await write.mutateAsync({ address: call.address, abi: call.abi, functionName: call.functionName, args: call.args, chainId: cfg.chain_id } as never);
        setState({ phase: "pending", hash });
        slowTimer.current = window.setTimeout(() => setState((s) => (s.phase === "pending" ? { ...s, slow: true } : s)), SLOW_AFTER_MS);
        const receipt = await publicClient!.waitForTransactionReceipt({ hash, timeout: GIVE_UP_AFTER_MS });
        window.clearTimeout(slowTimer.current);
        if (receipt.status !== "success") {
          setState({ phase: "failed", hash, error: "The transaction was mined but reverted on-chain. Nothing was recorded." });
          return null;
        }
        setState({ phase: "confirmed", hash });
        void waitForIndexed(hash).then(() => {
          for (const key of call.invalidate ?? []) void qc.invalidateQueries({ queryKey: key });
        });
        return hash;
      } catch (e) {
        window.clearTimeout(slowTimer.current);
        setState((s) => ({ phase: "failed", hash: s.hash, error: s.hash && /timed out/i.test(String((e as Error)?.message)) ? `Still not confirmed after 5 minutes. The transaction may yet succeed; check ${s.hash} on a block explorer before retrying.` : humanizeError(e) }));
        return null;
      } finally {
        busy.current = false;
      }
    },
    [address, cfg.chain_id, publicClient, qc, write],
  );

  return { state, send, reset: () => setState({ phase: "idle" }), busy: state.phase === "awaiting_wallet" || state.phase === "pending" };
}
