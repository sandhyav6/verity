import { createHash } from "node:crypto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { authMock, clientMock, connectWallet, resetMocks, signInAs, txMock, USER, walletMock } from "../test/wallet-mocks";
import { HASH_A, ISSUER, mockApi, page, renderWithProviders, version } from "../test/utils";
import { Activity } from "./Activity";
import { Dashboard } from "./Dashboard";
import { DocumentDetails } from "./DocumentDetails";
import { Issuers } from "./Issuers";
import { Register } from "./Register";
import { Verify } from "./Verify";

vi.mock("wagmi", async () => (await import("../test/wallet-mocks")).wagmiModule);
vi.mock("../hooks/useWallet", async () => (await import("../test/wallet-mocks")).walletModule);
vi.mock("../hooks/useAuth", async () => (await import("../test/wallet-mocks")).authModule);
vi.mock("../hooks/useTx", async () => (await import("../test/wallet-mocks")).txModule);

const sha = (b: Uint8Array) => "0x" + createHash("sha256").update(b).digest("hex");
const FILE_BYTES = new TextEncoder().encode("%PDF-1.4 a degree certificate");
const FILE_HASH = sha(FILE_BYTES);
const pdf = (name = "degree.pdf", bytes: Uint8Array<ArrayBuffer> = FILE_BYTES) => new File([bytes], name, { type: "application/pdf" });

const doc = (status: number, extra: object = {}) => ({
  status, issuer: ISSUER, issuerAuthorized: true, documentId: "0x" + "cd".repeat(32), version: 1, latestVersion: 1, docType: 1,
  metadataHash: "0x" + "00".repeat(32), registeredAt: 1_762_250_000n, expiresAt: 0n, revokedAt: status === 2 ? 1_762_260_000n : 0n,
  revokedBy: status === 2 ? ISSUER : "0x" + "00".repeat(20), reasonHash: "0x" + "00".repeat(32), ...extra,
});
const chainReturns = (status: number) => clientMock.readContract.mockImplementation(async () => doc(status));

const apiVerification = (verdict: string, registration: object | null = null) => ({
  document_hash: FILE_HASH, verdict, reason: `api says ${verdict}`, checked_at: "2026-11-05T00:00:00Z", chain_id: 31337, contract_address: "0x5fb", registration,
});
const registration = (over: object = {}) => ({
  kind: "document", issuer: { address: ISSUER, organization_name: "Northfield University", currently_authorized: true }, registered_at: "2026-11-04T10:00:00Z",
  expires_at: null, revoked_at: null, revoked_by: null, document_id: "0x" + "cd".repeat(32), document_type: "academic_certificate", version_number: 1,
  latest_version: 1, is_latest: true, batch_id: null, merkle_root: null, transaction_hash: "0x" + "12".repeat(32), explorer_url: null, title: null, ...over,
});

beforeEach(() => resetMocks());

// ------------------------------------------------------------------------------------------------ Verify

describe("Verify page", () => {
  async function verifyFile(file = pdf()) {
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText(/choose the document to verify/i), file);
  }

  it("hashes the uploaded file locally and shows VERIFIED only when the contract says so", async () => {
    chainReturns(1);
    const fetchMock = mockApi([[/\/verify$/, apiVerification("verified", registration())], [/\/proofs\//, { document_hash: FILE_HASH, entries: [] }]]);
    renderWithProviders(<Verify />);
    await verifyFile();
    expect(await screen.findByRole("heading", { name: "VERIFIED" })).toBeInTheDocument();
    expect(screen.getByText(FILE_HASH)).toBeInTheDocument();
    expect(screen.getByText("Northfield University")).toBeInTheDocument();
    expect(screen.getByText(/currently authorised/i)).toBeInTheDocument();
    // the file itself is never sent anywhere: only the fingerprint reaches the API
    const sent = fetchMock.mock.calls.map(([, init]) => init?.body).filter(Boolean);
    expect(sent).toEqual([JSON.stringify({ document_hash: FILE_HASH })]);
    expect(clientMock.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "verifyDocument", args: [FILE_HASH] }));
  });

  it("shows REVOKED with the revocation details", async () => {
    chainReturns(2);
    mockApi([[/\/verify$/, apiVerification("revoked", registration({ revoked_at: "2026-11-04T12:00:00Z", revoked_by: ISSUER }))], [/\/proofs\//, { entries: [] }]]);
    renderWithProviders(<Verify />);
    await verifyFile();
    expect(await screen.findByRole("heading", { name: "REVOKED" })).toBeInTheDocument();
    expect(screen.getByText(/^by 0x7099…79c8$/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "VERIFIED" })).not.toBeInTheDocument();
  });

  it("shows NOT VERIFIED with an explanation when nothing is registered", async () => {
    chainReturns(0);
    mockApi([[/\/verify$/, apiVerification("not_verified")], [/\/proofs\//, { entries: [] }]]);
    renderWithProviders(<Verify />);
    await verifyFile();
    expect(await screen.findByRole("heading", { name: "NOT VERIFIED" })).toBeInTheDocument();
    expect(screen.getByText(/changed after registration, even by a single byte/i)).toBeInTheDocument();
  });

  it("shows EXPIRED for an expired registration", async () => {
    chainReturns(3);
    mockApi([[/\/verify$/, apiVerification("expired", registration())], [/\/proofs\//, { entries: [] }]]);
    renderWithProviders(<Verify />);
    await verifyFile();
    expect(await screen.findByRole("heading", { name: "EXPIRED" })).toBeInTheDocument();
  });

  it("does NOT show VERIFIED just because the API returned 200: the contract decides", async () => {
    chainReturns(0); // the contract has no such registration...
    mockApi([[/\/verify$/, apiVerification("verified", registration())], [/\/proofs\//, { entries: [] }]]); // ...but a lying API says verified
    renderWithProviders(<Verify />);
    await verifyFile();
    expect(await screen.findByRole("heading", { name: "NOT VERIFIED" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "VERIFIED" })).not.toBeInTheDocument();
    expect(screen.getByText(/API and the blockchain disagree/i)).toBeInTheDocument();
  });

  it("still gives the authoritative verdict when the API is down, and says details are missing", async () => {
    chainReturns(1);
    mockApi([]); // every API call 404s
    renderWithProviders(<Verify />);
    await verifyFile();
    expect(await screen.findByRole("heading", { name: "VERIFIED" })).toBeInTheDocument();
    expect(screen.getByText(/Some details are unavailable/i)).toBeInTheDocument();
  });

  it("reports a failed chain read as an error, never as NOT VERIFIED", async () => {
    clientMock.readContract.mockRejectedValue(new Error("connection refused"));
    mockApi([[/\/verify$/, apiVerification("verified", registration())]]);
    renderWithProviders(<Verify />);
    await verifyFile();
    expect(await screen.findByText(/Verification could not be completed/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^(VERIFIED|NOT VERIFIED|REVOKED|EXPIRED)$/ })).not.toBeInTheDocument();
  });

  it("warns that batch membership could not be checked when proofs are unreachable", async () => {
    chainReturns(0);
    mockApi([[/\/verify$/, apiVerification("not_verified")]]); // /proofs 404s
    renderWithProviders(<Verify />);
    await verifyFile();
    expect(await screen.findByText(/Batch membership could not be checked/i)).toBeInTheDocument();
  });

  it("verifies a pasted fingerprint, validating its format first", async () => {
    chainReturns(1);
    mockApi([[/\/verify$/, apiVerification("verified", registration())], [/\/proofs\//, { entries: [] }]]);
    renderWithProviders(<Verify />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /paste a fingerprint/i }));
    await user.type(screen.getByLabelText(/sha-256 fingerprint/i), "not-a-hash");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/64 hexadecimal characters/);
    expect(clientMock.readContract).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText(/sha-256 fingerprint/i));
    await user.type(screen.getByLabelText(/sha-256 fingerprint/i), FILE_HASH.toUpperCase().replace("0X", "0x"));
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("heading", { name: "VERIFIED" })).toBeInTheDocument();
  });

  it("auto-verifies a fingerprint passed in the URL", async () => {
    chainReturns(1);
    mockApi([[/\/verify$/, apiVerification("verified", registration())], [/\/proofs\//, { entries: [] }]]);
    renderWithProviders(<Verify />, { route: `/verify?hash=${FILE_HASH}` });
    expect(await screen.findByRole("heading", { name: "VERIFIED" })).toBeInTheDocument();
  });

  it("rejects an empty file with a clear message", async () => {
    renderWithProviders(<Verify />);
    await verifyFile(pdf("empty.pdf", new Uint8Array()));
    expect(await screen.findByText(/file is empty/i)).toBeInTheDocument();
    expect(clientMock.readContract).not.toHaveBeenCalled();
  });

  it("explains what verification does and does not guarantee", () => {
    renderWithProviders(<Verify />);
    expect(screen.getByText(/A VERIFIED result tells you/i)).toBeInTheDocument();
    expect(screen.getByText(/It does not tell you/i)).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------------ routing, landing

describe("Landing and routing", () => {
  it("renders the product pitch with real calls to action and no invented numbers", async () => {
    mockApi([[/\/stats$/, { scope: "global", total_documents: 12, valid_documents: 10, revoked_documents: 2, expired_documents: 0, total_batches: 3, authorized_issuers: 4, daily: [] }]]);
    renderWithProviders(<App />, { route: "/" });
    expect(await screen.findByRole("heading", { level: 1, name: /Prove a document is exactly what was issued/i })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Verify a document/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /issuer dashboard/i }).length).toBeGreaterThan(0);
    expect(await screen.findByText("12")).toBeInTheDocument(); // from the (mocked) API, not hard-coded
    expect(screen.queryByText(/trusted by/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b(odds|bet|trade|shares|market)\b/i);
  });

  it("hides live figures when the stats cannot be loaded rather than inventing them", async () => {
    mockApi([]);
    renderWithProviders(<App />, { route: "/" });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByLabelText(/live registry figures/i)).not.toBeInTheDocument();
  });

  it("navigates between pages from the header", async () => {
    mockApi([[/\/stats$/, { scope: "global", total_documents: 0, valid_documents: 0, revoked_documents: 0, expired_documents: 0, total_batches: 0, authorized_issuers: 0, daily: [] }], [/\/audit$/, page([])]]);
    renderWithProviders(<App />, { route: "/" });
    const user = userEvent.setup();
    const nav = screen.getByRole("navigation", { name: "Main" });
    await user.click(within(nav).getByRole("link", { name: "Activity" }));
    expect(await screen.findByRole("heading", { name: "Registry activity" })).toBeInTheDocument();
    await user.click(within(nav).getByRole("link", { name: /verify a document/i }));
    expect(await screen.findByRole("heading", { name: "Verify a document" })).toBeInTheDocument();
  });

  it("shows a not-found page with a way home", () => {
    renderWithProviders(<App />, { route: "/nope" });
    expect(screen.getByText("Page not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to the homepage/i })).toHaveAttribute("href", "/");
  });

  it("has a skip link and a labelled mobile menu button", () => {
    mockApi([]);
    renderWithProviders(<App />, { route: "/verify" });
    expect(screen.getByRole("link", { name: /skip to content/i })).toHaveAttribute("href", "#main");
    expect(screen.getByRole("button", { name: /open menu/i })).toHaveAttribute("aria-expanded", "false");
  });
});

// ------------------------------------------------------------------------------------------------ wallet gating

describe("Wallet and authorisation states", () => {
  beforeEach(() => { mockApi([]); });

  it("asks a disconnected visitor to connect", async () => {
    renderWithProviders(<Register />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(walletMock.connect).toHaveBeenCalled();
  });

  it("tells a visitor without a browser wallet to install one", () => {
    walletMock.hasInjectedWallet = false;
    renderWithProviders(<Register />);
    // header isn't rendered here; the gate explains it
    expect(screen.getByText(/No browser wallet was detected/i)).toBeInTheDocument();
  });

  it("offers a network switch on the wrong chain", async () => {
    connectWallet({ wrongNetwork: true });
    renderWithProviders(<Register />);
    expect(screen.getByText("Wrong network")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /switch to hardhat local/i }));
    expect(walletMock.switchNetwork).toHaveBeenCalled();
  });

  it("asks a connected wallet to sign in", async () => {
    connectWallet();
    renderWithProviders(<Register />);
    await userEvent.setup().click(screen.getByRole("button", { name: /sign in with ethereum/i }));
    expect(authMock.signIn).toHaveBeenCalled();
  });

  it("blocks a signed-in wallet that is not an authorised issuer", () => {
    signInAs({ issuer: false });
    renderWithProviders(<Register />);
    expect(screen.getByText(/not an authorised issuer/i)).toBeInTheDocument();
    expect(screen.queryByText(/Choose the document/i)).not.toBeInTheDocument();
  });

  it("reports when roles could not be read instead of guessing", () => {
    signInAs({ issuer: true });
    authMock.rolesAvailable = false;
    renderWithProviders(<Register />);
    expect(screen.getByText(/Could not read your permissions/i)).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------------ Register

describe("Register document", () => {
  async function toReview(user = userEvent.setup(), file = pdf()) {
    await user.upload(screen.getByLabelText(/choose a file to register/i), file);
    await screen.findByText(FILE_HASH);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    return user;
  }

  beforeEach(() => signInAs({ issuer: true }));

  it("fingerprints the file and carries the user through details to a review", async () => {
    clientMock.readContract.mockImplementation(async () => doc(0));
    mockApi([[/\/issuers\//, { organization_name: "Northfield University" }], [/\/verify$/, apiVerification("not_verified")], [/\/proofs\//, { entries: [] }]]);
    renderWithProviders(<Register />);
    const user = await toReview();
    expect(screen.getByLabelText("Title")).toHaveValue("degree"); // pre-filled from the file name
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText(/Check everything/i)).toBeInTheDocument();
    expect(screen.getByText(FILE_HASH)).toBeInTheDocument();
    expect(screen.getByText("Northfield University")).toBeInTheDocument();
    expect(screen.getByText(/New document, version 1/)).toBeInTheDocument();
  });

  it("validates the details step", async () => {
    mockApi([]);
    renderWithProviders(<Register />);
    const user = await toReview();
    await user.clear(screen.getByLabelText("Title"));
    await user.click(screen.getByRole("button", { name: "Add a detail" }));
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Enter a title.")).toBeInTheDocument();
    expect(screen.getByText(/Fill in both the name and the value/i)).toBeInTheDocument();
    expect(screen.queryByText(/Check everything/)).not.toBeInTheDocument();
  });

  it("rejects an empty or oversized file before anything is sent", async () => {
    const fetchMock = mockApi([]);
    renderWithProviders(<Register />, { config: { max_upload_bytes: 10 } });
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText(/choose a file to register/i), pdf("big.pdf", new Uint8Array(50)));
    expect(await screen.findByText(/The limit is 10 B/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/documents/uploads"))).toBe(false);
  });

  it("blocks registering a fingerprint that is already on-chain", async () => {
    clientMock.readContract.mockImplementation(async () => doc(1));
    mockApi([[/\/issuers\//, { organization_name: "N" }], [/\/verify$/, apiVerification("verified", registration())], [/\/proofs\//, { entries: [] }]]);
    renderWithProviders(<Register />);
    const user = await toReview();
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText(/already registered/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Register on-chain" })).toBeDisabled();
  });

  async function reachReview() {
    clientMock.readContract.mockImplementation(async () => doc(0));
    const user = await toReview();
    await user.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByText(/Check everything/i);
    await waitFor(() => expect(screen.queryByText(/Checking the registry for duplicates/)).not.toBeInTheDocument());
    return user;
  }
  async function confirmRegistration() {
    const user = await reachReview();
    await user.click(screen.getByRole("button", { name: /Register on-chain|Try again/ }));
  }

  const upload = (meta = "0x" + "ee".repeat(32)) => [/\/documents\/uploads$/, () => ({ document_hash: FILE_HASH, metadata_hash: meta, canonical_metadata: "{}", title: "degree", document_type: "academic_certificate", visibility: "private", content_type: "application/pdf", size_bytes: FILE_BYTES.length })] as [RegExp, unknown];
  const base = (): [RegExp, unknown][] => [[/\/issuers\//, { organization_name: "N" }], [/\/verify$/, apiVerification("not_verified")], [/\/proofs\//, { entries: [] }]];

  it("uploads, sends the registerDocument transaction, and shows success only after confirmation", async () => {
    const fetchMock = mockApi([...base(), upload()]);
    let confirm!: (h: string) => void;
    txMock.send.mockImplementation(() => new Promise((r) => (confirm = r)));
    renderWithProviders(<Register />);
    await confirmRegistration();

    await waitFor(() => expect(txMock.send).toHaveBeenCalled());
    const call = txMock.send.mock.calls[0][0] as { functionName: string; args: unknown[] };
    expect(call.functionName).toBe("registerDocument");
    expect(call.args[1]).toBe(FILE_HASH);
    expect(call.args[2]).toBe(1); // academic_certificate
    expect(call.args[3]).toBe("0x" + "ee".repeat(32)); // the metadata hash the server computed
    expect(call.args[4]).toBe(0n);
    const form = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/documents/uploads"))![1]!.body as FormData;
    expect(form.get("title")).toBe("degree");
    expect(form.get("expected_hash")).toBe(FILE_HASH);
    expect((form.get("file") as File).name).toBe("degree.pdf");

    // the wallet has not confirmed yet: no success screen
    expect(screen.queryByText("Registered on-chain")).not.toBeInTheDocument();
    confirm("0x" + "99".repeat(32));
    expect(await screen.findByText("Registered on-chain")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view document record/i })).toHaveAttribute("href", `/documents/${FILE_HASH}`);
  });

  it("shows upload failures and does not open the wallet", async () => {
    mockApi([...base(), [/\/documents\/uploads$/, new Response(JSON.stringify({ detail: "executable files are not accepted" }), { status: 415 })]]);
    renderWithProviders(<Register />);
    await confirmRegistration();
    expect(await screen.findByText(/The upload failed/i)).toBeInTheDocument();
    expect(screen.getByText(/executable files are not accepted/i)).toBeInTheDocument();
    expect(txMock.send).not.toHaveBeenCalled();
  });

  it("refuses a server fingerprint that differs from the browser's", async () => {
    mockApi([...base(), [/\/documents\/uploads$/, { document_hash: "0x" + "00".repeat(32), metadata_hash: "0x" + "ee".repeat(32), canonical_metadata: "{}", title: "t", document_type: "other", visibility: "private", content_type: "application/pdf", size_bytes: 1 }]]);
    renderWithProviders(<Register />);
    await confirmRegistration();
    expect(await screen.findByText(/different fingerprint from your browser/i)).toBeInTheDocument();
    expect(txMock.send).not.toHaveBeenCalled();
  });

  it("stays on the review step with the error when the transaction is rejected or reverts", async () => {
    mockApi([...base(), upload()]);
    txMock.state = { phase: "failed", error: "You rejected the request in your wallet. Nothing was sent." };
    txMock.send.mockResolvedValue(null);
    renderWithProviders(<Register />);
    await reachReview();
    expect(await screen.findByText(/You rejected the request/i)).toBeInTheDocument();
    expect(screen.queryByText("Registered on-chain")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("explains a slow confirmation", async () => {
    mockApi([...base(), upload()]);
    txMock.state = { phase: "pending", hash: "0x" + "77".repeat(32), slow: true };
    txMock.busy = true;
    txMock.send.mockResolvedValue(null);
    renderWithProviders(<Register />);
    await reachReview();
    expect(await screen.findByText(/taking longer than usual/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Register on-chain|Try again/ })).toBeDisabled(); // cannot double-submit while pending
  });

  it("registers a new version when opened from an existing document", async () => {
    clientMock.readContract.mockImplementation(async () => doc(0));
    const parent = version({ document_hash: HASH_A, document_id: "0x" + "cd".repeat(32), title: "Policy", version_number: 2 });
    mockApi([...base(), [/\/documents\/0xab/, { document: parent, versions: [parent] }], upload()]);
    txMock.send.mockResolvedValue("0x" + "99".repeat(32));
    authMock.session = { address: ISSUER };
    renderWithProviders(<Register />, { route: `/app/register?newVersionOf=${HASH_A}` });
    expect(await screen.findByText(/This registers version 3/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText(/choose a file to register/i), pdf());
    await screen.findByText(FILE_HASH);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Title")).toHaveValue("Policy");
    await user.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Register on-chain" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Register on-chain" }));
    await waitFor(() => expect(txMock.send).toHaveBeenCalled());
    expect((txMock.send.mock.calls[0][0] as { args: unknown[] }).args[0]).toBe(parent.document_id); // same documentId => next version
  });
});

// ------------------------------------------------------------------------------------------------ Dashboard

describe("Issuer dashboard", () => {
  const stats = { scope: "mine", total_documents: 7, valid_documents: 5, revoked_documents: 1, expired_documents: 1, total_batches: 2, authorized_issuers: 3,
    daily: Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, registrations: i === 29 ? 3 : 0, revocations: 0 })) };

  beforeEach(() => signInAs({ issuer: true }));

  it("shows statistics, activity and documents from the API", async () => {
    mockApi([
      [/\/stats$/, stats],
      [/\/audit$/, page([{ action: "document.registered", actor: ISSUER, resource_id: HASH_A, transaction_hash: "0x" + "12".repeat(32), block_number: 5, timestamp: "2026-11-04T10:00:00Z", explorer_url: null }])],
      [/\/documents$/, page([version(), version({ document_hash: "0x" + "ba".repeat(32), title: "Old report", status: "revoked", version_number: 2 })], { total: 2 })],
    ]);
    renderWithProviders(<Dashboard />);
    const tiles = await screen.findByText("Registered documents");
    expect(await within(tiles.closest("div")!).findByText("7")).toBeInTheDocument();
    expect(screen.getByText("Revoked", { selector: "dt" }).nextSibling).toHaveTextContent("1");
    expect(await screen.findByText("BSc Certificate")).toBeInTheDocument();
    expect(screen.getByText("Old report")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /3 documents registered in the last 30 days/ })).toBeInTheDocument();
    expect(await screen.findByText("Document registered")).toBeInTheDocument();
    // a revoked version cannot be revoked again or versioned
    const revokedRow = screen.getByText("Old report").closest("tr")!;
    expect(within(revokedRow).queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
    expect(within(screen.getByText("BSc Certificate").closest("tr")!).getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });

  it("passes search and filters to the API and offers to clear them when nothing matches", async () => {
    const fetchMock = mockApi([[/\/stats$/, stats], [/\/audit$/, page([])], [/\/documents$/, (u: URL) => (u.searchParams.get("status") === "revoked" ? page([]) : page([version()]))]]);
    renderWithProviders(<Dashboard />);
    await screen.findByText("BSc Certificate");
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Filter by status"), "revoked");
    expect(await screen.findByText("No documents match these filters")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("status=revoked"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("BSc Certificate")).toBeInTheDocument();
  });

  it("explains an empty account and links to registration", async () => {
    mockApi([[/\/stats$/, { ...stats, total_documents: 0, daily: stats.daily.map((d) => ({ ...d, registrations: 0 })) }], [/\/audit$/, page([])], [/\/documents$/, page([])]]);
    renderWithProviders(<Dashboard />);
    expect(await screen.findByText("You have not registered any documents yet")).toBeInTheDocument();
    expect(screen.getByText("No registrations in the last 30 days")).toBeInTheDocument();
  });

  it("shows an error state with retry when the API fails", async () => {
    mockApi([[/\/stats$/, stats], [/\/audit$/, page([])], [/\/documents$/, new Response(JSON.stringify({ detail: "boom" }), { status: 500 })]]);
    renderWithProviders(<Dashboard />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("revokes only after confirmation, via the contract", async () => {
    mockApi([[/\/stats$/, stats], [/\/audit$/, page([])], [/\/documents$/, page([version()])]]);
    txMock.send.mockResolvedValue("0x" + "55".repeat(32));
    renderWithProviders(<Dashboard />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(txMock.send).not.toHaveBeenCalled(); // opening the dialog sends nothing
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/reason/i), "issued in error");
    await user.click(within(dialog).getByRole("button", { name: "Revoke permanently" }));
    await waitFor(() => expect(txMock.send).toHaveBeenCalledTimes(1));
    const call = txMock.send.mock.calls[0][0] as { functionName: string; args: unknown[] };
    expect(call.functionName).toBe("revokeDocument");
    expect(call.args[0]).toBe(HASH_A);
    expect(call.args[1]).toBe(sha(new TextEncoder().encode("issued in error")));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Escape and Cancel close the revoke dialog without sending anything", async () => {
    mockApi([[/\/stats$/, stats], [/\/audit$/, page([])], [/\/documents$/, page([version()])]]);
    renderWithProviders(<Dashboard />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(txMock.send).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------------ Issuers

describe("Issuer management", () => {
  const issuer = (over = {}) => ({ address: ISSUER, organization_name: "Northfield University", authorized: true, authorized_at: "2026-11-01T00:00:00Z", removed_at: null, authorized_by: USER.toLowerCase(), transaction_hash: "0x" + "12".repeat(32), document_count: 4, batch_count: 1, revoked_count: 0, ...over });

  it("is read-only for wallets without the manager role", async () => {
    signInAs({ issuer: true });
    mockApi([[/\/issuers$/, page([issuer()])]]);
    renderWithProviders(<Issuers />);
    expect(await screen.findByText("Northfield University")).toBeInTheDocument();
    expect(screen.getByText(/Only wallets holding the issuer-manager role/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Authorise issuer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("lets a manager authorise an issuer on-chain after validating the input", async () => {
    signInAs({ manager: true });
    mockApi([[/\/issuers$/, page([issuer()])]]);
    txMock.send.mockResolvedValue("0x" + "aa".repeat(32));
    renderWithProviders(<Issuers />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Authorise issuer" }));
    expect(screen.getByText(/Enter a valid wallet address/)).toBeInTheDocument();
    expect(screen.getByText(/Enter the organisation name/)).toBeInTheDocument();
    expect(txMock.send).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Wallet address"), "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    await user.type(screen.getByLabelText("Organisation name"), "Harbor Audit LLP");
    await user.click(screen.getByRole("button", { name: "Authorise issuer" }));
    await waitFor(() => expect(txMock.send).toHaveBeenCalled());
    const call = txMock.send.mock.calls[0][0] as { functionName: string; args: unknown[] };
    expect(call.functionName).toBe("authorizeIssuer");
    expect(call.args).toEqual(["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "Harbor Audit LLP"]);
  });

  it("confirms before removing an issuer", async () => {
    signInAs({ manager: true });
    mockApi([[/\/issuers$/, page([issuer()])]]);
    txMock.send.mockResolvedValue("0x" + "bb".repeat(32));
    renderWithProviders(<Issuers />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    expect(txMock.send).not.toHaveBeenCalled();
    expect(screen.getByText(/stays on record and keeps verifying/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove issuer" }));
    await waitFor(() => expect(txMock.send).toHaveBeenCalled());
    expect((txMock.send.mock.calls[0][0] as { functionName: string; args: unknown[] }).functionName).toBe("removeIssuer");
    expect((txMock.send.mock.calls[0][0] as { args: unknown[] }).args).toEqual([ISSUER]);
  });

  it("shows issuer details and recent activity", async () => {
    mockApi([[/\/issuers$/, page([issuer()])], [/\/audit$/, page([{ action: "document.registered", actor: ISSUER, resource_id: HASH_A, transaction_hash: "0x" + "12".repeat(32), block_number: 5, timestamp: "2026-11-04T10:00:00Z", explorer_url: null }])]]);
    renderWithProviders(<Issuers />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Northfield University" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Documents")).toBeInTheDocument();
    expect(await within(dialog).findByText("Document registered")).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------------ Activity & details

describe("Activity page", () => {
  const entry = (n: number, action = "document.registered") => ({ action, actor: ISSUER, resource_id: "0x" + n.toString(16).padStart(64, "0"), transaction_hash: "0x" + n.toString(16).padStart(64, "a"), block_number: n, timestamp: "2026-11-04T10:00:00Z", explorer_url: null });

  it("lists events, filters by event type, and paginates", async () => {
    const fetchMock = mockApi([[/\/audit$/, (u: URL) => page(u.searchParams.get("action") === "document.revoked" ? [entry(9, "document.revoked")] : [entry(1), entry(2)], { total: u.searchParams.get("action") ? 1 : 45, limit: 20, offset: Number(u.searchParams.get("offset") ?? 0) })]]);
    renderWithProviders(<Activity />);
    await waitFor(() => expect(screen.getAllByText("Document registered")).toHaveLength(3)); // 2 rows + the filter option
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes("offset=20"))).toBe(true));
    await user.selectOptions(screen.getByLabelText("Filter by event"), "document.revoked");
    expect(await screen.findByText("Document revoked", { selector: "span" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("action=document.revoked") && !String(u).includes("offset=20"))).toBe(true);
  });

  it("shows an empty state", async () => {
    mockApi([[/\/audit$/, page([])]]);
    renderWithProviders(<Activity />);
    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
  });
});

describe("Document details", () => {
  const v1 = version({ document_hash: "0x" + "01".repeat(32), version_number: 1, is_latest: false, status: "revoked", revoked_at: "2026-11-04T12:00:00Z", revoked_by: ISSUER, revocation_transaction_hash: "0x" + "34".repeat(32) });
  const v2 = version({ document_hash: "0x" + "02".repeat(32), version_number: 2, title: "BSc Certificate (corrected)" });

  it("shows status, version history, transactions and revocation info", async () => {
    mockApi([[/\/proofs\//, { entries: [] }], [/\/documents\/0x02/, { document: v2, versions: [v2, v1] }], [/\/documents\/0x01/, { document: v1, versions: [v2, v1] }]]);
    renderWithProviders(<DocumentDetails />, { route: `/documents/${v1.document_hash}`, path: "/documents/:hash" });
    expect(await screen.findByText("This version was revoked")).toBeInTheDocument();
    
    const history = screen.getByRole("heading", { name: "Version history" }).closest("section")!;
    expect(within(history).getAllByRole("row")).toHaveLength(3); // header + 2 versions
    expect(within(history).getByText("(this record)")).toBeInTheDocument();
    expect(screen.getByText("Version 1 revoked")).toBeInTheDocument();
    expect(screen.getByText("Version 2 registered")).toBeInTheDocument();
    // not the issuer: no management actions
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New version" })).not.toBeInTheDocument();
  });

  it("offers management actions to the issuing wallet only", async () => {
    signInAs({ issuer: true });
    authMock.session = { address: ISSUER };
    mockApi([[/\/proofs\//, { entries: [] }], [/\/documents\/0x02/, { document: v2, versions: [v2, v1] }]]);
    renderWithProviders(<DocumentDetails />, { route: `/documents/${v2.document_hash}`, path: "/documents/:hash" });
    expect(await screen.findByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New version" })).toHaveAttribute("href", `/app/register?newVersionOf=${v2.document_hash}`);
    expect(screen.getByRole("link", { name: /download file/i })).toBeInTheDocument();
  });

  it("hides private details from the public", async () => {
    const hidden = version({ title: null, metadata: null, visibility: null, metadata_verified: null, file_available: false, content_type: null, size_bytes: null });
    mockApi([[/\/proofs\//, { entries: [] }], [/\/documents\/0xab/, { document: hidden, versions: [hidden] }]]);
    renderWithProviders(<DocumentDetails />, { route: `/documents/${HASH_A}`, path: "/documents/:hash" });
    expect(await screen.findByText("Untitled document")).toBeInTheDocument();
    expect(screen.getByText(/Held privately by the issuer/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /download file/i })).not.toBeInTheDocument();
  });

  it("handles an unknown or malformed fingerprint", async () => {
    mockApi([]);
    renderWithProviders(<DocumentDetails />, { route: `/documents/${HASH_A}`, path: "/documents/:hash" });
    expect(await screen.findByText("No indexed record for this fingerprint")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /verify it against the blockchain/i })).toBeInTheDocument();
    renderWithProviders(<DocumentDetails />, { route: "/documents/nope", path: "/documents/:hash" });
    expect(await screen.findByText("That is not a valid fingerprint")).toBeInTheDocument();
  });
});
