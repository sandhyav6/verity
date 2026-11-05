import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAppConfig } from "../blockchain/config";
import { WalletBar } from "./WalletBar";

const NAV = [
  ["/", "Dashboard"],
  ["/markets", "Markets"],
  ["/portfolio", "Portfolio"],
  ["/transactions", "Transactions"],
  ["/analytics", "Analytics"],
  ["/data", "Data Explorer"],
  ["/create", "Create"],
  ["/admin", "Resolution"],
] as const;

export function Disclaimer() {
  return (
    <div className="border-b border-edge bg-wash px-4 py-1.5 text-center text-xs text-ink" role="note" data-testid="disclaimer">
      <strong>TEST-ONLY SIMULATION.</strong> Test tokens have no monetary value and cannot be bought, sold or redeemed for money, goods or services. Not legal advice; not legally reviewed.
    </div>
  );
}

export function Layout() {
  const [open, setOpen] = useState(false);
  const cfg = useAppConfig();
  const link = ({ isActive }: { isActive: boolean }) => `rounded-md px-3 py-2 text-sm ${isActive ? "bg-wash font-medium text-ink" : "text-ink2 hover:bg-wash"}`;
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Disclaimer />
      <header className="sticky top-0 z-20 border-b border-edge bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <NavLink to="/" className="text-base font-semibold">Prediction market <span className="rounded bg-wash px-1.5 py-0.5 align-middle text-xs font-medium text-ink2">simulator</span></NavLink>
          <button className="ml-auto rounded-md border border-line px-3 py-2 text-sm md:hidden" aria-expanded={open} aria-controls="main-nav" onClick={() => setOpen((o) => !o)}>{open ? "Close" : "Menu"}</button>
          <nav id="main-nav" aria-label="Main" className={`${open ? "flex" : "hidden"} w-full flex-col gap-1 md:ml-2 md:flex md:w-auto md:flex-row`}>
            {NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === "/"} className={link} onClick={() => setOpen(false)}>{label}</NavLink>)}
          </nav>
          <div className="w-full md:ml-auto md:w-auto"><WalletBar /></div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 pt-4 text-xs text-muted">
        <p>{cfg.notice} Chain: {cfg.chain_name} (id {cfg.chain_id}). The database is a read model of the chain; the contracts are authoritative. Resolution is performed by a trusted resolver (see each market's evidence), not a decentralized oracle.</p>
        <p className="mt-1">Weather data by <a className="underline" href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo.com</a> (CC BY 4.0). Economic, space and sports records are entered by an administrator from official documents and are labelled as such.</p>
      </footer>
    </div>
  );
}
