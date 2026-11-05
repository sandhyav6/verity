from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import select

from app.api.deps import DbDep, OptionalUser, RegistryDep, SettingsDep, limiter
from app.models import Batch, BatchDocument
from app.schemas.registry import ProofEntry, ProofsOut, VerificationOut, VerifyIn
from app.services.verification import verify_fingerprint
from app.verity.hashing import InvalidHash, normalize_hash

router = APIRouter(tags=["verification"])


def _hash_or_422(value: str) -> str:
    try:
        return normalize_hash(value)
    except InvalidHash as exc:
        raise HTTPException(422, str(exc)) from None


@router.post("/verify", response_model=VerificationOut)
@limiter.limit("60/minute")
def verify(request: Request, body: VerifyIn, db: DbDep, settings: SettingsDep, registry: RegistryDep, user: OptionalUser) -> VerificationOut:
    """Verify a SHA-256 fingerprint. The verdict is read from the VerityRegistry contract at request time.
    Files are hashed in the browser; this endpoint never receives document contents."""
    return verify_fingerprint(db, registry, settings, _hash_or_422(body.document_hash), user.wallet_address if user else None)


@router.get("/verify/{document_hash}", response_model=VerificationOut)
@limiter.limit("60/minute")
def verify_get(request: Request, document_hash: str, db: DbDep, settings: SettingsDep, registry: RegistryDep, user: OptionalUser) -> VerificationOut:
    return verify_fingerprint(db, registry, settings, _hash_or_422(document_hash), user.wallet_address if user else None)


@router.get("/proofs/{document_hash}", response_model=ProofsOut)
def proofs(document_hash: str, db: DbDep, settings: SettingsDep, registry: RegistryDep) -> ProofsOut:
    """Merkle proofs the backend holds for a fingerprint, so a client can verify batch membership directly
    against the contract without trusting this server (it only supplies hints; the contract decides)."""
    h = _hash_or_422(document_hash)
    rows = db.scalars(select(BatchDocument).where(BatchDocument.chain_id == settings.chain_id, BatchDocument.document_hash == h)).all()
    entries = []
    for r in rows:
        batch = db.scalar(select(Batch).where(Batch.chain_id == settings.chain_id, Batch.merkle_root == r.merkle_root))
        batch_id = batch.batch_id if batch else registry.batch_id_by_root(r.merkle_root)
        if batch_id:
            entries.append(ProofEntry(batch_id=batch_id, merkle_root=r.merkle_root, leaf_index=r.leaf_index, proof=list(r.proof)))
    return ProofsOut(document_hash=h, entries=entries)
