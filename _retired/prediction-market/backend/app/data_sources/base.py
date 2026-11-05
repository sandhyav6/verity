import hashlib
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal


def sha256_hex(data: str | bytes) -> str:
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


@dataclass(frozen=True)
class NormalizedRecord:
    """Provider-independent shape every adapter produces (maps 1:1 onto ExternalData)."""

    category: str
    provider: str
    metric: str
    source_url: str
    retrieved_at: datetime
    observed_at: datetime
    raw_payload_reference: str
    raw_payload_hash: str
    transformation: str
    validation_status: str  # valid | incomplete | invalid | manual_submitted
    dataset: str | None = None
    dataset_version: str | None = None
    attribution: str | None = None
    period_start: date | None = None
    period_end: date | None = None
    raw_payload: str | None = None
    normalized_value: Decimal | None = None
    normalized_text: str | None = None
    unit: str | None = None
    location: str | None = None
    latitude: Decimal | None = None
    longitude: Decimal | None = None
    validation_notes: list[str] = field(default_factory=list)
    submitted_by: str | None = None
    ingestion_ms: int | None = None


class DataSource:
    """Base for adapters. `automated` sources are fetched by the data worker; non-automated ones
    only accept human-submitted, hash-anchored records (see data_sources/manual.py)."""

    provider: str
    category: str
    automated: bool
    terms_note: str
