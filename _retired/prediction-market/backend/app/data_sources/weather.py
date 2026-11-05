"""Open-Meteo historical weather adapter (the only automated source).

IMPORTANT: Open-Meteo's archive endpoint serves *reanalysis* (ERA5 / ERA5-Land) on a coarse grid,
NOT ground-station observations. Records say so, and markets that promise IMD station data may not
resolve from them. Free use is non-commercial (CC BY 4.0, attribution required; see data-sources.md).
Observed behaviour (checked live): the requested point is snapped to the model grid (the response
carries the grid latitude/longitude) and the most recent ~5-6 days are `null` (reanalysis delay).
"""

import json
import re
import time
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

from app.data_sources.base import DataSource, NormalizedRecord, sha256_hex
from app.data_sources.http import HttpFetcher, RawFetch, SourceRejected

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
ATTRIBUTION = "Weather data by Open-Meteo.com (CC BY 4.0, https://open-meteo.com/en/license); contains ERA5 reanalysis data."
MAX_DAILY_MM = Decimal(2000)  # above any recorded 24h rainfall; larger values are treated as corrupt
MAX_SPAN_DAYS = 366
MODELS = {"era5", "era5_land"}
# Open-Meteo rejects (HTTP 400) an end_date after its own latest date with this message (observed 2026-11-05).
# If the wording changes the rejection is passed through unchanged, which is the old (safe) behaviour.
_END_OUT_OF_RANGE = re.compile(r"'end_date' is out of allowed range from \d{4}-\d{2}-\d{2} to (\d{4}-\d{2}-\d{2})")


class DataNotYetAvailable(RuntimeError):
    """The whole requested period starts after the provider's latest available date: nothing to fetch yet."""

    def __init__(self, latest: date):
        super().__init__(f"the provider has no data after {latest}; the requested period has not started in its archive yet")
        self.latest = latest


def latest_available_from(rejection: SourceRejected) -> date | None:
    m = _END_OUT_OF_RANGE.search(str(rejection))
    return date.fromisoformat(m.group(1)) if m else None


@dataclass(frozen=True)
class WeatherQuery:
    location: str  # human label, e.g. "Chennai"
    latitude: Decimal
    longitude: Decimal
    start_date: date
    end_date: date
    model: str = "era5"
    variable: str = "precipitation_sum"

    def __post_init__(self):
        if self.model not in MODELS:
            raise ValueError(f"model must be one of {sorted(MODELS)}")
        if self.variable != "precipitation_sum":
            raise ValueError("only precipitation_sum is supported")
        if self.end_date < self.start_date or (self.end_date - self.start_date).days >= MAX_SPAN_DAYS:
            raise ValueError("invalid date range")
        if not (-90 <= self.latitude <= 90 and -180 <= self.longitude <= 180):
            raise ValueError("coordinates out of range")


class OpenMeteoSource(DataSource):
    provider = "open-meteo"
    category = "weather"
    automated = True
    terms_note = (
        "Free API: non-commercial use only; <600 calls/min, <5,000/h, <10,000/day; CC BY 4.0 attribution. "
        "Reanalysis data, not station observations."
    )

    def __init__(self, fetcher: HttpFetcher | None = None):
        self.fetcher = fetcher or HttpFetcher(self.provider, min_interval=0.25)

    def fetch(self, q: WeatherQuery) -> RawFetch:
        return self.fetcher.get(
            ARCHIVE_URL,
            {
                "latitude": str(q.latitude),
                "longitude": str(q.longitude),
                "start_date": q.start_date.isoformat(),
                "end_date": q.end_date.isoformat(),
                "daily": q.variable,
                "timezone": "auto",  # local calendar days at the grid point; offset is recorded
                "models": q.model,
            },
        )

    def ingest(self, q: WeatherQuery) -> NormalizedRecord:
        """Fetch and normalize. A period that runs past the provider's latest date (a market still in its
        observation window) is fetched up to that date and returned as `incomplete`, never as a total."""
        started = time.monotonic()
        try:
            record = self.normalize(q, self.fetch(q))
        except SourceRejected as exc:
            latest = latest_available_from(exc)
            if latest is None or latest >= q.end_date:
                raise
            if latest < q.start_date:
                raise DataNotYetAvailable(latest) from exc
            record = self._beyond_latest(q, latest)
        return replace(record, ingestion_ms=int((time.monotonic() - started) * 1000))

    def _beyond_latest(self, q: WeatherQuery, latest: date) -> NormalizedRecord:
        part = self.normalize(replace(q, end_date=latest), self.fetch(replace(q, end_date=latest)))
        if part.validation_status == "invalid":
            return replace(part, period_end=q.end_date)
        days_missing = (q.end_date - latest).days
        have = part.normalized_value
        notes = [f"provider has no data after {latest}: {days_missing} of {(q.end_date - q.start_date).days + 1} requested days not available yet"]
        notes += [n for n in part.validation_notes if not n.endswith("all present")]
        if have is not None:
            notes.append(f"partial sum of available days (NOT a final total): {have} mm")
        return replace(
            part, period_end=q.end_date, normalized_value=None, validation_status="incomplete", validation_notes=notes,
            transformation=part.transformation + f" Fetched only up to {latest}, the provider's latest date; the rest of the period is missing.",
        )

    def normalize(self, q: WeatherQuery, raw: RawFetch) -> NormalizedRecord:
        digest = sha256_hex(raw.body)
        base = dict(
            category=self.category, provider=self.provider, metric="precipitation_sum_total",
            source_url=raw.url, retrieved_at=raw.retrieved_at, raw_payload_reference=f"/data/raw/{digest}",
            raw_payload_hash=digest, raw_payload=raw.body, attribution=ATTRIBUTION, dataset=q.model,
            dataset_version="Open-Meteo archive API v1 (reanalysis; no per-record version exposed)",
            period_start=q.start_date, period_end=q.end_date, location=q.location, unit="mm",
            transformation=(
                f"Sum of daily '{q.variable}' (mm, local calendar day) from {q.start_date} to {q.end_date} "
                f"inclusive; model={q.model}. A single missing (null) day makes the record 'incomplete' and "
                "the total is withheld. Values are reanalysis, not station observations."
            ),
        )
        fallback_observed = datetime.combine(q.end_date, datetime.max.time(), tzinfo=timezone.utc).replace(microsecond=0)

        def bad(msg: str) -> NormalizedRecord:
            return NormalizedRecord(**base, observed_at=fallback_observed, validation_status="invalid", validation_notes=[msg])

        try:
            doc = json.loads(raw.body)
            times, values = doc["daily"]["time"], doc["daily"][q.variable]
            units = doc["daily_units"][q.variable]
            lat, lon = Decimal(str(doc["latitude"])), Decimal(str(doc["longitude"]))
            offset = timedelta(seconds=int(doc["utc_offset_seconds"]))
        except (ValueError, KeyError, TypeError, InvalidOperation) as exc:
            return bad(f"unparseable provider response: {type(exc).__name__}: {exc}")

        expected = [(q.start_date + timedelta(days=i)).isoformat() for i in range((q.end_date - q.start_date).days + 1)]
        if times != expected or len(values) != len(expected):
            return bad("provider returned a different set of days than requested")
        if units != "mm":
            return bad(f"unexpected unit {units!r} (expected mm)")

        parsed: list[Decimal | None] = []
        for t, v in zip(times, values):
            if v is None:
                parsed.append(None)
                continue
            try:
                d = Decimal(str(v))
            except InvalidOperation:
                return bad(f"non-numeric value on {t}: {v!r}")
            if d < 0 or d > MAX_DAILY_MM:
                return bad(f"implausible daily precipitation on {t}: {d} mm")
            parsed.append(d)

        end_local = datetime.combine(q.end_date, datetime.max.time()).replace(microsecond=0)
        observed = (end_local - offset).replace(tzinfo=timezone.utc)
        base_geo = dict(**base, observed_at=observed, latitude=lat, longitude=lon)
        grid_note = f"requested ({q.latitude}, {q.longitude}); model grid point used ({lat}, {lon})"

        missing = [t for t, v in zip(times, parsed) if v is None]
        if missing:
            have = sum((v for v in parsed if v is not None), Decimal(0))
            notes = [
                f"{len(missing)} of {len(times)} days have no data yet (reanalysis delay): {missing[0]}..{missing[-1]}"
                if len(missing) > 3 else f"missing days: {', '.join(missing)}",
                f"partial sum of available days (NOT a final total): {have} mm",
                grid_note,
            ]
            return NormalizedRecord(**base_geo, validation_status="incomplete", validation_notes=notes)

        total = sum(parsed, Decimal(0))  # type: ignore[arg-type]
        return NormalizedRecord(
            **base_geo, normalized_value=total, validation_status="valid",
            validation_notes=[f"{len(times)} days, all present", grid_note],
        )

