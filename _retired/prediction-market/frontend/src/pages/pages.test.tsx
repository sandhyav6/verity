import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import { DataExplorer } from "./DataExplorer";
import { MarketDetail } from "./MarketDetail";
import { Markets } from "./Markets";
import { Portfolio } from "./Portfolio";
import { Transactions } from "./Transactions";
import { Layout } from "../components/Layout";
import { WalletBar } from "../components/WalletBar";
import { PriceHistoryChart } from "../charts/PriceHistoryChart";
import { USER, authMock, connectWallet, reads, resetMocks, walletMock } from "../test/wallet-mocks";
import { market, mockApi, page, renderWithProviders } from "../test/utils";
import type { ExternalRecord, Overview } from "../lib/types";

vi.mock("../hooks/useWallet", async () => (await import("../test/wallet-mocks")).walletModule);
vi.mock("../hooks/useAuth", async () => (await import("../test/wallet-mocks")).authModule);
vi.mock("../hooks/useTx", async () => (await import("../test/wallet-mocks")).txModule);
vi.mock("wagmi", async () => (await import("../test/wallet-mocks")).wagmiModule);

const EMPTY_OVERVIEW: Overview = {
  source: "indexed blockchain events (PostgreSQL read model)", markets_total: 0, markets_by_status: { active: 0, closed: 0, resolved: 0, invalid: 0 },
  trades_total: 0, unique_traders: 0, total_volume: "0", last_indexed_block: 9, indexed_at: null, activity: [],
};
const emptyApi = () => [
  [/^\/analytics\/overview/, EMPTY_OVERVIEW], [/^\/analytics\/categories/, []], [/^\/analytics\/markets/, []],
  [/^\/markets$/, page([])], [/^\/trades/, page([])], [/^\/data\/sources/, []],
] as [RegExp, unknown][];

beforeEach(() => {
  resetMocks();
  reads.handler = () => ({ data: undefined });
});

describe("Markets: browsing, search and filters", () => {
  it("lists markets with their implied probabilities and closing information", async () => {
    mockApi([[/^\/markets$/, page([market({ trade_count: 3, yes_price: "0.62", no_price: "0.38", volume: "40000000000000000000" })])]]);
    renderWithProviders(<Markets />, { route: "/markets" });
    expect(await screen.findByRole("link", { name: /Chennai receive more than 100 mm/i })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /YES 62\.0%, NO 38\.0%/ })).toBeInTheDocument();
    expect(screen.getByText(/closes in/i)).toBeInTheDocument();
    expect(screen.getByText(/3 trades · 40 tokens/)).toBeInTheDocument();
  });

  it("does not present the 50/50 opening price as a consensus", async () => {
    mockApi([[/^\/markets$/, page([market()])]]);
    renderWithProviders(<Markets />, { route: "/markets" });
    expect(await screen.findByText(/no trades yet: opening price, not a trader consensus/i)).toBeInTheDocument();
  });

  it("sends search, category, status and sort to the API", async () => {
    const api = mockApi([[/^\/markets$/, page([market()])]]);
    renderWithProviders(<Markets />, { route: "/markets" });
    await screen.findByRole("link", { name: /Chennai/ });
    fireEvent.change(screen.getByLabelText("Search questions"), { target: { value: "rain" } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "weather" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "closed" } });
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "volume:desc" } });
    await waitFor(() => {
      const last = new URL(String(api.mock.calls.at(-1)![0]));
      expect(Object.fromEntries(last.searchParams)).toMatchObject({ q: "rain", category: "weather", status: "closed", sort: "volume", order: "desc" });
    });
  });

  it("distinguishes 'nothing exists' from 'nothing matches' and lets you clear filters", async () => {
    mockApi([[/^\/markets$/, page([])]]);
    const view = renderWithProviders(<Markets />, { route: "/markets" });
    expect(await screen.findByText(/no markets exist yet/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is pre-loaded/i)).toBeInTheDocument();
    view.unmount();

    mockApi([[/^\/markets$/, page([])]]);
    renderWithProviders(<Markets />, { route: "/markets?category=sports" });
    expect(await screen.findByText(/no markets match these filters/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear filters/i })).toBeInTheDocument();
  });

  it("shows an error with a retry instead of a blank page when the API fails", async () => {
    mockApi([[/^\/markets$/, new Response(JSON.stringify({ detail: "database unavailable" }), { status: 503 })]]);
    renderWithProviders(<Markets />, { route: "/markets" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/database unavailable/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("paginates", async () => {
    const api = mockApi([[/^\/markets$/, page([market()], { total: 30, limit: 12 })]]);
    renderWithProviders(<Markets />, { route: "/markets" });
    await screen.findByText(/Page 1 of 3/);
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(new URL(String(api.mock.calls.at(-1)![0])).searchParams.get("offset")).toBe("12"));
  });
});

describe("Dashboard", () => {
  it("shows honest empty states: zeros, no placeholders, and says why", async () => {
    mockApi(emptyApi());
    renderWithProviders(<Dashboard />);
    expect(await screen.findByText(/nothing has happened on-chain yet/i)).toBeInTheDocument();
    expect(screen.getByText(/never filled with placeholders/i)).toBeInTheDocument();
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/no markets are open for trading/i)).toBeInTheDocument();
    expect(screen.getAllByText(/no trades yet\./i).length).toBeGreaterThanOrEqual(2); // chart + recent trades
    expect(screen.getByText(/there is no seed or demo data/i)).toBeInTheDocument();
  });

  it("shows real statistics and the data-source status when there is activity", async () => {
    mockApi([
      [/^\/analytics\/overview/, { ...EMPTY_OVERVIEW, markets_total: 2, markets_by_status: { active: 1, closed: 0, resolved: 1, invalid: 0 }, trades_total: 7, unique_traders: 3, total_volume: "120000000000000000000" }],
      [/^\/analytics\/categories/, [{ category: "weather", markets: 2, trades: 7, volume: "120000000000000000000" }]],
      [/^\/markets$/, page([market({ trade_count: 2 })])], [/^\/trades/, page([])],
      [/^\/data\/sources/, [{ provider: "open-meteo", category: "weather", mode: "automated", terms_note: "", records: 2, last_retrieved_at: "2026-11-04T12:00:00Z", last_seen_at: "2026-11-04T12:00:00Z", freshness: "fresh" }, { provider: "rbi", category: "economy", mode: "manual submission", terms_note: "", records: 0, last_retrieved_at: null, last_seen_at: null, freshness: "no data" }]],
    ]);
    renderWithProviders(<Dashboard />);
    expect(await screen.findByText(/1 open · 0 awaiting result · 1 resolved/)).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("open-meteo")).toBeInTheDocument();
    expect(screen.getByText(/no data yet/i)).toBeInTheDocument();
    expect(screen.getAllByText(/automated|manual submission/).length).toBe(2);
  });
});

describe("Wallet connection and network", () => {
  it("offers to connect, and tells the user when no wallet is installed", () => {
    renderWithProviders(<WalletBar />);
    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    expect(walletMock.connect).toHaveBeenCalled();
  });

  it("without an injected wallet the button is disabled and explains", () => {
    walletMock.hasInjectedWallet = false;
    renderWithProviders(<WalletBar />);
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeDisabled();
    expect(screen.getByText(/install metamask to trade/i)).toBeInTheDocument();
  });

  it("surfaces a wallet connection error", () => {
    walletMock.error = "User rejected the request.";
    renderWithProviders(<WalletBar />);
    expect(screen.getByRole("alert")).toHaveTextContent(/rejected/i);
  });

  it("shows the address, a sign-in step, and a disconnect that also signs out", () => {
    connectWallet();
    renderWithProviders(<WalletBar />);
    expect(screen.getByTitle(USER)).toHaveTextContent("0x90F7…b906");
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(authMock.signIn).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(authMock.signOut).toHaveBeenCalled();
    expect(walletMock.disconnect).toHaveBeenCalled();
  });

  it("a signed-in wallet shows a confirmation instead of the sign-in button", () => {
    connectWallet();
    authMock.signedIn = true;
    renderWithProviders(<WalletBar />);
    expect(screen.getByText(/signed in/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^sign in$/i })).toBeNull();
  });

  it("on the wrong network it shows only a switch button (no balance, no sign-in)", () => {
    connectWallet({ wrongNetwork: true });
    renderWithProviders(<WalletBar />);
    fireEvent.click(screen.getByRole("button", { name: /wrong network: switch to hardhat local/i }));
    expect(walletMock.switchNetwork).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^sign in$/i })).toBeNull();
  });

  it("surfaces sign-in failures in words", () => {
    connectWallet();
    authMock.signInError = "You rejected the request in your wallet. Nothing was sent.";
    renderWithProviders(<WalletBar />);
    expect(screen.getByRole("alert")).toHaveTextContent(/rejected the request/i);
  });
});

describe("Layout and responsiveness", () => {
  it("always shows the test-token disclaimer and the data attributions", () => {
    mockApi(emptyApi());
    renderWithProviders(<Layout />);
    expect(screen.getByTestId("disclaimer")).toHaveTextContent(/no monetary value/i);
    expect(screen.getByText(/open-meteo\.com/i)).toBeInTheDocument();
    expect(screen.getByText(/not a decentralized oracle/i)).toBeInTheDocument();
  });

  it("the mobile menu toggles the navigation and its aria state", () => {
    renderWithProviders(<Layout />);
    const toggle = screen.getByRole("button", { name: /menu/i });
    const nav = screen.getByRole("navigation", { name: /main/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(nav.className).toMatch(/\bhidden\b/); // collapsed below the md breakpoint
    expect(nav.className).toMatch(/md:flex/); // always visible from md up
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(nav.className).toMatch(/\bflex\b/);
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["Dashboard", "Markets", "Portfolio", "Transactions", "Analytics", "Data Explorer", "Create", "Resolution"]);
  });
});

describe("Market details", () => {
  const detail = (m = market()) => mockApi([
    [/^\/markets\/1\/history/, page([])], [/^\/markets\/1\/trades/, page([])], [/^\/markets\/1\/evidence/, []],
    [/^\/resolutions\/1/, { market_id: 1, market_status: m.status, winning_outcome: null, server_time: "2026-11-04T12:00:00Z", proposals: [], trust_model: "Stage 1: a trusted resolver account proposes the outcome." }],
    [/^\/markets\/1$/, m],
  ]);

  it("shows rules, source, status and an honest empty chart for an untraded market", async () => {
    detail();
    renderWithProviders(<MarketDetail />, { route: "/markets/1", path: "/markets/:id" });
    expect(await screen.findByRole("heading", { name: /Chennai receive more than 100 mm/i })).toBeInTheDocument();
    expect(screen.getByText(/the market opens at 50% \/ 50%; that is a starting point, not a forecast/i)).toBeInTheDocument();
    expect(await screen.findByText(/no trades yet, so there is no price history/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open-Meteo" })).toHaveAttribute("href", "https://open-meteo.com");
    expect(screen.getByText(/nothing to resolve yet: trading is still open/i)).toBeInTheDocument();
  });

  it("warns when stored metadata does not match the on-chain hash", async () => {
    detail(market({ metadata_verified: false }));
    renderWithProviders(<MarketDetail />, { route: "/markets/1", path: "/markets/:id" });
    expect(await screen.findByText(/definition not verified against the on-chain hash/i)).toBeInTheDocument();
  });

  it("flags data-rule markets as resolving from a weather model, with attribution", async () => {
    detail(market({ resolution_data_note: "Resolves from Open-Meteo reanalysis data (a weather model on a coarse grid), NOT ground-station observations." }));
    renderWithProviders(<MarketDetail />, { route: "/markets/1", path: "/markets/:id" });
    expect(await screen.findByText(/NOT ground-station observations/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /open-meteo\.com/i }).length).toBeGreaterThan(0);
  });

  it("explains an unknown market instead of crashing", async () => {
    mockApi([[/^\/markets\/99$/, new Response(JSON.stringify({ detail: "market not found" }), { status: 404 })]]);
    renderWithProviders(<MarketDetail />, { route: "/markets/99", path: "/markets/:id" });
    expect(await screen.findByText(/market not found/i)).toBeInTheDocument();
    expect(screen.getByText(/wait a few seconds for the indexer/i)).toBeInTheDocument();
  });

  it("shows settlement actions only once a market is resolved", async () => {
    detail(market({ status: "resolved", winning_outcome: "YES" }));
    connectWallet();
    reads.handler = ({ functionName }) => ({ data: functionName === "yesShares" ? 20n * 10n ** 18n : functionName.endsWith("Claimed") ? false : 0n });
    renderWithProviders(<MarketDetail />, { route: "/markets/1", path: "/markets/:id" });
    expect(await screen.findByRole("button", { name: /redeem 20\.0000 tokens/i })).toBeEnabled();
    expect(screen.getByText(/losing shares are worth nothing/i)).toBeInTheDocument();
  });

  it("a loser has nothing to redeem", async () => {
    detail(market({ status: "resolved", winning_outcome: "YES" }));
    connectWallet();
    reads.handler = ({ functionName }) => ({ data: functionName === "noShares" ? 30n * 10n ** 18n : functionName.endsWith("Claimed") ? false : 0n });
    renderWithProviders(<MarketDetail />, { route: "/markets/1", path: "/markets/:id" });
    expect(await screen.findByRole("button", { name: /nothing to redeem/i })).toBeDisabled();
  });
});

describe("Probability chart", () => {
  const snap = (p: string, t: string) => ({ block_number: 5, timestamp: t, yes_price: p, q_yes: "0", q_no: "0", transaction_hash: "0x" + "1".repeat(64) });

  it("has an empty state and invents nothing", () => {
    renderWithProviders(<PriceHistoryChart history={[]} />);
    expect(screen.getByText(/no price history/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show table/i })).toBeNull();
  });

  it("a single trade is reported as a single observation, not a curve", () => {
    renderWithProviders(<PriceHistoryChart history={[snap("0.56", "2026-11-04T10:00:00Z")]} />);
    expect(screen.getByText(/1 trade so far: a single observation, no curve is drawn/i)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /1 observations/ })).toBeInTheDocument();
  });

  it("offers an accessible table view with exactly the real observations", () => {
    renderWithProviders(<PriceHistoryChart history={[snap("0.56", "2026-11-04T10:00:00Z"), snap("0.51", "2026-11-04T10:05:00Z")]} />);
    fireEvent.click(screen.getByRole("button", { name: /show table/i }));
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(3); // header + 2 trades
    expect(rows[1]).toHaveTextContent("56.00%");
    expect(rows[2]).toHaveTextContent("51.00%");
  });
});

describe("Portfolio", () => {
  it("asks for a wallet when none is connected", () => {
    renderWithProviders(<Portfolio />, { route: "/portfolio", path: "/portfolio/:address?" });
    expect(screen.getByText(/connect a wallet to see your portfolio/i)).toBeInTheDocument();
  });

  it("rejects an address that is not an address", () => {
    renderWithProviders(<Portfolio />, { route: "/portfolio/not-an-address", path: "/portfolio/:address?" });
    expect(screen.getByText(/not a valid wallet address/i)).toBeInTheDocument();
  });

  it("shows positions with the 'not a guaranteed value' warning and an empty state otherwise", async () => {
    connectWallet();
    mockApi([[/^\/portfolio\/0x90/i, { address: USER.toLowerCase(), token_balance: "986720800000000000000", balance_source: "chain (live eth_call)", positions: [], total_indicative_value: "0", total_realized_pnl: "0", notice: "TEST tokens only." }]]);
    renderWithProviders(<Portfolio />, { route: "/portfolio", path: "/portfolio/:address?" });
    expect(await screen.findByText("986.72")).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/is not a guaranteed redemption value/);
    expect(screen.getByText(/no positions yet/i)).toBeInTheDocument();
  });

  it("marks the balance as unavailable rather than inventing one when the node is unreachable", async () => {
    connectWallet();
    mockApi([[/^\/portfolio\/0x90/i, { address: USER.toLowerCase(), token_balance: null, balance_source: "unavailable (node unreachable)", positions: [], total_indicative_value: "0", total_realized_pnl: "0", notice: "x" }]]);
    renderWithProviders(<Portfolio />, { route: "/portfolio", path: "/portfolio/:address?" });
    expect(await screen.findByText(/unavailable \(node unreachable\)/i)).toBeInTheDocument();
  });
});

describe("Transactions", () => {
  it("shows empty states for a new session and for a wallet without trades", async () => {
    sessionStorage.clear();
    connectWallet();
    mockApi([[/^\/trades/, page([])]]);
    renderWithProviders(<Transactions />);
    expect(screen.getByText(/you have not sent any transaction in this session/i)).toBeInTheDocument();
    expect(await screen.findByText(/you have no trades yet/i)).toBeInTheDocument();
  });

  it("lists confirmed trades with hash, block and execution price", async () => {
    mockApi([[/^\/trades/, page([{ market_id: 1, market_question: "Will it rain?", wallet_address: USER.toLowerCase(), outcome: "YES", action: "buy", shares: "25000000000000000000", token_amount: "13279200000000000000", execution_price: "0.5312", yes_price_after: "0.562", transaction_hash: "0x" + "ab".repeat(32), block_number: 17, log_index: 0, timestamp: "2026-11-04T10:00:00Z", explorer_url: null }])]]);
    renderWithProviders(<Transactions />);
    expect(await screen.findByText("0.531")).toBeInTheDocument();
    expect(screen.getByText("17")).toBeInTheDocument();
    expect(screen.getByText("13.28")).toBeInTheDocument();
    expect(screen.getByText(/✓ confirmed/)).toBeInTheDocument();
  });
});

describe("Data Explorer", () => {
  const rec = (over: Partial<ExternalRecord> = {}): ExternalRecord => ({
    is_external_data: true, id: 1, category: "weather", provider: "open-meteo", dataset: "era5", dataset_version: "Open-Meteo archive API v1",
    metric: "precipitation_sum_total", value: "4.2000000000", text: null, unit: "mm", location: "Chennai", grid_latitude: "13.00000", grid_longitude: "80.25000",
    period_start: "2026-09-05", period_end: "2026-09-15", observed_at: "2026-09-15T18:29:59Z", retrieved_at: "2026-11-04T18:00:00Z", last_seen_at: "2026-11-04T18:00:00Z",
    source_url: "https://archive-api.open-meteo.com/v1/archive?latitude=13.0827", raw_payload_reference: "/data/raw/" + "ab".repeat(32), raw_payload_hash: "ab".repeat(32),
    transformation: "Sum of daily precipitation_sum", validation_status: "valid", validation_notes: ["11 days, all present"],
    attribution: "Weather data by Open-Meteo.com (CC BY 4.0)", freshness: { state: "fresh", age_seconds: 120, note: "" }, supersedes_id: null, is_latest: true,
    entered_manually: false, submitted_by: null, ...over,
  });
  const base = (records: ExternalRecord[]) => mockApi([
    [/^\/data\/sources/, []], [/^\/data\/raw\//, JSON.stringify({ daily: { time: ["2026-09-05", "2026-09-06"], precipitation_sum: [4.2, null] } })],
    [/^\/data\/(economic|weather|sports|technology)/, page(records)],
  ]);

  it("says plainly that this is external data, and shows full provenance", async () => {
    base([rec()]);
    renderWithProviders(<DataExplorer />);
    expect(screen.getByText(/external, real-world data/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Weather" }));
    expect(await screen.findByText("✓ valid")).toBeInTheDocument();
    for (const t of [/Observation time/, /Retrieved/, /Raw data SHA-256/, /How it was derived/, /Model grid point used/]) expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    expect(screen.getByText(/CC BY 4\.0/)).toBeInTheDocument();
    expect(screen.getByText(/reanalysis model data/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /archive-api\.open-meteo\.com/ })).toHaveAttribute("href", expect.stringContaining("open-meteo"));
  });

  it("labels incomplete data and withholds a total", async () => {
    base([rec({ validation_status: "incomplete", value: null, validation_notes: ["6 of 8 days have no data yet (reanalysis delay)"] })]);
    renderWithProviders(<DataExplorer />);
    fireEvent.click(screen.getByRole("tab", { name: "Weather" }));
    expect(await screen.findByText(/no total yet/i)).toBeInTheDocument();
    expect(screen.getByText(/incomplete: some days not published yet/i)).toBeInTheDocument();
  });

  it("labels manually entered records as not verified by this site", async () => {
    base([rec({ category: "economy", provider: "rbi", metric: "policy_repo_rate", dataset: null, value: "5.5000000000", unit: "%", validation_status: "manual_submitted", entered_manually: true, freshness: { state: "manual", age_seconds: 10, note: "" }, attribution: null })]);
    renderWithProviders(<DataExplorer />);
    expect(await screen.findByText(/entered by an administrator, not verified by this site/i)).toBeInTheDocument();
    expect(screen.getByText(/manual record/i)).toBeInTheDocument();
    expect(screen.queryByText(/reanalysis model data/i)).toBeNull(); // only for the weather provider
  });

  it("marks stale and superseded records", async () => {
    base([rec({ freshness: { state: "stale", age_seconds: 200000, note: "" }, is_latest: false })]);
    renderWithProviders(<DataExplorer />);
    fireEvent.click(screen.getByRole("tab", { name: "Weather" }));
    expect(await screen.findByText(/stale/)).toBeInTheDocument();
    expect(screen.getByText(/superseded by a revision/i)).toBeInTheDocument();
  });

  it("has a clear empty state that says nothing is simulated, and passes filters to the API", async () => {
    const api = base([]);
    renderWithProviders(<DataExplorer />);
    expect(await screen.findByText(/no economy data yet/i)).toBeInTheDocument();
    expect(screen.getByText(/does not crawl those sources\. nothing is pre-loaded or simulated/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/validation status/i), { target: { value: "incomplete" } });
    await waitFor(() => expect(new URL(String(api.mock.calls.at(-1)![0])).searchParams.get("validation_status")).toBe("incomplete"));
    fireEvent.click(screen.getByLabelText(/include superseded revisions/i));
    await waitFor(() => expect(new URL(String(api.mock.calls.at(-1)![0])).searchParams.get("latest_only")).toBe("false"));
  });
});
