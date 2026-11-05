import { useAppConfig } from "../blockchain/config";
import { useAuth } from "../hooks/useAuth";
import { useWallet } from "../hooks/useWallet";
import { shortAddr } from "../lib/format";
import { DropdownMenu, MenuItem } from "./ui/data";
import { IconAlert, IconKey, IconWallet } from "./ui/icons";
import { Badge, Button } from "./ui/primitives";

/** Wallet connection, network state and SIWE session in one control. */
export function WalletMenu({ onDark }: { onDark?: boolean }) {
  const cfg = useAppConfig();
  const w = useWallet();
  const auth = useAuth();

  if (!w.hasInjectedWallet && !w.isConnected) {
    return <a href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center rounded-md border border-linestrong px-3 text-sm font-medium text-ink hover:bg-surface2">Install a wallet</a>;
  }
  if (!w.isConnected) {
    return <Button onClick={w.connect} loading={w.connecting} size="md"><IconWallet width={16} height={16} />Connect wallet</Button>;
  }
  if (w.wrongNetwork) {
    return <Button variant="secondary" onClick={w.switchNetwork} loading={w.switching} className="border-warnline bg-warnbg text-warn"><IconAlert width={16} height={16} />Switch to {cfg.chain_name}</Button>;
  }
  return (
    <DropdownMenu
      buttonClassName={onDark ? "!border-white/20 !bg-white/5 !text-navink hover:!bg-white/10" : undefined}
      label={<><span aria-hidden className={`h-2 w-2 rounded-full ${auth.signedIn ? "bg-ok" : "bg-warn"}`} /><span className="mono !text-[13px]">{shortAddr(w.address!)}</span></>}
    >
      {(close) => (
        <>
          <div className="px-3 py-2 text-xs text-muted">
            <p className="mono break-all !text-xs text-ink2">{w.address}</p>
            <p className="mt-1">{cfg.chain_name}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {auth.signedIn ? <Badge tone="ok">Signed in</Badge> : <Badge tone="warn">Not signed in</Badge>}
              {auth.isIssuer && <Badge tone="accent">Authorised issuer</Badge>}
              {auth.isManager && <Badge tone="accent">Issuer manager</Badge>}
            </div>
            {auth.signInError && <p role="alert" className="mt-2 text-bad">{auth.signInError}</p>}
            {auth.signedIn && !auth.rolesAvailable && <p className="mt-2 text-warn">Roles could not be read from the chain right now.</p>}
          </div>
          <hr className="my-1 border-line" />
          {auth.signedIn ? (
            <MenuItem onClick={() => { auth.signOut(); close(); }}>Sign out</MenuItem>
          ) : (
            <MenuItem onClick={() => { auth.signIn(); }}><IconKey width={16} height={16} />{auth.signingIn ? "Waiting for signature…" : "Sign in with Ethereum"}</MenuItem>
          )}
          <MenuItem onClick={() => { auth.signOut(); w.disconnect(); close(); }} danger>Disconnect wallet</MenuItem>
        </>
      )}
    </DropdownMenu>
  );
}
