from datetime import timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import and_, case, func, or_, select

from app.api.deps import DbDep, OptionalUser, SettingsDep
from app.database.base import utcnow
from app.models import AuditLog, Batch, DocumentVersion, Issuer
from app.schemas.registry import DayCount, StatsOut

router = APIRouter(tags=["stats"])


@router.get("/stats", response_model=StatsOut)
def stats(db: DbDep, settings: SettingsDep, user: OptionalUser, scope: Annotated[Literal["mine", "global"], Query()] = "global",
          days: Annotated[int, Query(ge=1, le=90)] = 30) -> StatsOut:
    """Counts computed from the indexed events. `global` is public (no per-document data); `mine` needs a session."""
    cid, now = settings.chain_id, utcnow()
    if scope == "mine" and user is None:
        raise HTTPException(401, "authentication required for scope=mine")
    owner = user.wallet_address if scope == "mine" and user else None

    expired = and_(DocumentVersion.status == "valid", DocumentVersion.expires_at.is_not(None), DocumentVersion.expires_at <= now)
    row = db.execute(
        select(
            func.count(),
            func.count().filter(DocumentVersion.status == "revoked"),
            func.count().filter(expired),
        ).where(DocumentVersion.chain_id == cid, *( [DocumentVersion.issuer_address == owner] if owner else [] ))
    ).one()
    total, revoked, n_expired = row
    batches = db.scalar(select(func.count()).select_from(Batch).where(Batch.chain_id == cid, *([Batch.issuer_address == owner] if owner else []))) or 0
    issuers = db.scalar(select(func.count()).select_from(Issuer).where(Issuer.chain_id == cid, Issuer.authorized.is_(True))) or 0

    start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    day = func.date_trunc("day", AuditLog.timestamp)
    q = select(day, func.count().filter(AuditLog.action == "document.registered"), func.count().filter(AuditLog.action == "document.revoked")).where(
        AuditLog.chain_id == cid, AuditLog.timestamp >= start, AuditLog.action.in_(("document.registered", "document.revoked")))
    if owner:
        q = q.where(AuditLog.actor == owner)
    by_day = {d.date().isoformat(): (r, v) for d, r, v in db.execute(q.group_by(day))}
    daily = []
    for i in range(days):
        d = (start + timedelta(days=i)).date().isoformat()
        r, v = by_day.get(d, (0, 0))
        daily.append(DayCount(day=d, registrations=r, revocations=v))
    return StatsOut(scope=scope, total_documents=total, valid_documents=total - revoked - n_expired, revoked_documents=revoked,
                    expired_documents=n_expired, total_batches=batches, authorized_issuers=issuers, daily=daily)
