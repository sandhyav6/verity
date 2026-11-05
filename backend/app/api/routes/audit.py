from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, select

from app.api.deps import DbDep, SettingsDep
from app.blockchain.transaction_service import explorer_url
from app.models import AuditLog
from app.schemas.common import Page
from app.schemas.registry import AuditOut

router = APIRouter(prefix="/audit", tags=["audit"])

ACTIONS = ("document.registered", "document.revoked", "issuer.authorized", "issuer.removed", "batch.registered", "batch.revoked", "batch.document_revoked")


@router.get("", response_model=Page[AuditOut])
def audit_log(
    db: DbDep, settings: SettingsDep,
    action: Annotated[str | None, Query(description="one of " + ", ".join(ACTIONS))] = None,
    actor: Annotated[str | None, Query(max_length=42)] = None,
    resource_id: Annotated[str | None, Query(max_length=80)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Page[AuditOut]:
    """Every registry event the indexer has seen, newest first. This is public chain data (no titles or files)."""
    if action is not None and action not in ACTIONS:
        raise HTTPException(422, f"unknown action; expected one of {', '.join(ACTIONS)}")
    stmt = select(AuditLog).where(AuditLog.chain_id == settings.chain_id)
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if actor:
        stmt = stmt.where(AuditLog.actor == actor.lower())
    if resource_id:
        stmt = stmt.where(AuditLog.resource_id == resource_id.lower())
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(AuditLog.block_number.desc(), AuditLog.log_index.desc()).limit(limit).offset(offset)).all()
    items = [AuditOut(action=r.action, actor=r.actor, resource_id=r.resource_id, transaction_hash=r.transaction_hash, block_number=r.block_number,
                      timestamp=r.timestamp, explorer_url=explorer_url(settings, r.transaction_hash)) for r in rows]
    return Page(items=items, total=total, limit=limit, offset=offset)
