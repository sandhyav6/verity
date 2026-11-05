from datetime import datetime
from decimal import Decimal

from sqlalchemy import ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import SINT, UINT, Base, UTCDateTime


class Position(Base):
    """A wallet's position in one market, derived from indexed events (never authoritative:
    the contract's `yesShares/noShares` are; `reconcile` compares the two).

    Cost accounting uses the moving-average-cost method per outcome:
      yes_cost / no_cost  = token cost of shares still held
      realized_pnl        = proceeds/payouts minus the average cost of what was sold or redeemed
      cost_basis          = net tokens paid in (buys - sells), the quantity the contract uses for refunds
    """

    __tablename__ = "positions"

    market_id: Mapped[int] = mapped_column(ForeignKey("markets.id", ondelete="CASCADE"), primary_key=True)
    wallet_address: Mapped[str] = mapped_column(String(42), primary_key=True)
    yes_shares: Mapped[Decimal] = mapped_column(UINT, default=0)
    no_shares: Mapped[Decimal] = mapped_column(UINT, default=0)
    yes_cost: Mapped[Decimal] = mapped_column(UINT, default=0)
    no_cost: Mapped[Decimal] = mapped_column(UINT, default=0)
    realized_pnl: Mapped[Decimal] = mapped_column(SINT, default=0)
    cost_basis: Mapped[Decimal] = mapped_column(SINT, default=0)
    settled_amount: Mapped[Decimal] = mapped_column(UINT, default=0)  # redeemed + refunded tokens
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime)

    __table_args__ = (Index("ix_positions_wallet", "wallet_address"),)
