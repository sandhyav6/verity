import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OraclePanel } from "./OraclePanel";
import { Admin } from "../pages/Admin";
import { USER, authMock, connectWallet, reads, resetMocks, txMock } from "../test/wallet-mocks";
import { market, mockApi, page, renderWithProviders } from "../test/utils";
import type { Proposal } from "../lib/types";

vi.mock("../hooks/useWallet", async () => (await import("../test/wallet-mocks")).walletModule);
vi.mock("../hooks/useAuth", async () => (await import("../test/wallet-mocks")).authModule);
vi.mock("../hooks/useTx", async () => (await import("../test/wallet-mocks")).txModule);
vi.mock("wagmi", async () => (await import("../test/wallet-mocks")).wagmiModule);

const E18 = 10n ** 18n;
const SERVER = new Date("2026-11-05T12:00:00Z");
const iso = (offsetMs: number) => new Date(SERVER.getTime() + offsetMs).toISOString();
const PROPOSER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const HASH_A = "0x" + "aa".repeat(32);
const HASH_B = "0x" + "bb".repeat(32);

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  proposed_outcome: "YES", final_outcome: null, state: "proposed", evidence_hash: HASH_A, evidence_uri: "x", evidence_available: true, resolver_address: PROPOSER,
  proposal_timestamp: iso(-3600_000), challenge_deadline: iso(1800_000), dispute_status: "none", resolution_timestamp: null, transaction_hash: "0x" + "11".repeat(32),
  bond: String(100n * E18), dispute_bond: "0", disputer_address: null, dispute_evidence_hash: null, dispute_evidence_uri: null, dispute_evidence_available: false, disputed_at: null,
  arbiter_address: null, arbiter_rationale_hash: null, arbiter_rationale_available: false, arbitrated_at: null, ...over,
});

const resolution = (p?: Proposal) => ({ market_id: 1, market_status: "closed", winning_outcome: null, server_time: SERVER.toISOString(), proposals: p ? [p] : [], trust_model: "x" });
const closedMarket = () => market({ status: "closed", created_by: "0x" + "99".repeat(20) });

function chain(opts: { arbiter?: boolean; disputeBond?: bigint } = {}) {
  reads.handler = ({ functionName }) => {
    if (functionName === "ARBITER_ROLE") return { data: "0x" + "ab".repeat(32) };
    if (functionName === "hasRole") return { data: !!opts.arbiter };
    if (functionName === "proposals") return { data: [0, 1, PROPOSER, 0n, 0n, HASH_A, 100n * E18, opts.disputeBond ?? 100n * E18, "0x0", 0n, "0x0"] };
    return { data: undefined };
  };
}

const fillEvidence = () => {
  const set = (label: RegExp, v: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: v } });
  set(/^Result extracted/i, "88.0"); set(/^Source name/i, "Open-Meteo (test)"); set(/^Source URL/i, "https://open-meteo.com/en/docs");
  set(/^Observation period/i, "1 to 5 October 2026"); set(/^Raw evidence reference/i, "test-fixture://a.json"); set(/^Raw evidence hash/i, "0x" + "cd".repeat(32));
};

describe("OraclePanel", () => {
  beforeEach(() => { resetMocks(); chain(); });

  it("shows nothing for open markets or when nothing is pending", async () => {
    mockApi([[/^\/resolutions\/1/, resolution(proposal())]]);
    const a = renderWithProviders(<OraclePanel market={market({ status: "active" })} />);
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    mockApi([[/^\/resolutions\/1/, resolution()]]);
    const b = renderWithProviders(<OraclePanel market={closedMarket()} />);
    await waitFor(() => expect(b.container).toBeEmptyDOMElement());
  });

  it("describes a pending proposal, its bond and its challenge window", async () => {
    mockApi([[/^\/resolutions\/1/, resolution(proposal())]]);
    renderWithProviders(<OraclePanel market={closedMarket()} />);
    expect(await screen.findByText(/a result has been proposed/i)).toBeInTheDocument();
    expect(screen.getByText(/with a bond of/i)).toHaveTextContent("100.00 test tokens");
    expect(screen.getByText(/^Challenge window ends/)).toBeInTheDocument();
  });

  it("an unbonded resolver proposal is labelled as such", async () => {
    mockApi([[/^\/resolutions\/1/, resolution(proposal({ bond: "0" }))]]);
    renderWithProviders(<OraclePanel market={closedMarket()} />);
    expect(await screen.findByText(/trusted resolver, no bond/i)).toBeInTheDocument();
  });

  it("asks a visitor to connect, and a connected-but-signed-out user to sign in, before disputing", async () => {
    mockApi([[/^\/resolutions\/1/, resolution(proposal())]]);
    renderWithProviders(<OraclePanel market={closedMarket()} />);
    expect(await screen.findByText(/connect your wallet on hardhat local to dispute/i)).toBeInTheDocument();
    resetMocks(); chain(); connectWallet();
    renderWithProviders(<OraclePanel market={closedMarket()} />);
    expect(await screen.findByText(/sign in \(top right\) to prepare a dispute/i)).toBeInTheDocument();
  });

  it("the proposer cannot dispute their own proposal", async () => {
    connectWallet({ address: PROPOSER as `0x${string}` });
    authMock.signedIn = true;
    mockApi([[/^\/resolutions\/1/, resolution(proposal())]]);
    renderWithProviders(<OraclePanel market={closedMarket()} />);
    expect(await screen.findByText(/you cannot dispute it/i)).toBeInTheDocument();
  });

  it("walks a challenger through evidence -> bond -> on-chain dispute, and checks the form first", async () => {
    connectWallet(); authMock.signedIn = true;
    const posts: { path: string; body: unknown }[] = [];
    const api = mockApi([
      [/^\/resolutions\/1\/dispute/, { evidence_hash: HASH_B, evidence_uri: "http://x/e", verdict: 1, market_address: market().contract_address, resolution_manager_address: "0x1", call: "dispute", note: "", bonded: true, bond_note: "bond" }],
      [/^\/resolutions\/1/, resolution(proposal())],
    ]);
    renderWithProviders(<OraclePanel market={closedMarket()} />);
    fireEvent.click(await screen.findByText(/dispute this result/i));
    expect(screen.getByText(/\(bond 100\.00 test tokens\)/)).toBeInTheDocument(); // read from the contract
    expect(screen.getByText(/if the arbiter agrees with you, you win the proposer's bond/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /1\. store my evidence/i }));
    expect(screen.getByText(/name the source/i)).toBeInTheDocument(); // incomplete form: no request is made
    expect(api.mock.calls.some(([u]) => String(u).includes("/dispute"))).toBe(false);

    fillEvidence();
    fireEvent.click(screen.getByRole("button", { name: /1\. store my evidence/i }));
    fireEvent.click(await screen.findByRole("button", { name: /2\. post bond and dispute/i }));
    const post = api.mock.calls.find(([u]) => String(u).includes("/dispute"));
    expect(post).toBeTruthy();
    void posts;
    await waitFor(() => expect(txMock.send).toHaveBeenCalledTimes(1));
    const call = txMock.send.mock.calls[0][0] as { functionName: string; args: unknown[] };
    expect(call.functionName).toBe("dispute");
    expect(call.args[0]).toBe(market().contract_address);
    expect(call.args[1]).toBe(HASH_B);
  });

  it("after the window, anyone can finalize an undisputed result", async () => {
    connectWallet();
    mockApi([[/^\/resolutions\/1/, resolution(proposal({ challenge_deadline: iso(-60_000) }))]]);
    renderWithProviders(<OraclePanel market={closedMarket()} />);
    expect(await screen.findByText(/the challenge window ended/i)).toBeInTheDocument();
    expect(screen.queryByText(/dispute this result/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /finalize this result/i }));
    await waitFor(() => expect(txMock.send).toHaveBeenCalled());
    expect((txMock.send.mock.calls[0][0] as { functionName: string }).functionName).toBe("finalize");
  });

  const disputed = (over: Partial<Proposal> = {}) => proposal({ state: "disputed", dispute_status: "disputed", disputer_address: USER.toLowerCase(), dispute_bond: String(100n * E18), dispute_evidence_hash: HASH_B, dispute_evidence_available: true, disputed_at: iso(-600_000), ...over });

  it("a disputed result shows both sides, the stakes, and that a single arbiter decides", async () => {
    mockApi([[/^\/resolutions\/1/, resolution(disputed())]]);
    renderWithProviders(<OraclePanel market={closedMarket()} />);
    expect(await screen.findByText(/waiting for the arbiter/i)).toBeInTheDocument();
    expect(screen.getByText(/a single trusted arbiter decides/i)).toBeInTheDocument();
    expect(screen.getByText(/not a decentralized vote/i)).toBeInTheDocument();
    expect(screen.getByText(/their evidence/i)).toBeInTheDocument();
    expect(screen.getByText(/only the arbiter can decide/i)).toBeInTheDocument();
    expect(screen.queryByText(/you are the arbiter/i)).toBeNull();
  });

  it("the arbiter can record reasoning and decide on-chain, but not with a thin rationale", async () => {
    connectWallet(); authMock.signedIn = true; chain({ arbiter: true });
    const api = mockApi([
      [/^\/resolutions\/1\/arbitration-note/, { evidence_hash: HASH_B, evidence_uri: "u", verdict: 1, market_address: market().contract_address, resolution_manager_address: "0x1", call: "arbitrate", note: "", bonded: false, bond_note: null }],
      [/^\/resolutions\/1/, resolution(disputed())],
    ]);
    renderWithProviders(<OraclePanel market={closedMarket()} />);
    expect(await screen.findByText(/you are the arbiter/i)).toBeInTheDocument();
    const store = screen.getByRole("button", { name: /1\. store reasoning/i });
    expect(store).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/your ruling/i), { target: { value: "NO" } });
    fireEvent.change(screen.getByLabelText(/reasoning/i), { target: { value: "The stored raw data supports NO; the proposer misread the unit." } });
    expect(store).toBeEnabled();
    fireEvent.click(store);
    fireEvent.click(await screen.findByRole("button", { name: /2\. decide on-chain/i }));
    expect(api.mock.calls.some(([u]) => String(u).includes("/arbitration-note"))).toBe(true);
    await waitFor(() => expect(txMock.send).toHaveBeenCalledTimes(1));
    const call = txMock.send.mock.calls[0][0] as { functionName: string; args: unknown[] };
    expect(call.functionName).toBe("arbitrate");
    expect(call.args[1]).toBe(1); // NO
    expect(call.args[2]).toBe(HASH_B);
  });

  it("offers to unwind a dispute only after the 14-day arbiter timeout", async () => {
    connectWallet();
    mockApi([[/^\/resolutions\/1/, resolution(disputed())]]);
    const early = renderWithProviders(<OraclePanel market={closedMarket()} />);
    await screen.findByText(/waiting for the arbiter/i);
    expect(screen.queryByRole("button", { name: /release bonds/i })).toBeNull();
    early.unmount();

    mockApi([[/^\/resolutions\/1/, resolution(disputed({ disputed_at: iso(-15 * 86400_000) }))]]);
    renderWithProviders(<OraclePanel market={closedMarket()} />);
    fireEvent.click(await screen.findByRole("button", { name: /release bonds/i }));
    await waitFor(() => expect(txMock.send).toHaveBeenCalled());
    expect((txMock.send.mock.calls[0][0] as { functionName: string }).functionName).toBe("releaseBonds");
  });

  it("never uses money language", async () => {
    mockApi([[/^\/resolutions\/1/, resolution(disputed())]]);
    const { container } = renderWithProviders(<OraclePanel market={closedMarket()} />);
    await screen.findByText(/waiting for the arbiter/i);
    expect(container.textContent).not.toMatch(/[₹$€]|\bINR\b|\bUSD\b|\bdollar|\bcash\b/i);
    expect(within(container).getAllByText(/test tokens/i).length).toBeGreaterThan(0);
  });
});

describe("Resolution dashboard: bonded proposals for anyone", () => {
  beforeEach(() => resetMocks());
  const dashboardApi = () => mockApi([
    [/^\/markets$/, (u: URL) => page(u.searchParams.get("status") === "closed" ? [closedMarket()] : [])],
    [/^\/resolutions\/1/, resolution()], [/^\/data\/sources/, []],
  ]);

  it("states plainly that this is not a decentralized oracle", async () => {
    dashboardApi();
    renderWithProviders(<Admin />);
    expect(screen.getByText(/this is not a decentralized oracle/i)).toBeInTheDocument();
    expect(screen.getByText(/an undisputed false result is accepted/i)).toBeInTheDocument();
  });

  it("a signed-in non-resolver is offered the bonded route, with the stakes explained", async () => {
    connectWallet(); authMock.signedIn = true;
    reads.handler = ({ functionName }) => ({ data: functionName === "bondAmount" ? 100n * E18 : functionName === "hasRole" ? false : functionName === "bondedChallengeWindow" ? 3600n : "0x" + "01".repeat(32) });
    dashboardApi();
    renderWithProviders(<Admin />);
    expect(await screen.findByText(/anyone can propose a result by escrowing a bond of 100\.00 test tokens/i)).toBeInTheDocument();
    expect(screen.getByText(/if the arbiter rules against you, the challenger gets it/i)).toBeInTheDocument();
    expect(screen.getByText(/current bond: 100\.00 test tokens/i)).toBeInTheDocument();
  });

  it("a resolver proposes without a bond; a visitor is told to connect", async () => {
    connectWallet(); authMock.signedIn = true;
    reads.handler = ({ functionName }) => ({ data: functionName === "hasRole" ? true : functionName === "bondAmount" ? 100n * E18 : "0x" + "01".repeat(32) });
    dashboardApi();
    const a = renderWithProviders(<Admin />);
    expect(await screen.findByText(/you can propose without a bond/i)).toBeInTheDocument();
    expect(screen.queryByText(/escrowing a bond/i)).toBeNull();
    a.unmount();

    resetMocks(); dashboardApi();
    renderWithProviders(<Admin />);
    expect(await screen.findByText(/connect and sign in to propose a result/i)).toBeInTheDocument();
  });
});
