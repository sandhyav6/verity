from fastapi import APIRouter, HTTPException

from app.api.deps import ChainDep, DbDep, SettingsDep
from app.blockchain.transaction_service import transaction_status, valid_tx_hash
from app.schemas.registry import TransactionOut

router = APIRouter(prefix="/transactions", tags=["transactions"])


@router.get("/{tx_hash}", response_model=TransactionOut)
def get_transaction(tx_hash: str, db: DbDep, settings: SettingsDep, chain: ChainDep) -> TransactionOut:
    """Chain status of a transaction (pending / success / failed), confirmations, and whether the indexer has
    processed its events. The wallet's own receipt remains the primary signal; this explains what we have indexed."""
    if not valid_tx_hash(tx_hash):
        raise HTTPException(422, "invalid transaction hash")
    return transaction_status(db, chain, settings, tx_hash)
