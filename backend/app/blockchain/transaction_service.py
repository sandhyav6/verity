"""Read-only chain queries used by the API: transaction status and its indexed events."""

from eth_utils import is_hex
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.blockchain.client import ChainClient
from app.core.config import Settings
from app.models import ChainEvent
from app.schemas.registry import TransactionOut


def valid_tx_hash(value: str) -> bool:
    return len(value) == 66 and value.startswith("0x") and is_hex(value)


def explorer_url(settings: Settings, tx_hash: str | None) -> str | None:
    return (settings.explorer_tx_url + tx_hash) if settings.explorer_tx_url and tx_hash else None


def transaction_status(db: Session, client: ChainClient, settings: Settings, tx_hash: str) -> TransactionOut:
    tx_hash = tx_hash.lower()
    receipt = client.receipt(tx_hash)
    events = db.scalars(
        select(ChainEvent.event_name).where(ChainEvent.chain_id == settings.chain_id, ChainEvent.transaction_hash == tx_hash)
    ).all()
    explorer = explorer_url(settings, tx_hash)
    needed = settings.indexer_confirmations

    if receipt is None:
        status = "pending" if client.transaction(tx_hash) is not None else "not_found"
        return TransactionOut(
            transaction_hash=tx_hash, status=status, block_number=None, confirmations=0,
            required_confirmations=needed, indexed=False, indexed_events=[], explorer_url=explorer,
        )
    head = client.head()
    return TransactionOut(
        transaction_hash=tx_hash,
        status="success" if receipt["status"] == 1 else "failed",
        block_number=receipt["blockNumber"],
        confirmations=max(head - receipt["blockNumber"] + 1, 0),
        required_confirmations=needed,
        indexed=bool(events),
        indexed_events=list(events),
        explorer_url=explorer,
    )
