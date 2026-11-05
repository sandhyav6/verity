"""Indexer tests against a real Hardhat node, the real VerityRegistry and real PostgreSQL."""

import hashlib

import pytest
from sqlalchemy import func, select

from app.blockchain.reconcile import reconcile
from app.core.config import get_settings
from app.database.connection import session_scope
from app.models import AuditLog, Batch, ChainEvent, Document, DocumentVersion, IndexedBlock, IndexerCheckpoint, Issuer
from app.verity.merkle import merkle_root
from app.workers.indexer import build_indexer


def fp(label: str) -> str:
    return "0x" + hashlib.sha256(label.encode()).hexdigest()


def count(session, model) -> int:
    return session.scalar(select(func.count()).select_from(model))


def test_indexes_everything_and_is_idempotent(db_clean, chain):
    h1, h2 = fp("idx-1"), fp("idx-2")
    chain.register(h1, doc_type=5)
    chain.register(h2, document_id=bytes.fromhex(h1[2:]))  # second version of the same document
    chain.revoke(h1)
    chain.send(chain.registry.functions.authorizeIssuer(chain.outsider, "Late Org"), chain.admin)
    chain.send(chain.registry.functions.removeIssuer(chain.outsider), chain.admin)
    root = merkle_root([fp("b1"), fp("b2"), fp("b3")])
    chain.register_batch(root, 3)

    idx = build_indexer()
    result = idx.catch_up()
    assert result.events_applied >= 8  # 2 issuers (deploy) + 2 registrations + revoke + 2 issuer events + batch

    with session_scope() as s:
        v1, v2 = s.get(DocumentVersion, (31337, h1)), s.get(DocumentVersion, (31337, h2))
        assert (v1.version_number, v1.status, v1.document_type) == (1, "revoked", "audit_report")
        assert v1.revoked_by == chain.issuer.lower() and v1.revocation_transaction_hash
        assert (v2.version_number, v2.status, v2.document_id) == (2, "valid", v1.document_id)
        assert s.get(Document, (31337, v1.document_id)).latest_version == 2
        assert s.get(Issuer, (31337, chain.issuer.lower())).organization_name == "Northfield University"
        late = s.get(Issuer, (31337, chain.outsider.lower()))
        assert late.authorized is False and late.removed_at is not None
        batch = s.scalar(select(Batch).where(Batch.merkle_root == root))
        assert batch.document_count == 3 and batch.issuer_address == chain.issuer.lower()
        before = (count(s, ChainEvent), count(s, AuditLog), count(s, DocumentVersion))

    # replaying the same range is a no-op: no duplicate events, rows or audit entries
    with session_scope() as s:
        s.query(IndexerCheckpoint).delete()  # force a re-scan from START_BLOCK
    again = build_indexer().catch_up()
    assert again.events_applied == 0
    with session_scope() as s:
        assert (count(s, ChainEvent), count(s, AuditLog), count(s, DocumentVersion)) == before


def test_indexer_resumes_from_checkpoint_and_picks_up_new_events(db_clean, chain):
    idx = build_indexer()
    idx.catch_up()
    h = fp("resume-1")
    chain.register(h)
    r = idx.catch_up()
    assert r.events_applied == 1
    with session_scope() as s:
        assert s.get(DocumentVersion, (31337, h)) is not None
        assert s.get(IndexerCheckpoint, 31337).last_block == chain.w3.eth.block_number


def test_reorg_rolls_back_and_reindexes_the_new_branch(db_clean, chain):
    idx = build_indexer()
    stable = fp("reorg-stable")
    chain.register(stable)
    idx.catch_up()

    snap = chain.snapshot()
    doomed = fp("reorg-doomed")
    chain.register(doomed)
    chain.revoke(stable)
    idx.catch_up()
    with session_scope() as s:
        assert s.get(DocumentVersion, (31337, doomed)) is not None
        assert s.get(DocumentVersion, (31337, stable)).status == "revoked"

    chain.revert(snap)  # the registration of `doomed` and the revocation never happened on the canonical chain
    survivor = fp("reorg-survivor")
    chain.register(survivor, sender=chain.issuer2)
    chain.mine(2)
    result = idx.catch_up()
    assert result.reorg_to is not None

    with session_scope() as s:
        assert s.get(DocumentVersion, (31337, doomed)) is None, "orphaned registration must be gone"
        assert s.get(DocumentVersion, (31337, stable)).status == "valid", "orphaned revocation must be undone"
        assert s.get(DocumentVersion, (31337, survivor)) is not None
        assert s.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.resource_id == doomed)) == 0
        assert s.scalar(select(func.count()).select_from(ChainEvent).where(
            ChainEvent.event_name == "DocumentRevoked", ChainEvent.args["documentHash"].astext == stable)) == 0
        assert s.get(IndexerCheckpoint, 31337).last_block == chain.w3.eth.block_number
        assert s.get(IndexedBlock, (31337, chain.w3.eth.block_number)).hash == chain.w3.eth.get_block("latest")["hash"].to_0x_hex()
    with session_scope() as s:
        assert reconcile(s, build_indexer().client, get_settings()) == []


def test_reconcile_reports_database_drift(db_clean, chain):
    h = fp("drift-1")
    chain.register(h)
    idx = build_indexer()
    idx.catch_up()
    with session_scope() as s:
        assert reconcile(s, idx.client, get_settings()) == []
        s.get(DocumentVersion, (31337, h)).status = "revoked"  # tamper with the read model
    with session_scope() as s:
        problems = reconcile(s, idx.client, get_settings())
        assert any("status" in p and h in p for p in problems)


def test_events_from_other_contracts_are_ignored(db_clean, chain):
    from web3 import Web3

    idx = build_indexer()
    idx.catch_up()
    with session_scope() as s:
        before = count(s, ChainEvent)
    # plain value transfer produces no registry logs at all
    chain.w3.eth.wait_for_transaction_receipt(chain.w3.eth.send_transaction({"from": chain.admin, "to": Web3.to_checksum_address(chain.outsider), "value": 1}))
    assert idx.catch_up().events_applied == 0
    with session_scope() as s:
        assert count(s, ChainEvent) == before
