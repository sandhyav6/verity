"""Applies decoded VerityRegistry events to the PostgreSQL read model.

Two rules keep the read model trustworthy:
  1. Every event is first inserted into `chain_events` (primary key = chain_id, tx hash, log index).
     Only a *newly inserted* event is applied, so replaying a batch is a no-op (idempotent).
  2. All derived tables (issuers, documents, versions, batches, audit log) are pure functions of
     `chain_events`, so after a reorganisation they are wiped and rebuilt by replay (`rebuild_derived`).
Off-chain data (uploads, batch proofs, users, sessions) is never touched by a rebuild.
"""

import logging
from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.blockchain.contract_registry import DecodedEvent
from app.database.base import utcnow
from app.models import (
    AuditLog,
    Batch,
    BatchDocumentRevocation,
    ChainEvent,
    Document,
    DocumentVersion,
    Issuer,
)
from app.models.verity import DOCUMENT_TYPES

log = logging.getLogger(__name__)


def _ts(unix: int | str) -> datetime:
    return datetime.fromtimestamp(int(unix), tz=timezone.utc)


def record_and_apply(session: Session, ev: DecodedEvent, block_time: datetime) -> bool:
    """Insert the raw event; apply it to read models only if it was new. Returns True if applied."""
    stmt = (
        pg_insert(ChainEvent)
        .values(
            chain_id=ev.chain_id,
            transaction_hash=ev.transaction_hash,
            log_index=ev.log_index,
            block_number=ev.block_number,
            block_hash=ev.block_hash,
            block_time=block_time,
            contract_address=ev.contract_address,
            event_name=ev.name,
            args=ev.args,
            indexed_at=utcnow(),
        )
        .on_conflict_do_nothing()
        .returning(ChainEvent.log_index)
    )
    if session.execute(stmt).first() is None:
        return False
    apply_event(session, ev.chain_id, ev.transaction_hash, ev.log_index, ev.block_number, block_time,
                ev.contract_address, ev.name, ev.args)
    return True


def apply_event(session: Session, chain_id: int, tx_hash: str, log_index: int, block_number: int,
                block_time: datetime, address: str, name: str, a: dict) -> None:
    handler = _HANDLERS.get(name)
    if handler is None:
        return
    handler(session, chain_id, tx_hash, log_index, block_number, block_time, address, a)


def _audit(session: Session, chain_id: int, tx: str, li: int, block: int, t: datetime, action: str, actor: str, resource: str) -> None:
    session.add(AuditLog(chain_id=chain_id, transaction_hash=tx, log_index=li, action=action, actor=actor.lower(),
                         resource_id=resource, block_number=block, timestamp=t))


# ----------------------------------------------------------------------------- handlers


def _issuer_authorized(session, chain_id, tx, li, block, t, address, a):
    issuer = a["issuer"].lower()
    row = session.get(Issuer, (chain_id, issuer))
    if row is None:
        session.add(Issuer(chain_id=chain_id, address=issuer, organization_name=a["name"], authorized=True,
                           authorized_at=t, removed_at=None, authorized_by=a["authorizedBy"].lower(), transaction_hash=tx))
    else:
        row.organization_name, row.authorized, row.authorized_at, row.removed_at = a["name"], True, t, None
        row.authorized_by, row.transaction_hash = a["authorizedBy"].lower(), tx
    _audit(session, chain_id, tx, li, block, t, "issuer.authorized", a["authorizedBy"], issuer)


def _issuer_removed(session, chain_id, tx, li, block, t, address, a):
    issuer = a["issuer"].lower()
    row = session.get(Issuer, (chain_id, issuer))
    if row is None:
        log.warning("IssuerRemoved for unknown issuer %s", issuer)
    else:
        row.authorized, row.removed_at = False, t
    _audit(session, chain_id, tx, li, block, t, "issuer.removed", a["removedBy"], issuer)


def _document_registered(session, chain_id, tx, li, block, t, address, a):
    document_id, version = a["documentId"], int(a["version"])
    doc_type = DOCUMENT_TYPES.get(int(a["docType"]), "other")
    doc = session.get(Document, (chain_id, document_id))
    if doc is None:
        session.add(Document(chain_id=chain_id, document_id=document_id, issuer_address=a["issuer"].lower(),
                             document_type=doc_type, latest_version=version, created_at=t, updated_at=t))
        session.flush()
    elif version >= doc.latest_version:
        doc.latest_version, doc.document_type, doc.updated_at = version, doc_type, t
    expires = int(a["expiresAt"])
    session.add(DocumentVersion(
        chain_id=chain_id, document_hash=a["documentHash"], document_id=document_id, version_number=version,
        issuer_address=a["issuer"].lower(), document_type=doc_type, metadata_hash=a["metadataHash"], registered_at=t,
        expires_at=_ts(expires) if expires else None, status="valid", transaction_hash=tx, block_number=block,
        contract_address=address,
    ))
    _audit(session, chain_id, tx, li, block, t, "document.registered", a["issuer"], a["documentHash"])


def _document_revoked(session, chain_id, tx, li, block, t, address, a):
    row = session.get(DocumentVersion, (chain_id, a["documentHash"]))
    if row is None:
        log.warning("DocumentRevoked for unknown document %s", a["documentHash"])
    else:
        row.status, row.revoked_at, row.revoked_by = "revoked", t, a["revokedBy"].lower()
        row.reason_hash, row.revocation_transaction_hash = a["reasonHash"], tx
    _audit(session, chain_id, tx, li, block, t, "document.revoked", a["revokedBy"], a["documentHash"])


def _batch_registered(session, chain_id, tx, li, block, t, address, a):
    session.add(Batch(
        chain_id=chain_id, batch_id=int(a["batchId"]), merkle_root=a["merkleRoot"], issuer_address=a["issuer"].lower(),
        document_count=int(a["documentCount"]), metadata_hash=a["metadataHash"], registered_at=t, transaction_hash=tx,
        block_number=block,
    ))
    _audit(session, chain_id, tx, li, block, t, "batch.registered", a["issuer"], f"batch:{int(a['batchId'])}")


def _batch_revoked(session, chain_id, tx, li, block, t, address, a):
    row = session.get(Batch, (chain_id, int(a["batchId"])))
    if row is not None:
        row.revoked_at = t
    _audit(session, chain_id, tx, li, block, t, "batch.revoked", a["revokedBy"], f"batch:{int(a['batchId'])}")


def _batch_document_revoked(session, chain_id, tx, li, block, t, address, a):
    session.add(BatchDocumentRevocation(chain_id=chain_id, batch_id=int(a["batchId"]), document_hash=a["documentHash"],
                                        revoked_at=t, revoked_by=a["revokedBy"].lower(), transaction_hash=tx))
    _audit(session, chain_id, tx, li, block, t, "batch.document_revoked", a["revokedBy"], a["documentHash"])


_HANDLERS = {
    "IssuerAuthorized": _issuer_authorized,
    "IssuerRemoved": _issuer_removed,
    "DocumentRegistered": _document_registered,
    "DocumentRevoked": _document_revoked,
    "BatchRegistered": _batch_registered,
    "BatchRevoked": _batch_revoked,
    "BatchDocumentRevoked": _batch_document_revoked,
}


# ----------------------------------------------------------------------------- rebuild


def rebuild_derived(session: Session, chain_id: int) -> int:
    """Delete every derived row and replay `chain_events` in chain order. Returns events replayed.

    Used after a reorganisation (and available as an operator tool). Off-chain data such as uploads,
    batch proofs, users and sessions is untouched.
    """
    for model in (AuditLog, BatchDocumentRevocation, Batch, DocumentVersion, Document, Issuer):
        session.execute(delete(model).where(model.chain_id == chain_id))
    session.flush()

    rows = session.scalars(
        select(ChainEvent).where(ChainEvent.chain_id == chain_id).order_by(ChainEvent.block_number, ChainEvent.log_index)
    ).all()
    for row in rows:
        apply_event(session, row.chain_id, row.transaction_hash, row.log_index, row.block_number, row.block_time,
                    row.contract_address, row.event_name, row.args)
    session.flush()
    return len(rows)
