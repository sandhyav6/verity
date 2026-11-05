import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TradePanel } from "./TradePanel";
import { USER, connectWallet, reads, resetMocks, txMock, walletMock } from "../test/wallet-mocks";
import { market, renderWithProviders } from "../test/utils";

vi.mock("../hooks/useWallet", async () => (await import("../test/wallet-mocks")).walletModule);
vi.mock("../hooks/useTx", async () => (await import("../test/wallet-mocks")).txModule);
vi.mock("wagmi", async () => (await import("../test/wallet-mocks")).wagmiModule);

const E18 = 10n ** 18n;
const QUOTE = 13_279_200_000_000_000_000n; // 13.2792 tokens, as the contract would answer

function chainAnswers(over: Record<string, unknown> = {}) {
  reads.handler = ({ functionName }) => {
    const table: Record<string, unknown> = { balanceOf: 1000n * E18, yesShares: 0n, noShares: 0n, quoteBuy: QUOTE, quoteSell: 2n * E18, ...over };
    return functionName in table ? (table[functionName] instanceof Error ? { error: table[functionName] } : { data: table[functionName] }) : {};
  };
}
const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("TradePanel", () => {
  beforeEach(() => {
    resetMocks();
    chainAnswers();
  });

  it("asks a visitor to connect a wallet and never offers to trade", () => {
    renderWithProviders(<TradePanel market={market()} />);
    fireEvent.click(screen.getByRole("button", { name: /connect wallet to trade/i }));
    expect(walletMock.connect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /^review/i })).toBeNull();
  });

  it("explains when no wallet is installed", () => {
    walletMock.hasInjectedWallet = false;
    renderWithProviders(<TradePanel market={market()} />);
    expect(screen.getByRole("button", { name: /install metamask/i })).toBeDisabled();
  });

  it("offers to switch network instead of trading on the wrong chain", () => {
    connectWallet({ wrongNetwork: true });
    renderWithProviders(<TradePanel market={market()} />);
    fireEvent.click(screen.getByRole("button", { name: /switch to hardhat local to trade/i }));
    expect(walletMock.switchNetwork).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /^review/i })).toBeNull();
  });

  it("shows the browser estimate and the contract's authoritative quote as separate things", async () => {
    connectWallet();
    renderWithProviders(<TradePanel market={market()} />);
    type(/number of shares/i, "25");
    expect(screen.getByText(/estimate \(calculated in your browser, not binding\)/i)).toBeInTheDocument();
    expect(screen.getByText(/contract quote \(authoritative/i)).toBeInTheDocument();
    expect(await screen.findByText(/you pay/i)).toBeInTheDocument();
    expect(screen.getAllByText(/13\.2792 tokens/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/maximum you can be charged \(\+1%\)/i)).toBeInTheDocument();
    expect(screen.getByText("13.4120 tokens")).toBeInTheDocument(); // contract quote + 1 % slippage limit
  });

  it("requires an explicit confirmation step before anything is sent", async () => {
    connectWallet();
    renderWithProviders(<TradePanel market={market()} />);
    type(/number of shares/i, "25");
    fireEvent.click(await screen.findByRole("button", { name: /review buy yes/i }));
    expect(txMock.send).not.toHaveBeenCalled(); // reviewing is not sending
    expect(screen.getByRole("dialog", { name: /confirm trade/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(txMock.send).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sends the right call: outcome, exact shares, a slippage-capped max cost and a near deadline", async () => {
    connectWallet();
    renderWithProviders(<TradePanel market={market()} />);
    fireEvent.click(screen.getByRole("radio", { name: /^no/i })); // outcome NO
    type(/number of shares/i, "25");
    fireEvent.click(await screen.findByRole("button", { name: /review buy no/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm buy/i }));
    await waitFor(() => expect(txMock.send).toHaveBeenCalledTimes(1));
    const call = txMock.send.mock.calls[0][0] as { functionName: string; args: bigint[]; address: string };
    expect(call.functionName).toBe("buy");
    const [outcome, shares, maxCost, deadline] = call.args;
    expect(outcome).toBe(1); // NO
    expect(shares).toBe(25n * E18);
    expect(maxCost).toBe((QUOTE * 10100n + 9999n) / 10000n); // contract quote +1 %, rounded up
    expect(Number(deadline)).toBeGreaterThan(Date.now() / 1000);
    expect(Number(deadline)).toBeLessThan(Date.now() / 1000 + 3600);
    expect(call.address).toBe(market().contract_address);
  });

  it("cannot be submitted again while a transaction is awaiting the wallet or pending", async () => {
    connectWallet();
    txMock.busy = true;
    txMock.state = { phase: "pending", hash: "0x" + "12".repeat(32) };
    renderWithProviders(<TradePanel market={market()} />);
    type(/number of shares/i, "25");
    expect(await screen.findByRole("button", { name: /waiting for confirmation/i })).toBeDisabled();
    expect(screen.getByText(/submitted/i)).toBeInTheDocument();
  });

  it("shows a readable failure message and nothing else when the transaction fails", () => {
    connectWallet();
    txMock.state = { phase: "failed", error: "The price moved beyond your slippage tolerance. Refresh the quote and try again." };
    renderWithProviders(<TradePanel market={market()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/slippage tolerance/i);
  });

  it("shows the contract's own refusal (e.g. price limit) instead of a quote", async () => {
    connectWallet();
    chainAnswers({ quoteBuy: Object.assign(new Error("DivergenceTooLarge"), { name: "Error" }) });
    renderWithProviders(<TradePanel market={market()} />);
    type(/number of shares/i, "25");
    expect(await screen.findByText(/push the price past the market's limit/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review buy yes/i })).toBeDisabled();
  });

  it("blocks trades the contract would reject, before asking the contract", () => {
    connectWallet();
    renderWithProviders(<TradePanel market={market()} />);
    type(/number of shares/i, "101"); // above one liquidity parameter
    expect(screen.getByRole("alert")).toHaveTextContent(/too large/i);
    expect(screen.getByRole("button", { name: /review buy yes/i })).toBeDisabled();
    type(/number of shares/i, "-3");
    expect(screen.getByRole("alert")).toHaveTextContent(/positive number/i);
    type(/number of shares/i, "abc");
    expect(screen.getByRole("alert")).toHaveTextContent(/positive number/i);
  });

  it("warns when the balance cannot cover the contract's price", async () => {
    connectWallet();
    chainAnswers({ balanceOf: 5n * E18 });
    renderWithProviders(<TradePanel market={market()} />);
    type(/number of shares/i, "25");
    expect(await screen.findByText(/not enough test tokens/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review buy yes/i })).toBeDisabled();
  });

  it("converts a token budget into shares and never shows a currency symbol", async () => {
    connectWallet();
    renderWithProviders(<TradePanel market={market()} />);
    fireEvent.click(screen.getByLabelText(/enter token budget/i));
    fireEvent.change(screen.getByRole("textbox", { name: /token budget/i }), { target: { value: "10" } });
    expect(await screen.findByText(/estimated cost/i)).toBeInTheDocument();
    expect(screen.getByText("Shares").nextSibling?.textContent).toMatch(/^\d+\.\d{4}$/);
    expect(document.body.textContent).not.toMatch(/[₹$€]/);
  });

  it("selling is limited to the shares you hold", () => {
    connectWallet();
    chainAnswers({ yesShares: 10n * E18 });
    renderWithProviders(<TradePanel market={market({ q_yes: "10000000000000000000" })} />);
    fireEvent.click(screen.getByRole("tab", { name: /sell/i }));
    type(/number of shares/i, "11");
    expect(screen.getByRole("alert")).toHaveTextContent(/hold only 10\.0000 yes shares/i);
    fireEvent.click(screen.getByRole("button", { name: /max/i }));
    expect((screen.getByLabelText(/number of shares/i) as HTMLInputElement).value).toBe("10");
  });

  it.each([
    ["closed", /trading has closed/i],
    ["resolved", /is resolved/i],
    ["invalid", /is voided/i],
  ] as const)("disables trading for a %s market and says why", (status, text) => {
    connectWallet();
    renderWithProviders(<TradePanel market={market({ status })} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByLabelText(/number of shares/i)).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^review/i })).toBeDisabled();
  });

  it("states that it is test-only and that the estimate is not binding", () => {
    connectWallet();
    renderWithProviders(<TradePanel market={market()} />);
    expect(screen.getByText(/test tokens only\. no money is involved/i)).toBeInTheDocument();
    expect(screen.getByText(/recomputes the price when your transaction runs/i)).toBeInTheDocument();
    expect(USER).toBeTruthy();
  });
});
