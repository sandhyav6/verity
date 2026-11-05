from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import PRICE, UINT, Base, UTCDateTime, utcnow

CATEGORIES = {0: "economy", 1: "weather", 2: "sports", 3: "technology"}
CATEGORY_CODES = {v: k for k, v in CATEGORIES.items()}


class MarketMetadata(Base):
    """Off-chain market definition. `metadata_hash` = keccak256(canonical_json) and is the only
    thing stored on-chain, which is what binds this row to a market."""

    __tablename__ = "market_metadata"

    metadata_hash: Mapped[str] = mapped_column(String(66), primary_key=True)
    canonical_json: Mapped[str] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(42))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Market(Base):
    """Read model of one on-chain PredictionMarket. Rebuilt from `chain_events` by replay."""

    __tablename__ = "markets"

    id: Mapped[int] = mapped_column(primary_key=True)
    chain_id: Mapped[int] = mapped_column(Integer)
    contract_address: Mapped[str] = mapped_column(String(42))  # lowercase
    blockchain_market_id: Mapped[int] = mapped_column(BigInteger)
    metadata_hash: Mapped[str] = mapped_column(String(66))
    category: Mapped[str] = mapped_column(String(16))
    created_by: Mapped[str] = mapped_column(String(42))
    liquidity_parameter: Mapped[Decimal] = mapped_column(UINT)  # wei
    trading_close_time: Mapped[datetime] = mapped_column(UTCDateTime)
    resolution_deadline: Mapped[datetime] = mapped_column(UTCDateTime)
    created_block: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime)

    # state mirrored from chain events
    status: Mapped[str] = mapped_column(String(16), default="active")  # active|resolved|invalid
    winning_outcome: Mapped[str | None] = mapped_column(String(3), nullable=True)
    q_yes: Mapped[Decimal] = mapped_column(UINT, default=0)
    q_no: Mapped[Decimal] = mapped_column(UINT, default=0)
    collateral: Mapped[Decimal] = mapped_column(UINT, default=0)
    yes_price: Mapped[Decimal] = mapped_column(PRICE, default=Decimal("0.5"))
    volume: Mapped[Decimal] = mapped_column(UINT, default=0)  # Σ token amounts of buys and sells
    trade_count: Mapped[int] = mapped_column(Integer, default=0)
    resolved_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)

    __table_args__ = (
        UniqueConstraint("chain_id", "contract_address", name="uq_markets_chain_address"),
        UniqueConstraint("chain_id", "blockchain_market_id", name="uq_markets_chain_marketid"),
        Index("ix_markets_category", "category"),
        Index("ix_markets_status", "status"),
        Index("ix_markets_trading_close", "trading_close_time"),
        Index("ix_markets_metadata_hash", "metadata_hash"),
    )


class PriceSnapshot(Base):
    """Actual (qYes, qNo, price) after each trade. The ONLY source of probability charts."""

    __tablename__ = "price_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    market_id: Mapped[int] = mapped_column(ForeignKey("markets.id", ondelete="CASCADE"))
    chain_id: Mapped[int] = mapped_column(Integer)
    transaction_hash: Mapped[str] = mapped_column(String(66))
    log_index: Mapped[int] = mapped_column(Integer)
    block_number: Mapped[int] = mapped_column(BigInteger)
    block_time: Mapped[datetime] = mapped_column(UTCDateTime)
    q_yes: Mapped[Decimal] = mapped_column(UINT)
    q_no: Mapped[Decimal] = mapped_column(UINT)
    yes_price: Mapped[Decimal] = mapped_column(PRICE)

    __table_args__ = (
        UniqueConstraint("chain_id", "transaction_hash", "log_index", name="uq_snapshots_event"),
        Index("ix_snapshots_market_block", "market_id", "block_number", "log_index"),
    )
