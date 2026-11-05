from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query

from app.api.deps import DbDep, SettingsDep
from app.core.security import require_user
from app.models import User
from app.schemas.common import Page
from app.schemas.market import Category, MarketCreate, MarketCreateOut, MarketOut, SnapshotOut
from app.schemas.resolution import EvidenceOut
from app.schemas.trade import TradeOut
from app.services import market_service, resolution_service

router = APIRouter(prefix="/markets", tags=["markets"])

Limit = Annotated[int, Query(ge=1, le=100)]
Offset = Annotated[int, Query(ge=0)]


@router.get("", response_model=Page[MarketOut])
def list_markets(
    db: DbDep,
    settings: SettingsDep,
    category: Category | None = None,
    status: Literal["active", "closed", "resolved", "invalid"] | None = None,
    q: Annotated[str | None, Query(max_length=100, description="search the question text")] = None,
    sort: Literal["created_at", "volume", "trade_count", "closing"] = "created_at",
    order: Literal["asc", "desc"] = "desc",
    limit: Limit = 20,
    offset: Offset = 0,
) -> Page[MarketOut]:
    items, total = market_service.list_markets(
        db, category=category, status=status, q=q, sort=sort, order=order, limit=limit, offset=offset,
        chain_id=settings.chain_id,
    )
    return Page(items=items, total=total, limit=limit, offset=offset)


@router.post("", response_model=MarketCreateOut, status_code=201)
def register_market(
    payload: MarketCreate, db: DbDep, settings: SettingsDep, user: Annotated[User, Depends(require_user)]
) -> MarketCreateOut:
    """Validates and stores the market definition off-chain and returns the on-chain call parameters.

    It does NOT create the market: only MarketFactory.createMarket (callable by CREATOR_ROLE
    accounts) does, signed by the creator's wallet.
    """
    return market_service.register_metadata(db, payload, user.wallet_address, settings)


@router.get("/{market_id}", response_model=MarketOut)
def get_market(market_id: int, db: DbDep, settings: SettingsDep) -> MarketOut:
    market, meta = market_service.get_market_row(db, market_id, settings.chain_id)
    return market_service.to_market_out(market, meta)


@router.get("/{market_id}/history", response_model=Page[SnapshotOut])
def get_history(market_id: int, db: DbDep, settings: SettingsDep, limit: Annotated[int, Query(ge=1, le=1000)] = 500,
                offset: Offset = 0) -> Page[SnapshotOut]:
    """Probability history: one point per actual trade (the contract state right after it)."""
    market, _ = market_service.get_market_row(db, market_id, settings.chain_id)
    items, total = market_service.price_history(db, market, limit, offset)
    return Page(items=items, total=total, limit=limit, offset=offset)


@router.get("/{market_id}/trades", response_model=Page[TradeOut])
def get_trades(market_id: int, db: DbDep, settings: SettingsDep, limit: Limit = 20, offset: Offset = 0) -> Page[TradeOut]:
    market, meta = market_service.get_market_row(db, market_id, settings.chain_id)
    question = market_service.to_market_out(market, meta).question
    items, total = market_service.market_trades(db, market, question, settings.explorer_tx_url, limit, offset)
    return Page(items=items, total=total, limit=limit, offset=offset)


@router.get("/{market_id}/evidence", response_model=list[EvidenceOut])
def get_evidence(market_id: int, db: DbDep, settings: SettingsDep) -> list[EvidenceOut]:
    market, _ = market_service.get_market_row(db, market_id, settings.chain_id)
    return resolution_service.market_evidence(db, settings, market)
