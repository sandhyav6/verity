"""Compare the PostgreSQL read model with the contract. The chain is the source of truth: any
difference reported here means the database is wrong (or the indexer is behind), never the chain."""

from sqlalchemy import select
from sqlalchemy.orm import Session
from web3 import Web3

from app.blockchain.client import ChainClient
from app.blockchain.contract_registry import load_abi
from app.core.config import Settings
from app.models import Batch, DocumentVersion, IndexerCheckpoint, Issuer

STATUS = {0: "not_registered", 1: "valid", 2: "revoked", 3: "valid"}  # the DB models expiry as a computed state


def reconcile(db: Session, client: ChainClient, settings: Settings) -> list[str]:
    """Return human-readable discrepancies, evaluated at the indexer's checkpoint block (so an
    indexer that is merely behind the chain head does not produce false alarms)."""
    chain_id = settings.chain_id
    cp = db.get(IndexerCheckpoint, chain_id)
    if cp is None:
        return []
    block = cp.last_block
    c = client.w3.eth.contract(address=Web3.to_checksum_address(settings.registry_address), abi=load_abi("registry")).functions
    problems: list[str] = []

    for v in db.scalars(select(DocumentVersion).where(DocumentVersion.chain_id == chain_id)):
        onchain = c.verifyDocument(bytes.fromhex(v.document_hash[2:])).call(block_identifier=block)
        status, issuer, version = STATUS[onchain[0]], onchain[1].lower(), int(onchain[4])
        if status != v.status:
            problems.append(f"document {v.document_hash} status: db={v.status} chain={status}")
        if issuer != v.issuer_address:
            problems.append(f"document {v.document_hash} issuer: db={v.issuer_address} chain={issuer}")
        if version != v.version_number:
            problems.append(f"document {v.document_hash} version: db={v.version_number} chain={version}")

    for i in db.scalars(select(Issuer).where(Issuer.chain_id == chain_id)):
        authorized = bool(c.isAuthorizedIssuer(Web3.to_checksum_address(i.address)).call(block_identifier=block))
        if authorized != i.authorized:
            problems.append(f"issuer {i.address} authorized: db={i.authorized} chain={authorized}")

    for b in db.scalars(select(Batch).where(Batch.chain_id == chain_id)):
        onchain = c.getBatch(b.batch_id).call(block_identifier=block)
        root = "0x" + bytes(onchain[4]).hex()
        if root != b.merkle_root:
            problems.append(f"batch {b.batch_id} root: db={b.merkle_root} chain={root}")
        if (int(onchain[2]) != 0) != (b.revoked_at is not None):
            problems.append(f"batch {b.batch_id} revoked: db={b.revoked_at is not None} chain={int(onchain[2]) != 0}")
    return problems
