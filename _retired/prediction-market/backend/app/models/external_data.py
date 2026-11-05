from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base, UTCDateTime, utcnow

CATEGORIES = ("economy", "weather", "sports", "technology")
VALIDATION_STATUSES = ("valid", "incomplete", "invalid", "manual_submitted")


class ExternalData(Base):
    """One retrieved (or human-submitted) real-world data record, with full provenance.

    Append-only: a revised value never overwrites an earlier one. A changed payload for the same
    series is stored as a NEW row whose `supersedes_id` points at the previous one.
    External data is never mixed with blockchain-derived tables.
    """

    __tablename__ = "external_data"

    id: Mapped[int] = mapped_column(primary_key=True)
    category: Mapped[str] = mapped_column(String(16))
    provider: Mapped[str] = mapped_column(String(64))  # e.g. open-meteo, rbi, mospi, isro
    dataset: Mapped[str | None] = mapped_column(String(120), nullable=True)  # e.g. era5
    dataset_version: Mapped[str | None] = mapped_column(String(120), nullable=True)
    metric: Mapped[str] = mapped_column(String(80))  # e.g. precipitation_sum_total, policy_repo_rate
    source_url: Mapped[str] = mapped_column(Text)
    attribution: Mapped[str | None] = mapped_column(Text, nullable=True)

    retrieved_at: Mapped[datetime] = mapped_column(UTCDateTime)
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    observed_at: Mapped[datetime] = mapped_column(UTCDateTime)  # instant the value refers to (end of period)
    period_start: Mapped[date | None] = mapped_column(Date, nullable=True)
    period_end: Mapped[date | None] = mapped_column(Date, nullable=True)

    raw_payload_reference: Mapped[str] = mapped_column(Text)
    raw_payload_hash: Mapped[str] = mapped_column(String(64))  # sha256 hex of the raw bytes
    raw_payload: Mapped[str | None] = mapped_column(Text, nullable=True)  # stored when we fetched it ourselves

    normalized_value: Mapped[Decimal | None] = mapped_column(Numeric(30, 10), nullable=True)
    normalized_text: Mapped[str | None] = mapped_column(String(300), nullable=True)
    unit: Mapped[str | None] = mapped_column(String(40), nullable=True)
    location: Mapped[str | None] = mapped_column(String(120), nullable=True)
    latitude: Mapped[Decimal | None] = mapped_column(Numeric(9, 5), nullable=True)  # grid point actually used
    longitude: Mapped[Decimal | None] = mapped_column(Numeric(9, 5), nullable=True)
    transformation: Mapped[str] = mapped_column(Text)  # how raw -> normalized

    validation_status: Mapped[str] = mapped_column(String(20))
    validation_notes: Mapped[list] = mapped_column(JSONB, default=list)
    supersedes_id: Mapped[int | None] = mapped_column(ForeignKey("external_data.id"), nullable=True)
    submitted_by: Mapped[str | None] = mapped_column(String(42), nullable=True)  # wallet, manual records only
    ingestion_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    __table_args__ = (
        # duplicate detection: the same series with the same payload is stored once
        UniqueConstraint(
            "provider", "metric", "location", "period_start", "period_end", "raw_payload_hash", "supersedes_id",
            name="uq_external_data_series_payload", postgresql_nulls_not_distinct=True,
        ),
        Index("ix_external_category_observed", "category", "observed_at"),
        Index("ix_external_series", "provider", "metric", "location", "period_start", "period_end"),
    )
