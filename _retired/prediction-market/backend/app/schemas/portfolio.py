from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel

from app.schemas.common import WeiStr


class PositionOut(BaseModel):
    market_id: int
    question: str
    market_status: str
    yes_shares: WeiStr
    no_shares: WeiStr
    avg_entry_price_yes: Decimal | None
    avg_entry_price_no: Decimal | None
    indicative_value: WeiStr  # shares x current LMSR price; NOT a guaranteed redemption value
    realized_pnl: WeiStr
    redeemable_amount: WeiStr  # winning shares redeemable 1:1 once resolved
    refundable: bool


class PortfolioOut(BaseModel):
    address: str
    token_balance: WeiStr | None  # read live from the chain; null if the node is unreachable
    balance_source: str
    positions: list[PositionOut]
    total_indicative_value: WeiStr
    total_realized_pnl: WeiStr
    notice: str


class PortfolioPoint(BaseModel):
    timestamp: datetime
    market_id: int
    action: str
    outcome: str
    token_amount: WeiStr
    cumulative_net_spent: WeiStr  # signed running total of buys minus sells
    transaction_hash: str
