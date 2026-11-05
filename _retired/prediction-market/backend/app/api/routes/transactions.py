from fastapi import APIRouter, HTTPException

from app.api.deps import ChainDep, DbDep, SettingsDep
from app.blockchain.client import ChainUnavailable
from app.blockchain.transaction_service import transaction_status, valid_tx_hash
from app.schemas.trade import TransactionOut

router = APIRouter(prefix="/transactions", tags=["transactions"])


@router.get("/{tx_hash}", response_model=TransactionOut)
def get_transaction(tx_hash: str, db: DbDep, settings: SettingsDep, chain: ChainDep) -> TransactionOut:
    """Live status from the node plus whether the indexer has processed the transaction's events.

    A transaction is only reported `success` here; the UI should treat it as final once
    `confirmations >= required_confirmations` and `indexed` is true.
    """
    if not valid_tx_hash(tx_hash):
        raise HTTPException(422, "transaction hash must be 0x followed by 64 hex characters")
    try:
        return transaction_status(db, chain, settings, tx_hash)
    except ChainUnavailable as exc:
        raise HTTPException(503, f"blockchain node unavailable: {exc}") from exc
