import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from sqlalchemy import delete, func, select

from app.api.deps import DbDep, IssuerUser, RegistryDep, SettingsDep, limiter
from app.blockchain.transaction_service import explorer_url
from app.database.base import utcnow
from app.models import Batch, BatchDocument, BatchDocumentRevocation, Issuer
from app.schemas.common import Page
from app.schemas.registry import BatchDocumentOut, BatchDocumentsIn, BatchOut, IssuerRef, ProofFile
from app.verity.hashing import InvalidHash, normalize_hash
from app.verity.merkle import merkle_root, proofs_for_all

log = logging.getLogger(__name__)
router = APIRouter(prefix="/batches", tags=["batches"])


def _out(db, settings, b: Batch) -> BatchOut:
    org = db.get(Issuer, (b.chain_id, b.issuer_address))
    stored = db.scalar(select(func.count()).select_from(BatchDocument).where(BatchDocument.chain_id == b.chain_id, BatchDocument.merkle_root == b.merkle_root)) or 0
    return BatchOut(batch_id=b.batch_id, merkle_root=b.merkle_root, issuer=IssuerRef(address=b.issuer_address, organization_name=org.organization_name if org else None),
                    document_count=b.document_count, metadata_hash=b.metadata_hash, registered_at=b.registered_at, revoked_at=b.revoked_at,
                    transaction_hash=b.transaction_hash, explorer_url=explorer_url(settings, b.transaction_hash), documents_stored=stored)


def _batch_or_404(db, settings, batch_id: int) -> Batch:
    b = db.get(Batch, (settings.chain_id, batch_id))
    if b is None:
        raise HTTPException(404, "no indexed batch with this id")
    return b


@router.get("", response_model=Page[BatchOut])
def list_batches(db: DbDep, settings: SettingsDep, user: IssuerUser, limit: Annotated[int, Query(ge=1, le=100)] = 25,
                 offset: Annotated[int, Query(ge=0)] = 0) -> Page[BatchOut]:
    """The signed-in issuer's own batches, newest first."""
    stmt = select(Batch).where(Batch.chain_id == settings.chain_id, Batch.issuer_address == user.wallet_address)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(Batch.batch_id.desc()).limit(limit).offset(offset)).all()
    return Page(items=[_out(db, settings, b) for b in rows], total=total, limit=limit, offset=offset)


@router.post("/documents", status_code=201)
@limiter.limit("10/minute")
def attach_batch_documents(request: Request, body: BatchDocumentsIn, db: DbDep, settings: SettingsDep, registry: RegistryDep, user: IssuerUser) -> dict:
    """Step 2 of batch registration, after the root transaction is mined: store each leaf and its Merkle proof so
    recipients can later verify individual documents. The server recomputes the tree from the submitted
    fingerprints and accepts them only if the root equals the one registered on-chain by this wallet."""
    try:
        root = normalize_hash(body.merkle_root)
        hashes = [normalize_hash(d.document_hash) for d in body.documents]
    except InvalidHash as exc:
        raise HTTPException(422, str(exc)) from None
    if len(set(hashes)) != len(hashes):
        raise HTTPException(422, "duplicate document fingerprints in the batch")
    if merkle_root(hashes) != root:
        raise HTTPException(422, "the submitted fingerprints do not produce the stated Merkle root")
    batch_id = registry.batch_id_by_root(root)
    chain_batch = registry.get_batch(batch_id) if batch_id else None
    if chain_batch is None:
        raise HTTPException(409, "this Merkle root is not registered on-chain (wait for the transaction to be mined)")
    if chain_batch["issuer"] != user.wallet_address:
        raise HTTPException(403, "this batch was registered by a different wallet")
    if chain_batch["document_count"] != len(hashes):
        raise HTTPException(422, f"the on-chain batch declares {chain_batch['document_count']} documents, not {len(hashes)}")

    proofs = proofs_for_all(hashes)
    db.execute(delete(BatchDocument).where(BatchDocument.chain_id == settings.chain_id, BatchDocument.merkle_root == root))
    now = utcnow()
    for i, (d, h) in enumerate(zip(body.documents, hashes)):
        db.add(BatchDocument(chain_id=settings.chain_id, merkle_root=root, document_hash=h, leaf_index=i, filename=d.filename,
                             size_bytes=d.size_bytes, proof=proofs[i], created_at=now))
    db.commit()
    log.info("stored %d batch leaves for root %s (batch %d)", len(hashes), root, batch_id)
    return {"batch_id": batch_id, "merkle_root": root, "stored": len(hashes)}


@router.get("/{batch_id}", response_model=BatchOut)
def get_batch(batch_id: int, db: DbDep, settings: SettingsDep) -> BatchOut:
    return _out(db, settings, _batch_or_404(db, settings, batch_id))


@router.get("/{batch_id}/documents", response_model=Page[BatchDocumentOut])
def batch_documents(batch_id: int, db: DbDep, settings: SettingsDep, user: IssuerUser, limit: Annotated[int, Query(ge=1, le=200)] = 50,
                    offset: Annotated[int, Query(ge=0)] = 0) -> Page[BatchDocumentOut]:
    """Leaf records (filenames included) are the issuer's private data."""
    b = _batch_or_404(db, settings, batch_id)
    if b.issuer_address != user.wallet_address:
        raise HTTPException(403, "only the issuing wallet can list a batch's documents")
    stmt = select(BatchDocument).where(BatchDocument.chain_id == b.chain_id, BatchDocument.merkle_root == b.merkle_root)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(BatchDocument.leaf_index).limit(limit).offset(offset)).all()
    revoked = {r.document_hash: r.revoked_at for r in db.scalars(select(BatchDocumentRevocation).where(
        BatchDocumentRevocation.chain_id == b.chain_id, BatchDocumentRevocation.batch_id == b.batch_id))}
    items = [BatchDocumentOut(document_hash=r.document_hash, leaf_index=r.leaf_index, filename=r.filename, size_bytes=r.size_bytes,
                              proof=list(r.proof), revoked_at=revoked.get(r.document_hash) or b.revoked_at) for r in rows]
    return Page(items=items, total=total, limit=limit, offset=offset)


@router.get("/{batch_id}/proof/{document_hash}", response_model=ProofFile)
def proof_file(batch_id: int, document_hash: str, db: DbDep, settings: SettingsDep) -> ProofFile:
    """A self-contained proof an issuer can hand to a recipient. Contains only hashes (no filenames)."""
    b = _batch_or_404(db, settings, batch_id)
    try:
        h = normalize_hash(document_hash)
    except InvalidHash as exc:
        raise HTTPException(422, str(exc)) from None
    row = db.get(BatchDocument, (b.chain_id, b.merkle_root, h))
    if row is None:
        raise HTTPException(404, "no proof stored for this fingerprint in this batch")
    return ProofFile(batch_id=b.batch_id, merkle_root=b.merkle_root, document_hash=h, leaf_index=row.leaf_index, proof=list(row.proof),
                     chain_id=b.chain_id, contract_address=settings.registry_address.lower())
