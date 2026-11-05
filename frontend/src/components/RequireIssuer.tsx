import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useWallet } from "../hooks/useWallet";
import { Alert } from "./ui/feedback";
import { Button, Card } from "./ui/primitives";
import { IconKey, IconShield, IconWallet } from "./ui/icons";
import { useAppConfig } from "../blockchain/config";
import { shortAddr } from "../lib/format";

function Gate({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Card className="mx-auto max-w-lg px-6 py-10 text-center">
      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-accentsoft text-accent">{icon}</div>
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted">{children}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </Card>
  );
}

/**
 * Gate for pages that need a connected wallet, a SIWE session and (optionally) an on-chain role.
 * The roles come from the contract through the API session, so the UI cannot show a button the contract would reject.
 */
export function RequireWallet({ role, children }: { role: "issuer" | "manager" | null; children: ReactNode }) {
  const cfg = useAppConfig();
  const w = useWallet();
  const auth = useAuth();

  if (!w.isConnected) {
    return <Gate icon={<IconWallet />} title="Connect your wallet" action={<Button onClick={w.connect} loading={w.connecting}>Connect wallet</Button>}>
      {w.hasInjectedWallet ? "Connect the wallet you use to issue documents. Nothing is sent until you confirm." : "No browser wallet was detected. Install one such as MetaMask, then reload."}
      {w.error && <span role="alert" className="mt-2 block text-bad">{w.error}</span>}
    </Gate>;
  }
  if (w.wrongNetwork) {
    return <Gate icon={<IconWallet />} title="Wrong network" action={<Button onClick={w.switchNetwork} loading={w.switching}>Switch to {cfg.chain_name}</Button>}>
      Your wallet is connected to a different network. Verity runs on {cfg.chain_name} (chain {cfg.chain_id}).
    </Gate>;
  }
  if (auth.sessionLoading) return <div className="py-16 text-center text-sm text-muted" role="status">Checking your session…</div>;
  if (!auth.signedIn) {
    return <Gate icon={<IconKey />} title="Sign in with your wallet" action={<Button onClick={() => auth.signIn()} loading={auth.signingIn}>Sign in with Ethereum</Button>}>
      You will be asked to sign a message that proves you control {shortAddr(w.address!)}. It is free and does not authorise any transaction.
      {auth.signInError && <span role="alert" className="mt-2 block text-bad">{auth.signInError}</span>}
    </Gate>;
  }
  if (!auth.rolesAvailable) {
    return <Alert tone="warn" title="Could not read your permissions from the chain">The blockchain node did not answer. Reload in a moment; nothing is lost.</Alert>;
  }
  if (role === "issuer" && !auth.isIssuer) {
    return <Gate icon={<IconShield />} title="This wallet is not an authorised issuer">
      Only issuers authorised on the registry contract can register or revoke documents. {shortAddr(w.address!)} is not one. Ask an issuer manager to authorise it, or switch to another account. Anyone can still <Link className="text-accent underline" to="/verify">verify a document</Link>.
    </Gate>;
  }
  if (role === "manager" && !auth.isManager) {
    return <Gate icon={<IconShield />} title="Issuer manager access required">Only wallets holding the issuer-manager role on the contract can authorise or remove issuers.</Gate>;
  }
  return <>{children}</>;
}
