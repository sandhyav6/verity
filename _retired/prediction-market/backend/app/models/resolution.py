from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import UINT, Base, UTCDateTime, utcnow


class ResolutionEvidence(Base):
    """Off-chain evidence bundle. `evidence_hash` = keccak256(canonical_json) and is what the
    resolver submits on-chain, so anyone can recompute it from this row."""

    __tablename__ = "resolution_evidence"

    evidence_hash: Mapped[str] = mapped_column(String(66), primary_key=True)
    # Keyed by contract address, not markets.id: markets are a rebuildable read model, but
    # evidence is off-chain data that must survive a rebuild after a chain reorganisation.
    market_address: Mapped[str] = mapped_column(String(42))
    kind: Mapped[str] = mapped_column(String(16), default="proposal")  # proposal | dispute | arbitration
    proposed_outcome: Mapped[str] = mapped_column(String(8))  # the outcome this document asserts: YES | NO | INVALID
    canonical_json: Mapped[str] = mapped_column(Text)
    bundle: Mapped[dict] = mapped_column(JSONB)
    created_by: Mapped[str] = mapped_column(String(42))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    __table_args__ = (Index("ix_evidence_market", "market_address"),)


class ResolutionProposal(Base):
    """On-chain proposal state mirrored from ResolutionProposed/Cancelled/Finalized events."""

    __tablename__ = "resolution_proposals"

    id: Mapped[int] = mapped_column(primary_key=True)
    market_id: Mapped[int] = mapped_column(ForeignKey("markets.id", ondelete="CASCADE"))
    chain_id: Mapped[int] = mapped_column(Integer)
    transaction_hash: Mapped[str] = mapped_column(String(66))
    log_index: Mapped[int] = mapped_column(Integer)
    proposed_outcome: Mapped[str] = mapped_column(String(8))
    final_outcome: Mapped[str | None] = mapped_column(String(8), nullable=True)
    evidence_hash: Mapped[str] = mapped_column(String(66))
    evidence_uri: Mapped[str] = mapped_column(Text)
    resolver_address: Mapped[str] = mapped_column(String(42))
    proposal_timestamp: Mapped[datetime] = mapped_column(UTCDateTime)
    challenge_deadline: Mapped[datetime] = mapped_column(UTCDateTime)
    state: Mapped[str] = mapped_column(String(12))  # proposed | disputed | cancelled | finalized
    dispute_status: Mapped[str] = mapped_column(String(12), default="none")  # none | disputed | upheld | overturned | released
    bond: Mapped[Decimal] = mapped_column(UINT, default=0)  # proposer's escrowed test tokens (0 for resolver proposals)
    dispute_bond: Mapped[Decimal] = mapped_column(UINT, default=0)
    disputer_address: Mapped[str | None] = mapped_column(String(42), nullable=True)
    dispute_evidence_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    dispute_evidence_uri: Mapped[str | None] = mapped_column(Text, nullable=True)
    disputed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    arbiter_address: Mapped[str | None] = mapped_column(String(42), nullable=True)
    arbiter_rationale_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    arbitrated_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    resolution_timestamp: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    block_number: Mapped[int] = mapped_column(BigInteger)

    __table_args__ = (
        UniqueConstraint("chain_id", "transaction_hash", "log_index", name="uq_proposals_event"),
        Index("ix_proposals_market", "market_id", "block_number"),
        Index("ix_proposals_evidence_hash", "evidence_hash"),
    )
