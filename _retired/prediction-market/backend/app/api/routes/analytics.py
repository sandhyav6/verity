from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import DbDep, SettingsDep
from app.schemas.analytics import CategoryStat, MarketStat, OverviewOut
from app.services import analytics_service

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/overview", response_model=OverviewOut)
def overview(db: DbDep, settings: SettingsDep) -> OverviewOut:
    return analytics_service.overview(db, settings.chain_id)


@router.get("/categories", response_model=list[CategoryStat])
def categories(db: DbDep, settings: SettingsDep) -> list[CategoryStat]:
    return analytics_service.categories(db, settings.chain_id)


@router.get("/markets", response_model=list[MarketStat])
def markets(
    db: DbDep, settings: SettingsDep,
    limit: Annotated[int, Query(ge=1, le=100)] = 20, offset: Annotated[int, Query(ge=0)] = 0,
) -> list[MarketStat]:
    return analytics_service.per_market(db, settings.chain_id, limit, offset)
