from datetime import date
from decimal import Decimal

from sqlalchemy import Date, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import UINT, Base


class DailyActivity(Base):
    """Per-day trade count and token volume, maintained by the indexer as it applies trade events.

    A derived rollup (rebuilt from `chain_events` with everything else) so the dashboard's daily chart
    reads at most ~90 small rows instead of aggregating every trade."""

    __tablename__ = "daily_activity"

    chain_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    trades: Mapped[int] = mapped_column(Integer, default=0)
    volume: Mapped[Decimal] = mapped_column(UINT, default=0)
