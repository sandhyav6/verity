"""Stores normalized external records append-only, with duplicate and revision handling."""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import and_, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.data_sources.base import NormalizedRecord
from app.data_sources.weather import OpenMeteoSource, WeatherQuery
from app.database.base import utcnow
from app.models import ExternalData

log = logging.getLogger(__name__)

# how long an automatically fetched record counts as fresh
FRESH_FOR = {"open-meteo": timedelta(hours=24)}


@dataclass
class StoreResult:
    row: ExternalData
    outcome: str  # created | duplicate | revision


def _series_filter(rec: NormalizedRecord):
    return and_(
        ExternalData.provider == rec.provider,
        ExternalData.metric == rec.metric,
        ExternalData.location.is_(None) if rec.location is None else ExternalData.location == rec.location,
        ExternalData.period_start.is_(None) if rec.period_start is None else ExternalData.period_start == rec.period_start,
        ExternalData.period_end.is_(None) if rec.period_end is None else ExternalData.period_end == rec.period_end,
    )


def latest_in_series(db: Session, rec: NormalizedRecord) -> ExternalData | None:
    return db.scalar(select(ExternalData).where(_series_filter(rec)).order_by(ExternalData.id.desc()).limit(1))


def store_record(db: Session, rec: NormalizedRecord) -> StoreResult:
    """Append `rec` to its series.

    * same payload as the current latest row  -> duplicate: only `last_seen_at` is touched
    * different payload                       -> revision: a NEW row superseding the previous one;
                                                 the original row is never modified
    * first record of the series              -> created
    """
    now = utcnow()
    latest = latest_in_series(db, rec)
    if latest is not None and latest.raw_payload_hash == rec.raw_payload_hash:
        latest.last_seen_at = now
        db.commit()
        return StoreResult(latest, "duplicate")

    row = ExternalData(
        category=rec.category, provider=rec.provider, dataset=rec.dataset, dataset_version=rec.dataset_version,
        metric=rec.metric, source_url=rec.source_url, attribution=rec.attribution, retrieved_at=rec.retrieved_at,
        last_seen_at=now, observed_at=rec.observed_at, period_start=rec.period_start, period_end=rec.period_end,
        raw_payload_reference=rec.raw_payload_reference, raw_payload_hash=rec.raw_payload_hash,
        raw_payload=rec.raw_payload, normalized_value=rec.normalized_value, normalized_text=rec.normalized_text,
        unit=rec.unit, location=rec.location, latitude=rec.latitude, longitude=rec.longitude,
        transformation=rec.transformation, validation_status=rec.validation_status,
        validation_notes=list(rec.validation_notes), supersedes_id=latest.id if latest else None,
        submitted_by=rec.submitted_by, ingestion_ms=rec.ingestion_ms, created_at=now,
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:  # a concurrent worker stored the same payload first: that is a duplicate
        db.rollback()
        existing = latest_in_series(db, rec)
        assert existing is not None
        return StoreResult(existing, "duplicate")
    return StoreResult(row, "revision" if latest else "created")


def ingest_weather(db: Session, source: OpenMeteoSource, query: WeatherQuery) -> StoreResult:
    """Fetch from Open-Meteo and store. Raises SourceUnavailable/SourceRejected; NEVER falls back to
    another provider or to older data."""
    return store_record(db, source.ingest(query))


def freshness(row: ExternalData, now: datetime | None = None) -> dict:
    now = now or utcnow()
    age = now - row.last_seen_at
    limit = FRESH_FOR.get(row.provider)
    if limit is None:  # manual sources have no refresh cycle: the publication date is what matters
        return {"state": "manual", "age_seconds": int(age.total_seconds()), "note": "human-submitted; check the publication date"}
    return {
        "state": "fresh" if age <= limit else "stale",
        "age_seconds": int(age.total_seconds()),
        "note": f"automatically refreshed; considered fresh for {int(limit.total_seconds() // 3600)}h",
    }


def is_latest(db: Session, row: ExternalData) -> bool:
    return db.scalar(select(func.count()).select_from(ExternalData).where(ExternalData.supersedes_id == row.id)) == 0
