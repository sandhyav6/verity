import { Link, useNavigate, useParams } from "react-router-dom";
import { isAddress } from "viem";
import { FaucetButton } from "../components/WalletBar";
import { Banner, Card, Empty, ErrorState, Loading, Stat, Table, Td } from "../components/ui";
import { usePortfolio } from "../hooks/queries";
import { useWallet } from "../hooks/useWallet";
import { price, shortAddr, tokens } from "../lib/format";

export function Portfolio() {
  const param = useParams().address;
  const w = useWallet();
  const nav = useNavigate();
  const address = param ?? w.address;
  const valid = !!address && isAddress(address);
  const { data, isLoading, error, refetch } = usePortfolio(valid ? address : undefined);

  if (!address) return <Empty title="Connect a wallet to see your portfolio" action={<button className="rounded-lg bg-accent px-4 py-2 text-sm text-white" onClick={w.connect}>Connect wallet</button>}>Portfolios are public on-chain data: you can also open any address at /portfolio/0x…</Empty>;
  if (!valid) return <Empty title="Not a valid wallet address" action={<Link className="text-accent underline" to="/portfolio">Back</Link>}>“{address}” is not an Ethereum address.</Empty>;
  const own = !!w.address && address.toLowerCase() === w.address.toLowerCase();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-2xl font-semibold">Portfolio</h1><p className="num-col mt-1 break-all text-sm text-ink2">{address}{own && " (you)"}</p></div>
        {own && !w.wrongNetwork && <FaucetButton />}
      </div>
      <form className="flex max-w-xl gap-2" onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get("a") as string; if (isAddress(v)) nav(`/portfolio/${v}`); }}>
        <input name="a" aria-label="Look up another address" placeholder="Look up another wallet address (0x…)" className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm" />
        <button className="rounded-lg border border-line px-3 text-sm">View</button>
      </form>

      {isLoading ? <Loading /> : error ? <ErrorState error={error} retry={() => refetch()} /> : data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Stat label="Test-token balance" value={<span className="num-col">{tokens(data.token_balance)}</span>} hint={data.balance_source} />
            <Stat label="Indicative position value" value={<span className="num-col">{tokens(data.total_indicative_value)}</span>} hint="LMSR mark of open positions" />
            <Stat label="Realized gain / loss" value={<span className="num-col">{Number(data.total_realized_pnl) >= 0 ? "+" : "−"}{tokens(BigInt(data.total_realized_pnl.replace("-", "")))}</span>} hint="after sells, redemptions and refunds" />
          </div>
          <Banner>Indicative value is the market's current LMSR price times your shares. It is <strong>not</strong> a guaranteed redemption value: only winning shares of a resolved market redeem, 1 token each.</Banner>
          <Card title="Positions" subtitle={data.notice}>
            {data.positions.length === 0 ? <Empty title="No positions yet">Buy YES or NO shares on a market and they will show up here.</Empty> : (
              <Table head={["Market", "Status", "YES shares", "NO shares", "Avg entry YES / NO", "Indicative value", "Realized", "Action"]}>
                {data.positions.map((p) => (
                  <tr key={p.market_id}>
                    <Td><Link className="hover:underline" to={`/markets/${p.market_id}`}>{p.question.slice(0, 60)}</Link></Td>
                    <Td>{p.market_status}</Td>
                    <Td className="num-col">{tokens(p.yes_shares, 2)}</Td><Td className="num-col">{tokens(p.no_shares, 2)}</Td>
                    <Td className="num-col">{price(p.avg_entry_price_yes)} / {price(p.avg_entry_price_no)}</Td>
                    <Td className="num-col">{p.market_status === "resolved" || p.market_status === "invalid" ? "-" : tokens(p.indicative_value)}</Td>
                    <Td className="num-col">{Number(p.realized_pnl) >= 0 ? "+" : "−"}{tokens(BigInt(p.realized_pnl.replace("-", "")))}</Td>
                    <Td>{p.redeemable_amount !== "0" ? <Link className="text-accent underline" to={`/markets/${p.market_id}`}>Redeem {tokens(p.redeemable_amount)}</Link> : p.refundable ? <Link className="text-accent underline" to={`/markets/${p.market_id}`}>Claim refund</Link> : "-"}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <p className="text-xs text-muted">Positions come from indexed events for {shortAddr(address)}; balances are read live from the chain.</p>
        </>
      )}
    </div>
  );
}
