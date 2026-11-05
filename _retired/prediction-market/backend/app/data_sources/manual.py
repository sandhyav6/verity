"""Human-submitted, hash-anchored records for sources we deliberately do NOT crawl.

RBI, MoSPI/data.gov.in, ISRO, BCCI and ESPNcricinfo publish documents or pages, not stable APIs, and
their terms either restrict copying/caching (RBI: "All Rights Reserved", caching/framing prohibited)
or say nothing about automated access; some block automated clients entirely. So the backend never
fetches them. Instead an authorised person reads the official document, archives it and submits:
the official URL, the SHA-256 of the archived document, when they retrieved it, the period it
covers, its publication date and the extracted value. We validate structure and plausibility and
store it with status `manual_submitted`. The backend has NOT verified the document: that status is
shown to users as such.
"""

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from urllib.parse import urlparse

from app.data_sources.base import DataSource, NormalizedRecord


class SubmissionError(ValueError):
    """The submission is structurally or semantically invalid (message is safe to show)."""


@dataclass(frozen=True)
class MetricSpec:
    unit: str | None
    low: Decimal | None = None  # inclusive plausibility range for numeric metrics
    high: Decimal | None = None
    textual: bool = False  # value is a short statement (e.g. a match result), not a number
    needs_publication_date: bool = True


@dataclass(frozen=True)
class ManualSource(DataSource):
    provider: str
    category: str
    hosts: tuple[str, ...]
    metrics: dict[str, MetricSpec]
    terms_note: str
    automated: bool = False


def _d(x: str) -> Decimal:
    return Decimal(x)


RBI = ManualSource(
    "rbi", "economy", ("rbi.org.in", "data.rbi.org.in"),
    {
        "policy_repo_rate": MetricSpec("%", _d("0"), _d("20")),
        "cpi_projection_fy": MetricSpec("%", _d("-5"), _d("30")),
        "gdp_growth_projection_fy": MetricSpec("%", _d("-30"), _d("30")),
    },
    "Site reserves all rights and prohibits caching/framing; no automated-access permission found. Manual submission only.",
)
MOSPI = ManualSource(
    "mospi", "economy", ("mospi.gov.in", "mospi.nic.in", "data.gov.in", "esankhyiki.mospi.gov.in"),
    {
        "cpi_inflation_yoy": MetricSpec("%", _d("-10"), _d("30")),
        "gdp_growth_yoy": MetricSpec("%", _d("-30"), _d("30")),
        "iip_growth_yoy": MetricSpec("%", _d("-50"), _d("50")),
    },
    "mospi.gov.in failed certificate validation and data.gov.in returned HTTP 403 to automated fetching when checked. Manual submission only.",
)
ISRO = ManualSource(
    "isro", "technology", ("isro.gov.in",),
    {"mission_milestone": MetricSpec(None, textual=True, needs_publication_date=True)},
    "No machine-readable feed; no stated automated-access terms. Manual submission of announcements only.",
)
BCCI = ManualSource(
    "bcci", "sports", ("bcci.tv",),
    {"match_result": MetricSpec(None, textual=True, needs_publication_date=False), "player_runs": MetricSpec("runs", _d("0"), _d("500"), needs_publication_date=False),
     "player_wickets": MetricSpec("wickets", _d("0"), _d("10"), needs_publication_date=False)},
    "Terms not verified. Manual submission only; no scraping.",
)
ESPNCRICINFO = ManualSource(
    "espncricinfo", "sports", ("espncricinfo.com",),
    BCCI.metrics, "Terms not verified; commercial site. Manual submission only; no scraping.",
)
MANUAL_SOURCES = {s.provider: s for s in (RBI, MOSPI, ISRO, BCCI, ESPNCRICINFO)}
SHA256 = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class Submission:
    provider: str
    metric: str
    source_url: str
    document_sha256: str
    retrieved_at: datetime
    observed_at: datetime
    publication_date: date | None
    period_start: date | None = None
    period_end: date | None = None
    value: Decimal | None = None
    text: str | None = None
    location: str | None = None
    submitted_by: str | None = None
    notes: str | None = None


def build_record(sub: Submission, *, now: datetime | None = None) -> NormalizedRecord:
    now = now or datetime.now(timezone.utc)
    src = MANUAL_SOURCES.get(sub.provider)
    if src is None:
        raise SubmissionError(f"unknown manual provider {sub.provider!r}")
    spec = src.metrics.get(sub.metric)
    if spec is None:
        raise SubmissionError(f"metric {sub.metric!r} is not supported for {sub.provider}: {sorted(src.metrics)}")

    url = urlparse(sub.source_url)
    host = (url.hostname or "").lower()
    if url.scheme != "https" or not any(host == h or host.endswith("." + h) for h in src.hosts):
        raise SubmissionError(f"source_url must be an https URL on {', '.join(src.hosts)}")
    if not SHA256.match(sub.document_sha256.lower()):
        raise SubmissionError("document_sha256 must be the 64-hex-character SHA-256 of the archived document")
    for name, ts in (("retrieved_at", sub.retrieved_at), ("observed_at", sub.observed_at)):
        if ts.tzinfo is None:
            raise SubmissionError(f"{name} must include a timezone")
    if sub.retrieved_at > now + timedelta(minutes=2):
        raise SubmissionError("retrieved_at is in the future")
    if sub.period_start and sub.period_end and sub.period_end < sub.period_start:
        raise SubmissionError("period_end is before period_start")

    if spec.needs_publication_date:
        if sub.publication_date is None:
            raise SubmissionError("publication_date is required: a period ending does not mean the figure is published")
        if sub.publication_date > now.date():
            raise SubmissionError("publication_date is in the future")
        if sub.period_end and sub.publication_date < sub.period_end:
            raise SubmissionError("publication_date cannot be before the end of the period it reports")

    if spec.textual:
        if not sub.text or not (3 <= len(sub.text.strip()) <= 300):
            raise SubmissionError("text (3-300 characters) is required for this metric")
        value, text = None, sub.text.strip()
    else:
        if sub.value is None:
            raise SubmissionError("value is required for this metric")
        if (spec.low is not None and sub.value < spec.low) or (spec.high is not None and sub.value > spec.high):
            raise SubmissionError(f"value {sub.value} outside plausible range [{spec.low}, {spec.high}] {spec.unit}")
        value, text = sub.value, None

    digest = sub.document_sha256.lower()
    notes = ["entered by an authorised person; the document was NOT fetched or verified by this backend"]
    if sub.notes:
        notes.append(sub.notes[:500])
    return NormalizedRecord(
        category=src.category, provider=src.provider, metric=sub.metric, source_url=sub.source_url,
        retrieved_at=sub.retrieved_at, observed_at=sub.observed_at,
        raw_payload_reference=f"{sub.source_url}#sha256={digest}", raw_payload_hash=digest,
        transformation="Value transcribed by a person from the official document identified by the URL and SHA-256.",
        validation_status="manual_submitted", dataset_version=f"published {sub.publication_date}" if sub.publication_date else None,
        period_start=sub.period_start, period_end=sub.period_end, normalized_value=value, normalized_text=text,
        unit=spec.unit, location=sub.location, validation_notes=notes, submitted_by=sub.submitted_by,
    )
