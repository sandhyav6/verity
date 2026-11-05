import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAppConfig } from "../blockchain/config";
import { IconClock, IconFile, IconKey, IconLayers, IconSearch, IconShield } from "../components/ui/icons";
import { ButtonLink, Card } from "../components/ui/primitives";
import { useStats } from "../hooks/queries";

export function Landing() {
  return (
    <div className="space-y-20 sm:space-y-24">
      <Hero />
      <HowItWorks />
      <Capabilities />
      <Verification />
      <Principles />
      <Cta />
    </div>
  );
}

function Hero() {
  const stats = useStats("global");
  const cfg = useAppConfig();
  return (
    <section aria-labelledby="hero-title" className="grid items-center gap-10 pt-4 lg:grid-cols-[1.1fr_1fr]">
      <div>
        <p className="mb-3 text-sm font-medium text-accent">Tamper-evident document registry</p>
        <h1 id="hero-title" className="text-4xl font-semibold leading-[1.1] text-ink sm:text-5xl">Prove a document is exactly what was issued.</h1>
        <p className="mt-5 max-w-xl text-lg text-ink2">Issuers register a cryptographic fingerprint of each document on a public blockchain. Anyone can check a file against that record in seconds, without calling the issuer and without uploading the file.</p>
        <div className="mt-7 flex flex-wrap gap-3">
          <ButtonLink to="/verify" size="lg">Verify a document</ButtonLink>
          <ButtonLink to="/app" variant="secondary" size="lg">Issuer dashboard</ButtonLink>
        </div>
        {stats.data && (
          <dl className="mt-9 flex flex-wrap gap-x-8 gap-y-3 border-t border-line pt-5 text-sm" aria-label="Live registry figures">
            <div><dt className="text-xs text-muted">Documents registered</dt><dd className="text-lg font-semibold num">{stats.data.total_documents}</dd></div>
            <div><dt className="text-xs text-muted">Batches</dt><dd className="text-lg font-semibold num">{stats.data.total_batches}</dd></div>
            <div><dt className="text-xs text-muted">Authorised issuers</dt><dd className="text-lg font-semibold num">{stats.data.authorized_issuers}</dd></div>
            <div><dt className="text-xs text-muted">Network</dt><dd className="text-lg font-semibold">{cfg.chain_name}</dd></div>
          </dl>
        )}
      </div>
      <Card className="p-6" aria-label="How a check works">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">How a check works</p>
        <ol className="mt-4 space-y-3">
          {[
            { icon: <IconFile />, title: "Your file", text: "Stays on your device." },
            { icon: <IconKey />, title: "SHA-256 fingerprint", text: "Computed locally, in your browser." },
            { icon: <IconShield />, title: "Registry contract", text: "Answers: registered? by whom? revoked?" },
          ].map((s, i) => (
            <li key={s.title} className="relative flex gap-4 rounded-md border border-line bg-surface2 p-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accentsoft text-accent">{s.icon}</span>
              <div><p className="font-medium text-ink"><span className="mr-2 text-muted num">{i + 1}</span>{s.title}</p><p className="text-sm text-muted">{s.text}</p></div>
            </li>
          ))}
        </ol>
      </Card>
    </section>
  );
}

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-2xl font-semibold text-ink">{title}</h2>
      {intro && <p className="mt-2 max-w-2xl text-ink2">{intro}</p>}
      <div className="mt-8">{children}</div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    { n: "1", title: "Register", text: "An authorised issuer fingerprints a document and signs one transaction. The record shows who registered which fingerprint, and when." },
    { n: "2", title: "Share", text: "The issuer hands the document to its recipient as usual. Nothing about delivery changes, and the file never leaves their hands." },
    { n: "3", title: "Verify", text: "Anyone drops the file onto Verity. If its fingerprint is on record and not revoked, it verifies. Change one byte and it does not." },
  ];
  return (
    <Section id="how" title="How Verity works" intro="Three steps, and the middle one is the one you already do.">
      <ol className="grid gap-4 md:grid-cols-3">
        {steps.map((s) => (
          <li key={s.n}><Card className="h-full p-6"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-nav text-sm font-semibold text-navink">{s.n}</span><h3 className="mt-4 text-lg font-semibold text-ink">{s.title}</h3><p className="mt-1.5 text-sm text-ink2">{s.text}</p></Card></li>
        ))}
      </ol>
    </Section>
  );
}

function Capabilities() {
  const items = [
    { icon: <IconShield />, title: "Tamper-evident registration", text: "Each document's SHA-256 fingerprint is recorded with its issuer and timestamp. Records cannot be edited or deleted." },
    { icon: <IconSearch />, title: "Private, instant verification", text: "Files are hashed in the browser and checked against the contract directly. No upload, no account." },
    { icon: <IconLayers />, title: "Version history", text: "Register corrected versions of a document. Earlier versions stay on record and keep verifying on their own." },
    { icon: <IconKey />, title: "Permanent revocation", text: "Issuers can revoke what they issued. The original record is kept, marked revoked, with who and when." },
    { icon: <IconLayers />, title: "Merkle batches", text: "Register thousands of documents with one transaction. Each recipient verifies theirs with a small proof." },
    { icon: <IconClock />, title: "Optional expiry", text: "Credentials and compliance documents can carry a validity period that the contract enforces." },
  ];
  return (
    <Section id="capabilities" title="Core capabilities">
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((i) => (
          <li key={i.title}><Card className="h-full p-5"><span className="text-accent">{i.icon}</span><h3 className="mt-3 font-semibold text-ink">{i.title}</h3><p className="mt-1 text-sm text-ink2">{i.text}</p></Card></li>
        ))}
      </ul>
    </Section>
  );
}

function Verification() {
  return (
    <Section id="verification" title="What a result means" intro="Verity is precise about what it can and cannot tell you.">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="border-okline bg-okbg p-5"><h3 className="font-semibold text-ok">Verified</h3><p className="mt-1.5 text-sm text-ink2">The fingerprint is registered, the issuer is identified, and it has not been revoked. Your file is byte-for-byte what they registered.</p></Card>
        <Card className="border-badline bg-badbg p-5"><h3 className="font-semibold text-bad">Revoked</h3><p className="mt-1.5 text-sm text-ink2">The record exists, but the issuer withdrew it. You see when, and by whom. Do not rely on the document.</p></Card>
        <Card className="border-badline bg-badbg p-5"><h3 className="font-semibold text-bad">Not verified</h3><p className="mt-1.5 text-sm text-ink2">No registration matches this file: it was never registered, or it differs from the registered one by at least one byte.</p></Card>
      </div>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="font-semibold text-ink">Blockchain transparency</h3>
          <p className="mt-1.5 text-sm text-ink2">Registrations, revocations and issuer authorisations are public events on the chain. The verdict is read from the registry contract by your own browser, so Verity's servers cannot turn a revoked document into a valid one. Every record links to its transaction.</p>
        </div>
        <div>
          <h3 className="font-semibold text-ink">What it does not prove</h3>
          <p className="mt-1.5 text-sm text-ink2">A fingerprint proves integrity and origin, not truth. It cannot show that a document's claims are accurate, or that an issuer is who they say they are. Confirm an issuer's address through a channel you trust.</p>
        </div>
      </div>
    </Section>
  );
}

function Principles() {
  const items = [
    ["Documents stay off-chain", "Only fingerprints and issuance records are on the blockchain. Contents are never published."],
    ["Verification is private", "Files are hashed locally. Verifying a document sends the server only a fingerprint."],
    ["Issuers are explicit", "Only wallets authorised on the contract can register. A separate manager role controls who, and cannot register or revoke documents itself."],
    ["Nothing is rewritten", "Revocation adds to the record; it never deletes it. History stays auditable."],
    ["Private by default", "An issuer chooses, per document, whether its title, details and file are public or private."],
    ["No tokens, no trading", "Verity has no currency, fees to holders, or speculation. It is a registry."],
  ];
  return (
    <Section id="principles" title="Security and privacy principles">
      <dl className="grid gap-x-8 gap-y-6 md:grid-cols-2">
        {items.map(([t, d]) => <div key={t} className="border-l-2 border-accent pl-4"><dt className="font-semibold text-ink">{t}</dt><dd className="mt-1 text-sm text-ink2">{d}</dd></div>)}
      </dl>
    </Section>
  );
}

function Cta() {
  return (
    <section className="rounded-xl bg-nav px-6 py-12 text-center text-navink sm:px-12" aria-labelledby="cta-title">
      <h2 id="cta-title" className="text-2xl font-semibold text-white sm:text-3xl">Check a document now</h2>
      <p className="mx-auto mt-2 max-w-lg text-navmuted">No account needed. Drop a file and see its record.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link to="/verify" className="inline-flex h-11 items-center rounded-md bg-accent px-5 text-[15px] font-medium text-accentink hover:opacity-90">Verify a document</Link>
        <Link to="/app" className="inline-flex h-11 items-center rounded-md border border-white/25 px-5 text-[15px] font-medium text-white hover:bg-white/10">Open the issuer dashboard</Link>
      </div>
    </section>
  );
}
