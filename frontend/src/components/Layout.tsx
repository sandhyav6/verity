import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAppConfig } from "../blockchain/config";
import { cx } from "./ui/primitives";
import { IconMenu, IconX, Logo } from "./ui/icons";
import { ToastProvider } from "./ui/feedback";
import { WalletMenu } from "./WalletMenu";

const NAV = [
  { to: "/verify", label: "Verify a document" },
  { to: "/app", label: "Issuer dashboard", end: true },
  { to: "/issuers", label: "Issuers" },
  { to: "/activity", label: "Activity" },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cx("rounded-md px-3 py-2 text-sm font-medium transition-colors", isActive ? "bg-white/10 text-white" : "text-navmuted hover:bg-white/5 hover:text-white");

export function Layout() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);

  return (
    <ToastProvider>
      <a href="#main" className="sr-only-focusable fixed left-3 top-3 z-[70] rounded-md bg-surface px-3 py-2 text-sm font-medium text-ink shadow-lg">Skip to content</a>
      <header className="sticky top-0 z-40 bg-nav text-navink">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2 text-white" aria-label="Verity home">
            <Logo className="text-[#3fb1bb]" />
            <span className="text-[17px] font-semibold tracking-tight">Verity</span>
          </Link>
          <nav aria-label="Main" className="ml-4 hidden items-center gap-1 md:flex">
            {NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className={linkClass}>{n.label}</NavLink>)}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <div className="hidden md:block"><WalletMenu onDark /></div>
            <button type="button" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((o) => !o)} className="inline-flex h-10 w-10 items-center justify-center rounded-md text-navink hover:bg-white/10 md:hidden">
              {open ? <IconX /> : <IconMenu />}
            </button>
          </div>
        </div>
        {open && (
          <div id="mobile-nav" className="border-t border-white/10 px-4 pb-4 pt-2 md:hidden">
            <nav aria-label="Mobile" className="flex flex-col gap-1">
              {NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className={linkClass}>{n.label}</NavLink>)}
            </nav>
            <div className="mt-3"><WalletMenu onDark /></div>
          </div>
        )}
      </header>
      <main id="main" tabIndex={-1} className="mx-auto min-h-[calc(100vh-16rem)] max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        <Outlet />
      </main>
      <Footer />
    </ToastProvider>
  );
}

function Footer() {
  const cfg = useAppConfig();
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2 text-ink"><Logo className="text-accent" /><span className="font-semibold">Verity</span></div>
          <p className="mt-3 max-w-sm text-sm text-muted">A tamper-evident registry of document fingerprints. Documents stay with their owners; the blockchain keeps an independently checkable record of who registered what, and when.</p>
        </div>
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Product</h2>
          <ul className="mt-3 space-y-2 text-sm">
            <li><Link className="text-ink2 hover:text-ink hover:underline" to="/verify">Verify a document</Link></li>
            <li><Link className="text-ink2 hover:text-ink hover:underline" to="/app">Issuer dashboard</Link></li>
            <li><Link className="text-ink2 hover:text-ink hover:underline" to="/issuers">Authorised issuers</Link></li>
            <li><Link className="text-ink2 hover:text-ink hover:underline" to="/activity">Registry activity</Link></li>
          </ul>
        </div>
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Registry</h2>
          <dl className="mt-3 space-y-2 text-sm text-ink2">
            <div><dt className="text-xs text-muted">Network</dt><dd>{cfg.chain_name} <span className="text-muted">(chain {cfg.chain_id})</span></dd></div>
            <div><dt className="text-xs text-muted">Contract</dt><dd className="mono break-all">{cfg.registry_address || "not configured"}</dd></div>
          </dl>
        </div>
      </div>
      <p className="border-t border-line px-4 py-4 text-center text-xs text-muted sm:px-6">Verity proves that a file matches a registered fingerprint. It does not prove that a document's contents are true.</p>
    </footer>
  );
}
