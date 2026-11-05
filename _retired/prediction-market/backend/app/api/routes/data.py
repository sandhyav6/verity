"""External (real-world) data. Kept apart from blockchain-derived endpoints on purpose: every item
carries `is_external_data: true`, its source, retrieval time, validation status and freshness."""

from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from sqlalchemy import func, select

from app.api.deps import DbDep, WeatherDep
from app.core.security import normalize_address, require_admin
from app.data_sources.http import SourceRejected, SourceUnavailable
from app.data_sources.manual import MANUAL_SOURCES, Submission, SubmissionError, build_record
from app.data_sources.weather import DataNotYetAvailable, OpenMeteoSource, WeatherQuery
from app.models import ExternalData, User
from app.schemas.common import Page
from app.schemas.data import ExternalDataOut, Freshness, IngestOut, SourceStatus, SubmissionIn, WeatherRefreshIn
from app.services import data_ingestion_service as ingestion

router = APIRouter(prefix="/data", tags=["external data"])

Limit = Annotated[int, Query(ge=1, le=200)]
Offset = Annotated[int, Query(ge=0)]


def _q(value: Decimal | None, places: str) -> Decimal | None:
    """Fixed decimal places so a value looks the same whether freshly inserted or read back."""
    return None if value is None else Decimal(value).quantize(Decimal(places))


def to_out(db, row: ExternalData) -> ExternalDataOut:
    return ExternalDataOut(
        id=row.id, category=row.category, provider=row.provider, dataset=row.dataset, dataset_version=row.dataset_version,
        metric=row.metric, value=_q(row.normalized_value, '0.0000000001'), text=row.normalized_text, unit=row.unit, location=row.location,
        grid_latitude=_q(row.latitude, '0.00001'), grid_longitude=_q(row.longitude, '0.00001'), period_start=row.period_start, period_end=row.period_end,
        observed_at=row.observed_at, retrieved_at=row.retrieved_at, last_seen_at=row.last_seen_at, source_url=row.source_url,
        raw_payload_reference=row.raw_payload_reference, raw_payload_hash=row.raw_payload_hash, transformation=row.transformation,
        validation_status=row.validation_status, validation_notes=list(row.validation_notes), attribution=row.attribution,
        freshness=Freshness(**ingestion.freshness(row)), supersedes_id=row.supersedes_id, is_latest=ingestion.is_latest(db, row),
        entered_manually=row.submitted_by is not None, submitted_by=row.submitted_by,
    )


def _listing(db, category: str, provider, metric, location, validation_status, latest_only, limit, offset) -> Page[ExternalDataOut]:
    stmt = select(ExternalData).where(ExternalData.category == category)
    if provider:
        stmt = stmt.where(ExternalData.provider == provider)
    if metric:
        stmt = stmt.where(ExternalData.metric == metric)
    if location:
        stmt = stmt.where(ExternalData.location == location)
    if validation_status:
        stmt = stmt.where(ExternalData.validation_status == validation_status)
    if latest_only:  # hide rows that a newer revision has superseded
        newer = select(ExternalData.supersedes_id).where(ExternalData.supersedes_id.is_not(None))
        stmt = stmt.where(ExternalData.id.not_in(newer))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(ExternalData.observed_at.desc(), ExternalData.id.desc()).limit(limit).offset(offset)).all()
    return Page(items=[to_out(db, r) for r in rows], total=total, limit=limit, offset=offset)


def _list_endpoint(category: str):
    def endpoint(
        db: DbDep,
        provider: str | None = None,
        metric: str | None = None,
        location: str | None = None,
        validation_status: Literal["valid", "incomplete", "invalid", "manual_submitted"] | None = None,
        latest_only: bool = True,
        limit: Limit = 50,
        offset: Offset = 0,
    ) -> Page[ExternalDataOut]:
        return _listing(db, category, provider, metric, location, validation_status, latest_only, limit, offset)

    return endpoint


for _path, _cat in (("economic", "economy"), ("weather", "weather"), ("sports", "sports"), ("technology", "technology")):
    router.add_api_route(f"/{_path}", _list_endpoint(_cat), methods=["GET"], response_model=Page[ExternalDataOut],
                         summary=f"External {_cat} data", name=f"data_{_path}")


@router.get("/sources", response_model=list[SourceStatus])
def sources(db: DbDep) -> list[SourceStatus]:
    """Every provider the platform knows about, how it is accessed, and its real ingestion status."""
    catalog = [(OpenMeteoSource.provider, OpenMeteoSource.category, "automated", OpenMeteoSource.terms_note)]
    catalog += [(s.provider, s.category, "manual submission", s.terms_note) for s in MANUAL_SOURCES.values()]
    out = []
    for provider, category, mode, note in catalog:
        n, last_ret, last_seen = db.execute(
            select(func.count(), func.max(ExternalData.retrieved_at), func.max(ExternalData.last_seen_at)).where(ExternalData.provider == provider)
        ).one()
        if n == 0:
            state = "no data"
        elif mode == "manual submission":
            state = "manual"
        else:
            newest = db.scalar(select(ExternalData).where(ExternalData.provider == provider).order_by(ExternalData.last_seen_at.desc()).limit(1))
            state = ingestion.freshness(newest)["state"]
        out.append(SourceStatus(provider=provider, category=category, mode=mode, terms_note=note, records=n,
                                last_retrieved_at=last_ret, last_seen_at=last_seen, freshness=state))
    return out


@router.get("/records/{record_id}", response_model=ExternalDataOut)
def record(record_id: int, db: DbDep) -> ExternalDataOut:
    row = db.get(ExternalData, record_id)
    if row is None:
        raise HTTPException(404, "record not found")
    return to_out(db, row)


@router.get("/records/{record_id}/revisions", response_model=list[ExternalDataOut])
def revisions(record_id: int, db: DbDep) -> list[ExternalDataOut]:
    """The whole revision chain of the series this record belongs to, oldest first. Originals are never altered."""
    row = db.get(ExternalData, record_id)
    if row is None:
        raise HTTPException(404, "record not found")
    chain = [row]
    while chain[0].supersedes_id is not None:
        chain.insert(0, db.get(ExternalData, chain[0].supersedes_id))
    while (nxt := db.scalar(select(ExternalData).where(ExternalData.supersedes_id == chain[-1].id))) is not None:
        chain.append(nxt)
    return [to_out(db, r) for r in chain]


@router.get("/raw/{payload_hash}", response_class=PlainTextResponse)
def raw_payload(payload_hash: str, db: DbDep) -> str:
    """The exact bytes we received from a provider; sha256(body) equals `payload_hash`."""
    row = db.scalar(select(ExternalData).where(ExternalData.raw_payload_hash == payload_hash.lower(), ExternalData.raw_payload.is_not(None)).limit(1))
    if row is None:
        raise HTTPException(404, "no stored raw payload with that hash (manual records keep the document elsewhere)")
    return row.raw_payload


@router.post("/submissions", response_model=IngestOut, status_code=201)
def submit(body: SubmissionIn, db: DbDep, admin: Annotated[User, Depends(require_admin)]) -> IngestOut:
    """Admin-only: record a value transcribed from an official document that we do not crawl."""
    try:
        rec = build_record(Submission(**body.model_dump(), submitted_by=normalize_address(admin.wallet_address)))
    except SubmissionError as exc:
        raise HTTPException(422, str(exc)) from exc
    result = ingestion.store_record(db, rec)
    return IngestOut(outcome=result.outcome, record=to_out(db, result.row))


@router.post("/weather/refresh", response_model=IngestOut)
def refresh_weather(body: WeatherRefreshIn, db: DbDep, weather: WeatherDep, _: Annotated[User, Depends(require_admin)]) -> IngestOut:
    """Admin-only: fetch now from Open-Meteo (the worker also does this on a schedule)."""
    try:
        query = WeatherQuery(body.location, body.latitude, body.longitude, body.start_date, body.end_date, body.model)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    try:
        result = ingestion.ingest_weather(db, weather, query)
    except DataNotYetAvailable as exc:
        raise HTTPException(409, str(exc)) from exc
    except SourceUnavailable as exc:
        raise HTTPException(503, f"Open-Meteo unavailable: {exc}") from exc
    except SourceRejected as exc:
        raise HTTPException(502, f"Open-Meteo rejected the request: {exc}") from exc
    return IngestOut(outcome=result.outcome, record=to_out(db, result.row))

