import json
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.models import DailyActivity, IndexerCheckpoint, Market, MarketMetadata, Position
from app.schemas.analytics import ActivityPoint, CategoryStat, MarketStat, OverviewOut
from app.services.market_service import derived_status, status_of

# All metrics are aggregates over indexed blockchain records. Nothing here is estimated or seeded.


ACTIVITY_DAYS = 90  # the daily chart covers the last 90 days; totals below are all-time


def overview(db: Session, chain_id: int) -> OverviewOut:
    """Cheap by construction: totals come from the per-market counters the indexer maintains (no scan of
    `trades`), unique traders from `positions` (one row per trader per market), and the daily series is
    read from the `daily_activity` rollup (last ACTIVITY_DAYS)."""
    status = derived_status().label("derived_status")  # one labelled expression: GROUP BY its alias
    by_status = dict(db.execute(select(status, func.count()).where(Market.chain_id == chain_id).group_by(status)).all())
    trades, volume = db.execute(
        select(func.coalesce(func.sum(Market.trade_count), 0), func.coalesce(func.sum(Market.volume), 0)).where(Market.chain_id == chain_id)
    ).one()
    traders = db.scalar(
        select(func.count(func.distinct(Position.wallet_address))).join(Market, Market.id == Position.market_id).where(Market.chain_id == chain_id)
    )
    activity = db.execute(
        select(DailyActivity.day, DailyActivity.trades, DailyActivity.volume)
        .where(DailyActivity.chain_id == chain_id, DailyActivity.day >= (utcnow() - timedelta(days=ACTIVITY_DAYS)).date())
        .order_by(DailyActivity.day)
    ).all()
    cp = db.get(IndexerCheckpoint, chain_id)
    return OverviewOut(
        markets_total=sum(by_status.values()),
        markets_by_status={s: by_status.get(s, 0) for s in ("active", "closed", "resolved", "invalid")},
        trades_total=int(trades),
        unique_traders=traders or 0,
        total_volume=str(int(volume)),
        last_indexed_block=cp.last_block if cp else None,
        indexed_at=cp.updated_at if cp else None,
        activity=[ActivityPoint(day=d, trades=n, volume=str(int(v))) for d, n, v in activity],
    )


def categories(db: Session, chain_id: int) -> list[CategoryStat]:
    rows = db.execute(
        select(Market.category, func.count(), func.coalesce(func.sum(Market.trade_count), 0), func.coalesce(func.sum(Market.volume), 0))
        .where(Market.chain_id == chain_id)
        .group_by(Market.category)
        .order_by(Market.category)
    ).all()
    return [CategoryStat(category=c, markets=n, trades=int(t), volume=str(int(v))) for c, n, t, v in rows]


def per_market(db: Session, chain_id: int, limit: int, offset: int) -> list[MarketStat]:
    rows = db.execute(
        select(Market, MarketMetadata)
        .outerjoin(MarketMetadata, MarketMetadata.metadata_hash == Market.metadata_hash)
        .where(Market.chain_id == chain_id)
        .order_by(Market.volume.desc(), Market.id)
        .limit(limit)
        .offset(offset)
    ).all()
    # trader counts only for the markets on this page (positions holds one row per trader per market)
    ids = [m.id for m, _ in rows]
    traders = dict(
        db.execute(select(Position.market_id, func.count()).where(Position.market_id.in_(ids)).group_by(Position.market_id)).all()
    ) if ids else {}
    return [
        MarketStat(
            id=m.blockchain_market_id,
            question=json.loads(md.canonical_json)["question"] if md else "(metadata not registered)",
            category=m.category, status=status_of(m), yes_price=m.yes_price, trades=m.trade_count,
            unique_traders=traders.get(m.id, 0), volume=str(int(m.volume)),
        )
        for m, md in rows
    ]
