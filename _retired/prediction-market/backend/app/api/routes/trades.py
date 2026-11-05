from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import DbDep, SettingsDep
from app.core.security import normalize_address
from app.schemas.common import Page
from app.schemas.trade import TradeOut
from app.services import market_service

router = APIRouter(prefix="/trades", tags=["trades"])


@router.get("", response_model=Page[TradeOut])
def list_trades(
    db: DbDep,
    settings: SettingsDep,
    wallet: str | None = None,
    market_id: Annotated[int | None, Query(ge=1)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Page[TradeOut]:
    """Indexed trades, newest first. Every row is a confirmed on-chain event (see /transactions/{hash})."""
    addr = normalize_address(wallet) if wallet else None
    items, total = market_service.list_trades(
        db, settings.explorer_tx_url, settings.chain_id, wallet=addr, market_id=market_id, limit=limit, offset=offset
    )
    return Page(items=items, total=total, limit=limit, offset=offset)
