from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel

from app.schemas.common import WeiStr


class ActivityPoint(BaseModel):
    day: date
    trades: int
    volume: WeiStr


class OverviewOut(BaseModel):
    source: str = "indexed blockchain events (PostgreSQL read model)"
    markets_total: int
    markets_by_status: dict[str, int]
    trades_total: int
    unique_traders: int
    total_volume: WeiStr
    last_indexed_block: int | None
    indexed_at: datetime | None
    activity: list[ActivityPoint]


class CategoryStat(BaseModel):
    category: str
    markets: int
    trades: int
    volume: WeiStr


class MarketStat(BaseModel):
    id: int
    question: str
    category: str
    status: str
    yes_price: Decimal
    trades: int
    unique_traders: int
    volume: WeiStr
