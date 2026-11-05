from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel

from app.schemas.common import WeiStr


class TradeOut(BaseModel):
    market_id: int
    market_question: str | None = None
    wallet_address: str
    outcome: Literal["YES", "NO"]
    action: Literal["buy", "sell"]
    shares: WeiStr
    token_amount: WeiStr
    execution_price: Decimal  # token_amount / shares, exact from the event
    yes_price_after: Decimal
    transaction_hash: str
    block_number: int
    log_index: int
    timestamp: datetime
    explorer_url: str | None = None


class TransactionOut(BaseModel):
    transaction_hash: str
    status: Literal["pending", "success", "failed", "not_found"]
    block_number: int | None
    confirmations: int
    required_confirmations: int
    indexed: bool
    indexed_events: list[str]
    explorer_url: str | None
