from datetime import datetime

from sqlalchemy import BigInteger, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base, UTCDateTime, utcnow


class ChainEvent(Base):
    """Every decoded contract event, exactly once. This table is the replayable source for all
    derived read models. Idempotency: primary key (chain_id, transaction_hash, log_index)."""

    __tablename__ = "chain_events"

    chain_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    transaction_hash: Mapped[str] = mapped_column(String(66), primary_key=True)
    log_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    block_number: Mapped[int] = mapped_column(BigInteger)
    block_hash: Mapped[str] = mapped_column(String(66))
    block_time: Mapped[datetime] = mapped_column(UTCDateTime)
    contract_address: Mapped[str] = mapped_column(String(42))
    event_name: Mapped[str] = mapped_column(String(64))
    args: Mapped[dict] = mapped_column(JSONB)
    indexed_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    __table_args__ = (
        Index("ix_chain_events_block", "chain_id", "block_number", "log_index"),
        Index("ix_chain_events_contract", "contract_address"),
        Index("ix_chain_events_name", "event_name"),
    )


class IndexedBlock(Base):
    """Block hashes we have seen, used to find the common ancestor after a reorg."""

    __tablename__ = "indexed_blocks"

    chain_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    number: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    hash: Mapped[str] = mapped_column(String(66))


class IndexerCheckpoint(Base):
    __tablename__ = "indexer_checkpoints"

    chain_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    last_block: Mapped[int] = mapped_column(BigInteger)
    last_block_hash: Mapped[str] = mapped_column(String(66))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
