"""Verity document registry: replace the prediction-market read model

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-05

Keeps users, sessions, auth nonces and the generic indexer tables (chain_events, indexed_blocks,
indexer_checkpoints). Retires every prediction-market table. The retired tables and the old contracts'
indexed events describe a different product on a different set of contracts, so they are removed here;
nothing a Verity deployment needs is lost. This step is intentionally one-way.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

RETIRED_TABLES = [
    "daily_activity",
    "trades",
    "price_snapshots",
    "positions",
    "resolution_proposals",
    "resolution_evidence",
    "markets",
    "market_metadata",
    "external_data",
]


def upgrade() -> None:
    for table in RETIRED_TABLES:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    # events/blocks/checkpoints recorded for the retired contracts cannot be interpreted by the Verity indexer
    op.execute("DELETE FROM chain_events")
    op.execute("DELETE FROM indexed_blocks")
    op.execute("DELETE FROM indexer_checkpoints")

    ts = sa.DateTime(timezone=True)
    op.create_table(
        "issuers",
        sa.Column("chain_id", sa.Integer(), nullable=False),
        sa.Column("address", sa.String(42), nullable=False),
        sa.Column("organization_name", sa.String(100), nullable=False),
        sa.Column("authorized", sa.Boolean(), nullable=False),
        sa.Column("authorized_at", ts, nullable=False),
        sa.Column("removed_at", ts, nullable=True),
        sa.Column("authorized_by", sa.String(42), nullable=False),
        sa.Column("transaction_hash", sa.String(66), nullable=False),
        sa.PrimaryKeyConstraint("chain_id", "address"),
    )
    op.create_table(
        "documents",
        sa.Column("chain_id", sa.Integer(), nullable=False),
        sa.Column("document_id", sa.String(66), nullable=False),
        sa.Column("issuer_address", sa.String(42), nullable=False),
        sa.Column("document_type", sa.String(40), nullable=False),
        sa.Column("latest_version", sa.Integer(), nullable=False),
        sa.Column("created_at", ts, nullable=False),
        sa.Column("updated_at", ts, nullable=False),
        sa.PrimaryKeyConstraint("chain_id", "document_id"),
    )
    op.create_index("ix_documents_issuer", "documents", ["chain_id", "issuer_address"])
    op.create_table(
        "document_versions",
        sa.Column("chain_id", sa.Integer(), nullable=False),
        sa.Column("document_hash", sa.String(66), nullable=False),
        sa.Column("document_id", sa.String(66), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("issuer_address", sa.String(42), nullable=False),
        sa.Column("document_type", sa.String(40), nullable=False),
        sa.Column("metadata_hash", sa.String(66), nullable=False),
        sa.Column("registered_at", ts, nullable=False),
        sa.Column("expires_at", ts, nullable=True),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("revoked_at", ts, nullable=True),
        sa.Column("revoked_by", sa.String(42), nullable=True),
        sa.Column("reason_hash", sa.String(66), nullable=True),
        sa.Column("transaction_hash", sa.String(66), nullable=False),
        sa.Column("revocation_transaction_hash", sa.String(66), nullable=True),
        sa.Column("block_number", sa.BigInteger(), nullable=False),
        sa.Column("contract_address", sa.String(42), nullable=False),
        sa.PrimaryKeyConstraint("chain_id", "document_hash"),
        sa.ForeignKeyConstraint(["chain_id", "document_id"], ["documents.chain_id", "documents.document_id"], ondelete="CASCADE"),
    )
    op.create_index("ix_versions_document", "document_versions", ["chain_id", "document_id", "version_number"])
    op.create_index("ix_versions_issuer", "document_versions", ["chain_id", "issuer_address", "registered_at"])
    op.create_index("ix_versions_status", "document_versions", ["chain_id", "status"])
    op.create_table(
        "batches",
        sa.Column("chain_id", sa.Integer(), nullable=False),
        sa.Column("batch_id", sa.BigInteger(), nullable=False),
        sa.Column("merkle_root", sa.String(66), nullable=False),
        sa.Column("issuer_address", sa.String(42), nullable=False),
        sa.Column("document_count", sa.Integer(), nullable=False),
        sa.Column("metadata_hash", sa.String(66), nullable=False),
        sa.Column("registered_at", ts, nullable=False),
        sa.Column("revoked_at", ts, nullable=True),
        sa.Column("transaction_hash", sa.String(66), nullable=False),
        sa.Column("block_number", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("chain_id", "batch_id"),
    )
    op.create_index("ix_batches_root", "batches", ["chain_id", "merkle_root"], unique=True)
    op.create_index("ix_batches_issuer", "batches", ["chain_id", "issuer_address", "registered_at"])
    op.create_table(
        "batch_document_revocations",
        sa.Column("chain_id", sa.Integer(), nullable=False),
        sa.Column("batch_id", sa.BigInteger(), nullable=False),
        sa.Column("document_hash", sa.String(66), nullable=False),
        sa.Column("revoked_at", ts, nullable=False),
        sa.Column("revoked_by", sa.String(42), nullable=False),
        sa.Column("transaction_hash", sa.String(66), nullable=False),
        sa.PrimaryKeyConstraint("chain_id", "batch_id", "document_hash"),
    )
    op.create_table(
        "audit_logs",
        sa.Column("chain_id", sa.Integer(), nullable=False),
        sa.Column("transaction_hash", sa.String(66), nullable=False),
        sa.Column("log_index", sa.Integer(), nullable=False),
        sa.Column("action", sa.String(40), nullable=False),
        sa.Column("actor", sa.String(42), nullable=False),
        sa.Column("resource_id", sa.String(80), nullable=False),
        sa.Column("block_number", sa.BigInteger(), nullable=False),
        sa.Column("timestamp", ts, nullable=False),
        sa.PrimaryKeyConstraint("chain_id", "transaction_hash", "log_index"),
    )
    op.create_index("ix_audit_time", "audit_logs", ["chain_id", "block_number", "log_index"])
    op.create_index("ix_audit_action", "audit_logs", ["chain_id", "action"])
    op.create_index("ix_audit_actor", "audit_logs", ["chain_id", "actor"])
    op.create_table(
        "document_uploads",
        sa.Column("document_hash", sa.String(66), nullable=False),
        sa.Column("uploader_address", sa.String(42), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("document_type", sa.String(40), nullable=False),
        sa.Column("visibility", sa.String(10), nullable=False),
        sa.Column("metadata_json", postgresql.JSONB(), nullable=False),
        sa.Column("metadata_hash", sa.String(66), nullable=False),
        sa.Column("storage_key", sa.String(200), nullable=False),
        sa.Column("content_type", sa.String(100), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("created_at", ts, nullable=False),
        sa.PrimaryKeyConstraint("document_hash", "uploader_address"),
    )
    op.create_table(
        "batch_documents",
        sa.Column("chain_id", sa.Integer(), nullable=False),
        sa.Column("merkle_root", sa.String(66), nullable=False),
        sa.Column("document_hash", sa.String(66), nullable=False),
        sa.Column("leaf_index", sa.Integer(), nullable=False),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("proof", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", ts, nullable=False),
        sa.PrimaryKeyConstraint("chain_id", "merkle_root", "document_hash"),
    )
    op.create_index("ix_batch_docs_hash", "batch_documents", ["chain_id", "document_hash"])


def downgrade() -> None:
    raise NotImplementedError("0006 retires the prediction-market schema and cannot be reversed; restore a database backup instead")
