from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.common import Page  # noqa: F401  (re-exported for routes)


class Freshness(BaseModel):
    state: Literal["fresh", "stale", "manual"]
    age_seconds: int
    note: str


class ExternalDataOut(BaseModel):
    """External (real-world) data. Never blockchain-derived: `is_external_data` is always true."""

    is_external_data: bool = True
    id: int
    category: str
    provider: str
    dataset: str | None
    dataset_version: str | None
    metric: str
    value: Decimal | None
    text: str | None
    unit: str | None
    location: str | None
    grid_latitude: Decimal | None
    grid_longitude: Decimal | None
    period_start: date | None
    period_end: date | None
    observed_at: datetime
    retrieved_at: datetime
    last_seen_at: datetime
    source_url: str
    raw_payload_reference: str
    raw_payload_hash: str
    transformation: str
    validation_status: str
    validation_notes: list[str]
    attribution: str | None
    freshness: Freshness
    supersedes_id: int | None
    is_latest: bool
    entered_manually: bool
    submitted_by: str | None


class SubmissionIn(BaseModel):
    provider: Literal["rbi", "mospi", "isro", "bcci", "espncricinfo"]
    metric: str = Field(min_length=3, max_length=80)
    source_url: str = Field(max_length=500)
    document_sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$")
    retrieved_at: datetime
    observed_at: datetime
    publication_date: date | None = None
    period_start: date | None = None
    period_end: date | None = None
    value: Decimal | None = None
    text: str | None = Field(default=None, max_length=300)
    location: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=500)


class WeatherRefreshIn(BaseModel):
    location: str = Field(min_length=2, max_length=80)
    latitude: Decimal = Field(ge=-90, le=90)
    longitude: Decimal = Field(ge=-180, le=180)
    start_date: date
    end_date: date
    model: Literal["era5", "era5_land"] = "era5"


class IngestOut(BaseModel):
    outcome: Literal["created", "duplicate", "revision"]
    record: ExternalDataOut


class SourceStatus(BaseModel):
    provider: str
    category: str
    mode: Literal["automated", "manual submission"]
    terms_note: str
    records: int
    last_retrieved_at: datetime | None
    last_seen_at: datetime | None
    freshness: Literal["fresh", "stale", "manual", "no data"]


class DraftOut(BaseModel):
    """A proposal for a HUMAN resolver to review. Nothing is stored or submitted by creating it."""

    requires_human_review: bool = True
    external_data_id: int
    suggested_outcome: Literal["YES", "NO", "INVALID"]
    rule: dict
    evidence: dict
    warnings: list[str]
    next_step: str
