"""Verity read model.

Two kinds of tables:
  * DERIVED from chain events (issuers, documents, document_versions, batches, batch_document_revocations,
    audit_logs): wiped and replayed from `chain_events` after a reorganisation; the chain is authoritative.
  * OFF-CHAIN data supplied by issuers (document_uploads, batch_documents): never derived from the chain,
    so a rebuild leaves them untouched.
"""

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, ForeignKeyConstraint, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base, UTCDateTime, utcnow

# Index == the Solidity enum VerityRegistry.DocumentType
DOCUMENT_TYPES = {
    0: "other",
    1: "academic_certificate",
    2: "internship_certificate",
    3: "research_publication",
    4: "compliance_document",
    5: "audit_report",
    6: "legal_agreement",
    7: "software_release",
    8: "official_report",
}
DOCUMENT_TYPE_INDEX = {name: i for i, name in DOCUMENT_TYPES.items()}


class Issuer(Base):
    __tablename__ = "issuers"

    chain_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    address: Mapped[str] = mapped_column(String(42), primary_key=True)  # lowercase
    organization_name: Mapped[str] = mapped_column(String(100))
    authorized: Mapped[bool] = mapped_column(Boolean)
    authorized_at: Mapped[datetime] = mapped_column(UTCDateTime)
    removed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    authorized_by: Mapped[str] = mapped_column(String(42))
    transaction_hash: Mapped[str] = mapped_column(String(66))


class Document(Base):
    """A logical document: the set of versions that share one on-chain documentId."""

    __tablename__ = "documents"

    chain_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    document_id: Mapped[str] = mapped_column(String(66), primary_key=True)
    issuer_address: Mapped[str] = mapped_column(String(42))
    document_type: Mapped[str] = mapped_column(String(40))
    latest_version: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime)

    __table_args__ = (Index("ix_documents_issuer", "chain_id", "issuer_address"),)


class DocumentVersion(Base):
    """One on-chain registration (one fingerprint). Facts only; titles/metadata live in document_uploads."""

    __tablename__ = "document_versions"

    chain_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    document_hash: Mapped[str] = mapped_column(String(66), primary_key=True)  # 0x + 64 hex, lowercase SHA-256
    document_id: Mapped[str] = mapped_column(String(66))
    version_number: Mapped[int] = mapped_column(Integer)
    issuer_address: Mapped[str] = mapped_column(String(42))
    document_type: Mapped[str] = mapped_column(String(40))
    metadata_hash: Mapped[str] = mapped_column(String(66))
    registered_at: Mapped[datetime] = mapped_column(UTCDateTime)
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(10), default="valid")  # valid | revoked (expiry is computed)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    revoked_by: Mapped[str | None] = mapped_column(String(42), nullable=True)
    reason_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    transaction_hash: Mapped[str] = mapped_column(String(66))
    revocation_transaction_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    block_number: Mapped[int] = mapped_column(BigInteger)
    contract_address: Mapped[str] = mapped_column(String(42))

    __table_args__ = (
        ForeignKeyConstraint(["chain_id", "document_id"], ["documents.chain_id", "documents.document_id"], ondelete="CASCADE"),
        Index("ix_versions_document", "chain_id", "document_id", "version_number"),
        Index("ix_versions_issuer", "chain_id", "issuer_address", "registered_at"),
        Index("ix_versions_status", "chain_id", "status"),
    )


class Batch(Base):
    __tablename__ = "batches"

    chain_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    merkle_root: Mapped[str] = mapped_column(String(66))
    issuer_address: Mapped[str] = mapped_column(String(42))
    document_count: Mapped[int] = mapped_column(Integer)
    metadata_hash: Mapped[str] = mapped_column(String(66))
    registered_at: Mapped[datetime] = mapped_column(UTCDateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    transaction_hash: Mapped[str] = mapped_column(String(66))
    block_number: Mapped[int] = mapped_column(BigInteger)

    __table_args__ = (
        Index("ix_batches_root", "chain_id", "merkle_root", unique=True),
        Index("ix_batches_issuer", "chain_id", "issuer_address", "registered_at"),
    )


class BatchDocumentRevocation(Base):
    __tablename__ = "batch_document_revocations"

    chain_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    document_hash: Mapped[str] = mapped_column(String(66), primary_key=True)
    revoked_at: Mapped[datetime] = mapped_column(UTCDateTime)
    revoked_by: Mapped[str] = mapped_column(String(42))
    transaction_hash: Mapped[str] = mapped_column(String(66))


class AuditLog(Base):
    """One row per registry event, in chain order. Derived from chain_events (rebuilt after a reorg)."""

    __tablename__ = "audit_logs"

    chain_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    transaction_hash: Mapped[str] = mapped_column(String(66), primary_key=True)
    log_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    action: Mapped[str] = mapped_column(String(40))
    actor: Mapped[str] = mapped_column(String(42))
    resource_id: Mapped[str] = mapped_column(String(80))
    block_number: Mapped[int] = mapped_column(BigInteger)
    timestamp: Mapped[datetime] = mapped_column(UTCDateTime)

    __table_args__ = (
        Index("ix_audit_time", "chain_id", "block_number", "log_index"),
        Index("ix_audit_action", "chain_id", "action"),
        Index("ix_audit_actor", "chain_id", "actor"),
    )


class DocumentUpload(Base):
    """Off-chain record of an uploaded file and its metadata, keyed by fingerprint and uploading issuer.
    Only trusted for a registration when the uploader is the on-chain issuer of that fingerprint."""

    __tablename__ = "document_uploads"

    document_hash: Mapped[str] = mapped_column(String(66), primary_key=True)
    uploader_address: Mapped[str] = mapped_column(String(42), primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    document_type: Mapped[str] = mapped_column(String(40))
    visibility: Mapped[str] = mapped_column(String(10))  # public | private
    metadata_json: Mapped[dict] = mapped_column(JSONB)
    metadata_hash: Mapped[str] = mapped_column(String(66))
    storage_key: Mapped[str] = mapped_column(String(200))  # private: never returned by the API
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class BatchDocument(Base):
    """Off-chain leaf record of a batch: which fingerprint sits at which position, and its Merkle proof."""

    __tablename__ = "batch_documents"

    chain_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    merkle_root: Mapped[str] = mapped_column(String(66), primary_key=True)
    document_hash: Mapped[str] = mapped_column(String(66), primary_key=True)
    leaf_index: Mapped[int] = mapped_column(Integer)
    filename: Mapped[str] = mapped_column(String(255))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    proof: Mapped[list] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    __table_args__ = (Index("ix_batch_docs_hash", "chain_id", "document_hash"),)
