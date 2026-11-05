"""Read-model queries and presentation rules for documents.

Privacy rule (one place): the title, free-form metadata and the stored file of a registration are visible
to everyone only if the issuer chose `public` visibility; otherwise only to the issuer. On-chain facts
(issuer, type, dates, status, version) are public by nature and always shown.
"""

from datetime import datetime

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.blockchain.transaction_service import explorer_url
from app.core.config import Settings
from app.database.base import utcnow
from app.models import Document, DocumentUpload, DocumentVersion, Issuer
from app.schemas.registry import DocumentVersionOut, IssuerRef
from app.verity.hashing import metadata_hash


def computed_status(v: DocumentVersion, now: datetime | None = None) -> str:
    """valid | revoked | expired. Revocation wins over expiry, matching the contract."""
    if v.status == "revoked":
        return "revoked"
    if v.expires_at is not None and v.expires_at <= (now or utcnow()):
        return "expired"
    return "valid"


def issuer_names(db: Session, chain_id: int, addresses: set[str]) -> dict[str, str]:
    if not addresses:
        return {}
    rows = db.execute(select(Issuer.address, Issuer.organization_name).where(Issuer.chain_id == chain_id, Issuer.address.in_(addresses)))
    return {a: n for a, n in rows}


def _upload_for(db: Session, v: DocumentVersion) -> DocumentUpload | None:
    # An upload only counts if it was made by the address that registered the fingerprint on-chain.
    return db.get(DocumentUpload, (v.document_hash, v.issuer_address))


def version_out(db: Session, settings: Settings, v: DocumentVersion, latest_version: int, viewer: str | None,
                names: dict[str, str] | None = None) -> DocumentVersionOut:
    upload = _upload_for(db, v)
    can_see = upload is not None and (upload.visibility == "public" or viewer == v.issuer_address)
    names = names if names is not None else issuer_names(db, v.chain_id, {v.issuer_address})
    out = DocumentVersionOut(
        document_hash=v.document_hash, document_id=v.document_id, version_number=v.version_number,
        is_latest=v.version_number >= latest_version,
        issuer=IssuerRef(address=v.issuer_address, organization_name=names.get(v.issuer_address)),
        document_type=v.document_type, status=computed_status(v), registered_at=v.registered_at, expires_at=v.expires_at,
        revoked_at=v.revoked_at, revoked_by=v.revoked_by, transaction_hash=v.transaction_hash,
        revocation_transaction_hash=v.revocation_transaction_hash,
        explorer_url=explorer_url(settings, v.transaction_hash), block_number=v.block_number, metadata_hash=v.metadata_hash,
    )
    if can_see and upload is not None:
        out.title, out.metadata, out.visibility = upload.title, upload.metadata_json, upload.visibility  # type: ignore[assignment]
        out.metadata_verified = metadata_hash(
            {"title": upload.title, "document_type": upload.document_type, "attributes": upload.metadata_json}
        ) == v.metadata_hash
        out.content_type, out.size_bytes, out.file_available = upload.content_type, upload.size_bytes, True
    return out


def versions_of(db: Session, settings: Settings, chain_id: int, document_id: str, viewer: str | None) -> list[DocumentVersionOut]:
    rows = db.scalars(
        select(DocumentVersion).where(DocumentVersion.chain_id == chain_id, DocumentVersion.document_id == document_id)
        .order_by(DocumentVersion.version_number.desc())
    ).all()
    if not rows:
        return []
    doc = db.get(Document, (chain_id, document_id))
    latest = doc.latest_version if doc else max(r.version_number for r in rows)
    names = issuer_names(db, chain_id, {r.issuer_address for r in rows})
    return [version_out(db, settings, r, latest, viewer, names) for r in rows]


def list_issuer_documents(db: Session, settings: Settings, issuer: str, *, q: str | None, status: str | None,
                          document_type: str | None, limit: int, offset: int) -> tuple[list[DocumentVersionOut], int]:
    """The signed-in issuer's own registrations, newest first. `q` matches the fingerprint prefix or the title."""
    cid, now = settings.chain_id, utcnow()
    stmt = (
        select(DocumentVersion)
        .outerjoin(DocumentUpload, (DocumentUpload.document_hash == DocumentVersion.document_hash)
                   & (DocumentUpload.uploader_address == DocumentVersion.issuer_address))
        .where(DocumentVersion.chain_id == cid, DocumentVersion.issuer_address == issuer)
    )
    if document_type:
        stmt = stmt.where(DocumentVersion.document_type == document_type)
    if status == "revoked":
        stmt = stmt.where(DocumentVersion.status == "revoked")
    elif status == "expired":
        stmt = stmt.where(DocumentVersion.status == "valid", DocumentVersion.expires_at.is_not(None), DocumentVersion.expires_at <= now)
    elif status == "valid":
        stmt = stmt.where(DocumentVersion.status == "valid", or_(DocumentVersion.expires_at.is_(None), DocumentVersion.expires_at > now))
    if q:
        needle = q.strip().lower()
        like = "%" + needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(or_(DocumentVersion.document_hash.like(needle + "%" if needle.startswith("0x") else "0x" + needle + "%"),
                              func.lower(DocumentUpload.title).like(like, escape="\\")))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(DocumentVersion.registered_at.desc(), DocumentVersion.document_hash).limit(limit).offset(offset)).all()
    latest = {d.document_id: d.latest_version for d in db.scalars(
        select(Document).where(Document.chain_id == cid, Document.document_id.in_({r.document_id for r in rows})))}
    names = issuer_names(db, cid, {issuer})
    return [version_out(db, settings, r, latest.get(r.document_id, r.version_number), issuer, names) for r in rows], total
