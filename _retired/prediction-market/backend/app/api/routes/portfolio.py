from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from app.api.deps import ChainDep, DbDep, SettingsDep
from app.blockchain.client import ChainUnavailable
from app.blockchain.transaction_service import token_balance
from app.core.security import normalize_address
from app.schemas.portfolio import PortfolioOut, PortfolioPoint
from app.services import portfolio_service

router = APIRouter(prefix="/portfolio", tags=["portfolio"])


@router.get("/{address}", response_model=PortfolioOut)
def get_portfolio(address: str, db: DbDep, settings: SettingsDep, chain: ChainDep) -> PortfolioOut:
    addr = normalize_address(address)
    try:
        balance = token_balance(chain, settings, addr) if settings.token_address else None
    except ChainUnavailable:
        balance = None  # degrade gracefully: positions come from the database, balance says unavailable
    return portfolio_service.build_portfolio(db, addr, settings.chain_id, balance)


@router.get("/{address}/history", response_model=list[PortfolioPoint])
def get_history(
    address: str, db: DbDep, settings: SettingsDep,
    limit: Annotated[int, Query(ge=1, le=500)] = 100, offset: Annotated[int, Query(ge=0)] = 0,
) -> list[PortfolioPoint]:
    addr = normalize_address(address)
    if not addr:
        raise HTTPException(422, "invalid address")
    return portfolio_service.portfolio_history(db, addr, settings.chain_id, limit, offset)
