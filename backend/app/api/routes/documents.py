import hashlib
import json
import logging
import uuid
from collections.abc import Iterator
from typing import Annotated, Literal

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.api.deps import DbDep, IssuerUser, OptionalUser, SettingsDep, StorageDep, limiter
from app.core.config import get_settings
from app.database.base import utcnow
from app.models import Document, DocumentUpload, DocumentVersion
from app.models.verity import DOCUMENT_TYPE_INDEX
from app.schemas.common import Page
from app.schemas.registry import DocumentDetailOut, DocumentVersionOut, UploadOut
from app.services.documents import list_issuer_documents, version_out, versions_of
from app.storage import StorageError
from app.verity.filetypes import UnsupportedFileType, detect_content_type
from app.verity.hashing import CHUNK_SIZE, InvalidHash, canonical_json, metadata_hash, normalize_hash

log = logging.getLogger(__name__)
router = APIRouter(prefix="/documents", tags=["documents"])
_s = get_settings()

MAX_ATTRIBUTES = 20
SNIFF_BYTES = 8192


def _parse_metadata(raw: str) -> dict[str, str]:
    try:
        value = json.loads(raw or "{}")
    except json.JSONDecodeError:
        raise HTTPException(422, "metadata must be a JSON object") from None
    if not isinstance(value, dict) or len(value) > MAX_ATTRIBUTES:
        raise HTTPException(422, f"metadata must be an object with at most {MAX_ATTRIBUTES} entries")
    for k, v in value.items():
        if not isinstance(v, str) or not (1 <= len(k) <= 64) or len(v) > 500:
            raise HTTPException(422, "metadata keys (1-64 chars) and values (max 500 chars) must be strings")
    return value


@router.post("/uploads", response_model=UploadOut, status_code=status.HTTP_201_CREATED)
@limiter.limit(_s.rate_limit_upload)
def upload_document(
    request: Request,
    db: DbDep,
    settings: SettingsDep,
    storage: StorageDep,
    user: IssuerUser,
    file: Annotated[UploadFile, File()],
    title: Annotated[str, Form(min_length=1, max_length=200)],
    document_type: Annotated[str, Form()],
    visibility: Annotated[Literal["public", "private"], Form()] = "private",
    metadata: Annotated[str, Form()] = "{}",
    expected_hash: Annotated[str | None, Form()] = None,
) -> UploadOut:
    """Step 1 of registration. Streams the file to storage while computing its SHA-256, validates it, and
    returns the fingerprint and metadata hash the wallet must then register on-chain. Nothing is
    registered by this call; the file only becomes a verifiable record once the issuer's transaction is mined."""
    if document_type not in DOCUMENT_TYPE_INDEX:
        raise HTTPException(422, f"document_type must be one of {sorted(DOCUMENT_TYPE_INDEX)}")
    attributes = _parse_metadata(metadata)
    expected = None
    if expected_hash:
        try:
            expected = normalize_hash(expected_hash)
        except InvalidHash as exc:
            raise HTTPException(422, str(exc)) from None

    hasher, head, size = hashlib.sha256(), bytearray(), 0

    def chunks() -> Iterator[bytes]:
        nonlocal size
        while chunk := file.file.read(CHUNK_SIZE):
            size += len(chunk)
            if size > settings.max_upload_bytes:
                raise HTTPException(413, f"file exceeds the {settings.max_upload_bytes // (1024 * 1024)} MiB limit")
            if len(head) < SNIFF_BYTES:
                head.extend(chunk[: SNIFF_BYTES - len(head)])
            hasher.update(chunk)
            yield chunk

    incoming = f"incoming/{uuid.uuid4().hex}"
    try:
        storage.save(incoming, chunks())
        content_type = detect_content_type(bytes(head))
    except UnsupportedFileType as exc:
        storage.delete(incoming)
        raise HTTPException(415, str(exc)) from None
    except StorageError:
        log.exception("storage failure during upload")
        raise HTTPException(503, "document storage is unavailable") from None

    document_hash = "0x" + hasher.hexdigest()
    if expected is not None and expected != document_hash:
        storage.delete(incoming)
        raise HTTPException(422, "the uploaded bytes do not match the fingerprint computed in your browser; retry the upload")

    key = f"{user.wallet_address[2:]}/{document_hash[2:]}"
    storage.rename(incoming, key)
    canonical = {"title": title.strip(), "document_type": document_type, "attributes": attributes}
    m_hash = metadata_hash(canonical)

    stmt = pg_insert(DocumentUpload).values(
        document_hash=document_hash, uploader_address=user.wallet_address, title=title.strip(), document_type=document_type,
        visibility=visibility, metadata_json=attributes, metadata_hash=m_hash, storage_key=key, content_type=content_type,
        size_bytes=size, created_at=utcnow(),
    )
    db.execute(stmt.on_conflict_do_update(
        index_elements=["document_hash", "uploader_address"],
        set_={k: stmt.excluded[k] for k in ("title", "document_type", "visibility", "metadata_json", "metadata_hash", "storage_key",
                                           "content_type", "size_bytes", "created_at")},
    ))
    db.commit()
    log.info("upload stored: hash=%s issuer=%s size=%d type=%s", document_hash, user.wallet_address, size, content_type)
    return UploadOut(document_hash=document_hash, metadata_hash=m_hash, canonical_metadata=canonical_json(canonical), title=title.strip(),
                     document_type=document_type, visibility=visibility, content_type=content_type, size_bytes=size)


@router.get("", response_model=Page[DocumentVersionOut])
def list_documents(
    db: DbDep, settings: SettingsDep, user: IssuerUser,
    q: Annotated[str | None, Query(max_length=100)] = None,
    status_: Annotated[Literal["valid", "revoked", "expired"] | None, Query(alias="status")] = None,
    document_type: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Page[DocumentVersionOut]:
    """The signed-in issuer's own registrations (there is deliberately no public directory of documents)."""
    items, total = list_issuer_documents(db, settings, user.wallet_address, q=q, status=status_, document_type=document_type,
                                         limit=limit, offset=offset)
    return Page(items=items, total=total, limit=limit, offset=offset)


def _version_or_404(db, settings, document_hash: str) -> DocumentVersion:
    try:
        h = normalize_hash(document_hash)
    except InvalidHash as exc:
        raise HTTPException(422, str(exc)) from None
    v = db.get(DocumentVersion, (settings.chain_id, h))
    if v is None:
        raise HTTPException(404, "no indexed registration for this fingerprint")
    return v


@router.get("/{document_hash}", response_model=DocumentDetailOut)
def get_document(document_hash: str, db: DbDep, settings: SettingsDep, user: OptionalUser) -> DocumentDetailOut:
    """Registration facts and version history for a fingerprint. Titles and metadata appear only for public
    documents (or to the issuer). For an authoritative verdict use /verify, which asks the chain."""
    v = _version_or_404(db, settings, document_hash)
    viewer = user.wallet_address if user else None
    versions = versions_of(db, settings, settings.chain_id, v.document_id, viewer)
    current = next(x for x in versions if x.document_hash == v.document_hash)
    return DocumentDetailOut(document=current, versions=versions)


@router.get("/{document_hash}/file")
def download_document(document_hash: str, db: DbDep, settings: SettingsDep, storage: StorageDep, user: OptionalUser) -> StreamingResponse:
    """Stored bytes of a registered document: public documents to anyone, private ones to their issuer only."""
    v = _version_or_404(db, settings, document_hash)
    upload = db.get(DocumentUpload, (v.document_hash, v.issuer_address))
    viewer = user.wallet_address if user else None
    if upload is None or not (upload.visibility == "public" or viewer == v.issuer_address):
        # same answer for "no file" and "not allowed" so existence of private files is not revealed
        raise HTTPException(404, "no downloadable file for this fingerprint")
    try:
        stream = storage.open(upload.storage_key)
    except StorageError:
        raise HTTPException(404, "no downloadable file for this fingerprint") from None
    return StreamingResponse(
        stream, media_type="application/octet-stream",  # never the sniffed type: the browser must not render it
        headers={"Content-Disposition": f'attachment; filename="{v.document_hash[2:18]}.bin"', "Content-Length": str(upload.size_bytes),
                 "X-Content-Type-Options": "nosniff", "X-Original-Content-Type": upload.content_type},
    )
