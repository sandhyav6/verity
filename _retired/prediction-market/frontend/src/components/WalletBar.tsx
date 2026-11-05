import { useReadContract } from "wagmi";
import { addr, useAppConfig } from "../blockchain/config";
import { testTokenAbi } from "../blockchain/abis";
import { DEV_WALLET_ACTIVE } from "../dev/devWallet";
import { useAuth } from "../hooks/useAuth";
import { useTx } from "../hooks/useTx";
import { useWallet } from "../hooks/useWallet";
import { shortAddr, tokens } from "../lib/format";
import { Button } from "./ui";

export function TokenBalance({ address }: { address: `0x${string}` }) {
  const cfg = useAppConfig();
  const { data } = useReadContract({ address: addr(cfg.token_address), abi: testTokenAbi, functionName: "balanceOf", args: [address], query: { refetchInterval: 6000 } });
  return <span className="num-col" title="Your TEST token balance (no monetary value)">{data === undefined ? "…" : tokens(data as bigint)} tTOKEN</span>;
}

export function FaucetButton() {
  const cfg = useAppConfig();
  const { state, send } = useTx();
  return (
    <div className="flex flex-col items-start">
      <Button variant="secondary" disabled={state.phase === "awaiting_wallet" || state.phase === "pending"} onClick={() => send({ address: addr(cfg.token_address), abi: testTokenAbi, functionName: "faucet", label: "Faucet: claim test tokens" })}>
        {state.phase === "awaiting_wallet" ? "Confirm in wallet…" : state.phase === "pending" ? "Claiming…" : "Get test tokens"}
      </Button>
      {state.phase === "failed" && <span className="mt-1 max-w-64 text-xs text-crit" role="alert">{state.error}</span>}
      {state.phase === "confirmed" && <span className="mt-1 text-xs text-goodtext" role="status">✓ 1,000 test tokens added</span>}
    </div>
  );
}

/** Connect / network / sign-in controls. All wallet state flows through useWallet() and useAuth(). */
export function WalletBar() {
  const w = useWallet();
  const auth = useAuth();
  const cfg = useAppConfig();

  if (!w.isConnected) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button onClick={w.connect} disabled={w.connecting || !w.hasInjectedWallet}>{w.connecting ? "Connecting…" : "Connect wallet"}</Button>
        {!w.hasInjectedWallet && <span className="text-xs text-ink2">No wallet found. Install MetaMask to trade.</span>}
        {w.error && <span className="max-w-64 text-xs text-crit" role="alert">{w.error}</span>}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {DEV_WALLET_ACTIVE.index !== null && <span className="rounded bg-warn px-1.5 py-0.5 text-xs font-medium text-black" title="Local development wallet: forwards to the Hardhat node">DEV WALLET #{DEV_WALLET_ACTIVE.index}</span>}
      {w.wrongNetwork ? (
        <Button variant="secondary" onClick={w.switchNetwork} disabled={w.switching}>⚠ Wrong network: switch to {cfg.chain_name}</Button>
      ) : (
        <>
          <span className="hidden text-sm text-ink2 sm:inline">{w.address && <TokenBalance address={w.address} />}</span>
          {auth.signedIn ? <span className="text-xs text-goodtext" title="Signed in with your wallet (SIWE)">✓ signed in</span> : <Button variant="secondary" onClick={() => auth.signIn()} disabled={auth.signingIn}>{auth.signingIn ? "Check your wallet…" : "Sign in"}</Button>}
        </>
      )}
      <span className="num-col rounded-lg border border-line px-2 py-1.5 text-sm" title={w.address}>{shortAddr(w.address ?? "")}</span>
      <Button variant="ghost" onClick={() => { auth.signOut(); w.disconnect(); }}>Disconnect</Button>
      {auth.signInError && <span className="w-full text-right text-xs text-crit" role="alert">{auth.signInError}</span>}
    </div>
  );
}
