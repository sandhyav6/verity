import json
from decimal import Decimal, localcontext

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Market, MarketMetadata, Position, Trade
from app.schemas.common import TEST_TOKEN_NOTICE
from app.schemas.portfolio import PortfolioOut, PortfolioPoint, PositionOut
from app.services.market_service import status_of


def _avg_price(cost: int, shares: int) -> Decimal | None:
    return (Decimal(cost) / Decimal(shares)) if shares else None


def build_portfolio(db: Session, address: str, chain_id: int, token_balance: int | None) -> PortfolioOut:
    address = address.lower()
    rows = db.execute(
        select(Position, Market, MarketMetadata)
        .join(Market, Market.id == Position.market_id)
        .outerjoin(MarketMetadata, MarketMetadata.metadata_hash == Market.metadata_hash)
        .where(Position.wallet_address == address, Market.chain_id == chain_id)
        .order_by(Market.blockchain_market_id)
    ).all()

    positions: list[PositionOut] = []
    total_value = total_pnl = 0
    with localcontext() as ctx:
        ctx.prec = 80
        for pos, market, meta in rows:
            yes_sh, no_sh = int(pos.yes_shares), int(pos.no_shares)
            p_yes = Decimal(market.yes_price)
            value = int(Decimal(yes_sh) * p_yes + Decimal(no_sh) * (1 - p_yes))
            if market.status in ("resolved", "invalid"):
                value = 0  # settled: use redeemable_amount / refund instead of an LMSR mark
            redeemable = 0
            if market.status == "resolved":
                redeemable = yes_sh if market.winning_outcome == "YES" else no_sh
            positions.append(
                PositionOut(
                    market_id=market.blockchain_market_id,
                    question=json.loads(meta.canonical_json)["question"] if meta else "(metadata not registered)",
                    market_status=status_of(market),
                    yes_shares=str(yes_sh),
                    no_shares=str(no_sh),
                    avg_entry_price_yes=_avg_price(int(pos.yes_cost), yes_sh),
                    avg_entry_price_no=_avg_price(int(pos.no_cost), no_sh),
                    indicative_value=str(value),
                    realized_pnl=str(int(pos.realized_pnl)),
                    redeemable_amount=str(redeemable),
                    refundable=market.status == "invalid" and int(pos.cost_basis) > 0,
                )
            )
            total_value += value
            total_pnl += int(pos.realized_pnl)

    return PortfolioOut(
        address=address,
        token_balance=str(token_balance) if token_balance is not None else None,
        balance_source="chain (live eth_call)" if token_balance is not None else "unavailable (node unreachable)",
        positions=positions,
        total_indicative_value=str(total_value),
        total_realized_pnl=str(total_pnl),
        notice=TEST_TOKEN_NOTICE + " Indicative value is an LMSR mark, not a guaranteed redemption value.",
    )


def portfolio_history(db: Session, address: str, chain_id: int, limit: int, offset: int) -> list[PortfolioPoint]:
    """Every trade of the wallet in order, with the running net spend (buys - sells)."""
    address = address.lower()
    rows = db.execute(
        select(Trade, Market)
        .join(Market, Market.id == Trade.market_id)
        .where(Trade.wallet_address == address, Market.chain_id == chain_id)
        .order_by(Trade.block_number, Trade.log_index)
    ).all()
    out, running = [], 0
    for t, m in rows:
        amount = int(t.token_amount)
        running += amount if t.action == "buy" else -amount
        out.append(
            PortfolioPoint(
                timestamp=t.timestamp, market_id=m.blockchain_market_id, action=t.action, outcome=t.outcome,
                token_amount=str(amount), cumulative_net_spent=str(running), transaction_hash=t.transaction_hash,
            )
        )
    return out[offset : offset + limit]
