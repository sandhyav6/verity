"""Response/request models for the Verity API. Hashes are 0x + 64 lowercase hex; addresses are lowercase."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

Verdict = Literal["verified", "revoked", "expired", "not_verified"]
DocStatus = Literal["valid", "revoked", "expired"]


class IssuerRef(BaseModel):
    address: str
    organization_name: str | None = None
    currently_authorized: bool | None = None  # from the chain at lookup time


class IssuerOut(BaseModel):
    address: str
    organization_name: str
    authorized: bool
    authorized_at: datetime
    removed_at: datetime | None
    authorized_by: str
    transaction_hash: str
    document_count: int = 0
    batch_count: int = 0
    revoked_count: int = 0


class DocumentVersionOut(BaseModel):
    document_hash: str
    document_id: str
    version_number: int
    is_latest: bool
    issuer: IssuerRef
    document_type: str
    status: DocStatus
    registered_at: datetime
    expires_at: datetime | None
    revoked_at: datetime | None
    revoked_by: str | None
    transaction_hash: str
    revocation_transaction_hash: str | None
    explorer_url: str | None
    block_number: int
    metadata_hash: str
    # Off-chain details: present only for public documents or when the viewer is the issuer.
    title: str | None = None
    metadata: dict | None = None
    visibility: Literal["public", "private"] | None = None
    metadata_verified: bool | None = None  # sha256(canonical metadata) == on-chain metadataHash
    content_type: str | None = None
    size_bytes: int | None = None
    file_available: bool = False


class DocumentDetailOut(BaseModel):
    document: DocumentVersionOut
    versions: list[DocumentVersionOut]


class UploadOut(BaseModel):
    document_hash: str
    metadata_hash: str
    canonical_metadata: str
    title: str
    document_type: str
    visibility: str
    content_type: str
    size_bytes: int


class Registration(BaseModel):
    kind: Literal["document", "batch"]
    issuer: IssuerRef
    registered_at: datetime
    expires_at: datetime | None = None
    revoked_at: datetime | None = None
    revoked_by: str | None = None
    document_id: str | None = None
    document_type: str | None = None
    version_number: int | None = None
    latest_version: int | None = None
    is_latest: bool | None = None
    batch_id: int | None = None
    merkle_root: str | None = None
    transaction_hash: str | None = None  # from the indexed read model; None until the indexer has seen it
    explorer_url: str | None = None
    title: str | None = None  # only when public (or the viewer is the issuer)


class VerificationOut(BaseModel):
    document_hash: str
    verdict: Verdict
    reason: str
    checked_at: datetime
    chain_id: int
    contract_address: str
    registration: Registration | None


class VerifyIn(BaseModel):
    document_hash: str = Field(min_length=64, max_length=66)


class ProofEntry(BaseModel):
    batch_id: int
    merkle_root: str
    leaf_index: int
    proof: list[str]


class ProofsOut(BaseModel):
    document_hash: str
    entries: list[ProofEntry]


class BatchOut(BaseModel):
    batch_id: int
    merkle_root: str
    issuer: IssuerRef
    document_count: int
    metadata_hash: str
    registered_at: datetime
    revoked_at: datetime | None
    transaction_hash: str
    explorer_url: str | None
    documents_stored: int = 0  # leaf records the issuer has attached (needed to hand out proofs)


class BatchDocumentIn(BaseModel):
    document_hash: str
    filename: str = Field(min_length=1, max_length=255)
    size_bytes: int = Field(ge=0)


class BatchDocumentsIn(BaseModel):
    merkle_root: str
    documents: list[BatchDocumentIn] = Field(min_length=1, max_length=5000)


class BatchDocumentOut(BaseModel):
    document_hash: str
    leaf_index: int
    filename: str
    size_bytes: int
    proof: list[str]
    revoked_at: datetime | None = None


class ProofFile(BaseModel):
    """What an issuer hands to a recipient so they can verify one document of a batch."""

    version: int = 1
    batch_id: int
    merkle_root: str
    document_hash: str
    leaf_index: int
    proof: list[str]
    chain_id: int
    contract_address: str


class AuditOut(BaseModel):
    action: str
    actor: str
    resource_id: str
    transaction_hash: str
    block_number: int
    timestamp: datetime
    explorer_url: str | None


class DayCount(BaseModel):
    day: str
    registrations: int
    revocations: int


class StatsOut(BaseModel):
    scope: Literal["mine", "global"]
    total_documents: int
    valid_documents: int
    revoked_documents: int
    expired_documents: int
    total_batches: int
    authorized_issuers: int
    daily: list[DayCount]


class TransactionOut(BaseModel):
    transaction_hash: str
    status: str  # pending | success | failed | not_found
    block_number: int | None
    confirmations: int
    required_confirmations: int
    indexed: bool
    indexed_events: list[str]
    explorer_url: str | None
