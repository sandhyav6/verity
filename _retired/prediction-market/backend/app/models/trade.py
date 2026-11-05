from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import PRICE, UINT, Base, UTCDateTime


class Trade(Base):
    __tablename__ = "trades"

    id: Mapped[int] = mapped_column(primary_key=True)
    market_id: Mapped[int] = mapped_column(ForeignKey("markets.id", ondelete="CASCADE"))
    chain_id: Mapped[int] = mapped_column(Integer)
    wallet_address: Mapped[str] = mapped_column(String(42))
    outcome: Mapped[str] = mapped_column(String(3))  # YES | NO
    action: Mapped[str] = mapped_column(String(4))  # buy | sell
    shares: Mapped[Decimal] = mapped_column(UINT)
    token_amount: Mapped[Decimal] = mapped_column(UINT)  # cost (buy) or proceeds (sell), wei
    yes_price_after: Mapped[Decimal] = mapped_column(PRICE)
    transaction_hash: Mapped[str] = mapped_column(String(66))
    block_number: Mapped[int] = mapped_column(BigInteger)
    log_index: Mapped[int] = mapped_column(Integer)
    timestamp: Mapped[datetime] = mapped_column(UTCDateTime)

    __table_args__ = (
        UniqueConstraint("chain_id", "transaction_hash", "log_index", name="uq_trades_event"),
        Index("ix_trades_market_block", "market_id", "block_number", "log_index"),
        Index("ix_trades_wallet", "wallet_address"),
        Index("ix_trades_timestamp", "timestamp"),
    )
