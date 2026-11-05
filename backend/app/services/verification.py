"""Document verification. The verdict comes from the CONTRACT (an eth_call to VerityRegistry), never from the
database: the backend cannot make an unregistered or revoked document look valid. The database is only used
to decorate the answer (organisation name, transaction hash, public title) and to find Merkle proofs."""

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.blockchain.registry import RegistryReader
from app.blockchain.transaction_service import explorer_url
from app.core.config import Settings
from app.database.base import utcnow
from app.models import Batch, BatchDocument, DocumentUpload, DocumentVersion, Issuer
from app.schemas.registry import IssuerRef, Registration, VerificationOut


def _dt(unix: int) -> datetime | None:
    return datetime.fromtimestamp(unix, tz=timezone.utc) if unix else None


def _issuer_ref(db: Session, settings: Settings, address: str, authorized: bool) -> IssuerRef:
    row = db.get(Issuer, (settings.chain_id, address))
    return IssuerRef(address=address, organization_name=row.organization_name if row else None, currently_authorized=authorized)


def _result(settings: Settings, h: str, verdict: str, reason: str, registration: Registration | None) -> VerificationOut:
    return VerificationOut(document_hash=h, verdict=verdict, reason=reason, checked_at=utcnow(), chain_id=settings.chain_id,  # type: ignore[arg-type]
                           contract_address=settings.registry_address.lower(), registration=registration)


def verify_fingerprint(db: Session, reader: RegistryReader, settings: Settings, document_hash: str, viewer: str | None) -> VerificationOut:
    on = reader.verify_document(document_hash)
    if on.status != "not_registered":
        v = db.get(DocumentVersion, (settings.chain_id, document_hash))
        title = None
        if v is not None:
            up = db.get(DocumentUpload, (document_hash, v.issuer_address))
            if up is not None and (up.visibility == "public" or viewer == v.issuer_address):
                title = up.title
        reg = Registration(
            kind="document", issuer=_issuer_ref(db, settings, on.issuer, on.issuer_authorized), registered_at=_dt(on.registered_at),  # type: ignore[arg-type]
            expires_at=_dt(on.expires_at), revoked_at=_dt(on.revoked_at), revoked_by=on.revoked_by if on.revoked_at else None,
            document_id=on.document_id, document_type=on.document_type, version_number=on.version, latest_version=on.latest_version,
            is_latest=on.version >= on.latest_version, transaction_hash=v.transaction_hash if v else None,
            explorer_url=explorer_url(settings, v.transaction_hash if v else None), title=title,
        )
        if on.status == "valid":
            reason = "This fingerprint is registered on-chain, was issued by the address shown, and has not been revoked."
            if not on.issuer_authorized:
                reason += " Note: the issuer is no longer authorised to issue new documents; this registration predates its removal."
            if not reg.is_latest:
                reason += f" A newer version ({on.latest_version}) of this document has since been registered."
            return _result(settings, document_hash, "verified", reason, reg)
        if on.status == "revoked":
            return _result(settings, document_hash, "revoked",
                           "The issuer revoked this document. The original registration is preserved, but it must no longer be relied on.", reg)
        return _result(settings, document_hash, "expired", "The registration exists but its validity period has ended.", reg)

    # Not registered individually: is it a member of a registered Merkle batch?
    candidates = db.scalars(select(BatchDocument).where(BatchDocument.chain_id == settings.chain_id, BatchDocument.document_hash == document_hash)).all()
    for cand in candidates:
        batch_id = reader.batch_id_by_root(cand.merkle_root)
        if not batch_id:
            continue  # leaf record submitted for a root that is not registered on-chain: ignored
        res = reader.verify_batch_document(batch_id, document_hash, list(cand.proof))
        if not res.included:
            continue
        batch = db.get(Batch, (settings.chain_id, batch_id))
        reg = Registration(
            kind="batch", issuer=_issuer_ref(db, settings, res.issuer, res.issuer_authorized), registered_at=_dt(res.registered_at),  # type: ignore[arg-type]
            revoked_at=_dt(res.revoked_at), batch_id=batch_id, merkle_root=res.merkle_root,
            transaction_hash=batch.transaction_hash if batch else None,
            explorer_url=explorer_url(settings, batch.transaction_hash if batch else None),
        )
        if res.status == "revoked":
            return _result(settings, document_hash, "revoked", "This document belongs to a registered batch, but the issuer revoked it (or the whole batch).", reg)
        return _result(settings, document_hash, "verified",
                       "This fingerprint is proven to be a member of a batch whose Merkle root the issuer registered on-chain, and it has not been revoked.", reg)

    return _result(settings, document_hash, "not_verified",
                   "No registration exists for this fingerprint. Either the document was never registered, or the file differs from the registered one by at least one byte.", None)
