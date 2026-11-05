from typing import Annotated

from eth_utils import is_address
from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, select

from app.api.deps import DbDep, SettingsDep
from app.models import Batch, DocumentVersion, Issuer
from app.schemas.common import Page
from app.schemas.registry import IssuerOut

router = APIRouter(prefix="/issuers", tags=["issuers"])

# Issuer authorisation is changed ON-CHAIN by an ISSUER_MANAGER wallet (VerityRegistry.authorizeIssuer /
# removeIssuer). The API deliberately has no write endpoints for it: it would be a second, forgeable source
# of truth. These routes expose the indexed view of what the chain says.


def _out(db, row: Issuer) -> IssuerOut:
    cid, a = row.chain_id, row.address
    docs = db.scalar(select(func.count()).select_from(DocumentVersion).where(DocumentVersion.chain_id == cid, DocumentVersion.issuer_address == a)) or 0
    revoked = db.scalar(select(func.count()).select_from(DocumentVersion).where(
        DocumentVersion.chain_id == cid, DocumentVersion.issuer_address == a, DocumentVersion.status == "revoked")) or 0
    batches = db.scalar(select(func.count()).select_from(Batch).where(Batch.chain_id == cid, Batch.issuer_address == a)) or 0
    return IssuerOut(address=a, organization_name=row.organization_name, authorized=row.authorized, authorized_at=row.authorized_at,
                     removed_at=row.removed_at, authorized_by=row.authorized_by, transaction_hash=row.transaction_hash,
                     document_count=docs, batch_count=batches, revoked_count=revoked)


@router.get("", response_model=Page[IssuerOut])
def list_issuers(
    db: DbDep, settings: SettingsDep,
    authorized: Annotated[bool | None, Query()] = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Page[IssuerOut]:
    stmt = select(Issuer).where(Issuer.chain_id == settings.chain_id)
    if authorized is not None:
        stmt = stmt.where(Issuer.authorized == authorized)
    if q:
        like = "%" + q.strip().lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(func.lower(Issuer.organization_name).like(like, escape="\\") | Issuer.address.like(like, escape="\\"))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(Issuer.authorized.desc(), Issuer.authorized_at.desc()).limit(limit).offset(offset)).all()
    return Page(items=[_out(db, r) for r in rows], total=total, limit=limit, offset=offset)


@router.get("/{address}", response_model=IssuerOut)
def get_issuer(address: str, db: DbDep, settings: SettingsDep) -> IssuerOut:
    if not is_address(address):
        raise HTTPException(422, "invalid address")
    row = db.get(Issuer, (settings.chain_id, address.lower()))
    if row is None:
        raise HTTPException(404, "unknown issuer")
    return _out(db, row)
