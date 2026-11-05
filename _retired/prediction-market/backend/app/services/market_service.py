import json
from datetime import datetime
from decimal import Decimal
from typing import Any

from eth_utils import keccak
from fastapi import HTTPException
from sqlalchemy import Select, case, cast, func, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.clock import utcnow
from app.models import Market, MarketMetadata, PriceSnapshot, Trade
from app.models.market import CATEGORY_CODES
from app.schemas.market import FactoryParams, MarketCreate, MarketCreateOut, MarketOut, SnapshotOut
from app.schemas.trade import TradeOut

WAD = 10**18
METADATA_SCHEMA = "pm-market-metadata/1"


def canonical_json(obj: Any) -> str:
    """Deterministic JSON: sorted keys, no whitespace, UTF-8. The hash input is exactly these bytes."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def keccak_hex(text: str) -> str:
    return "0x" + keccak(text=text).hex()


# ------------------------------------------------------------------ creation (off-chain metadata)


def register_metadata(db: Session, payload: MarketCreate, creator: str, settings: Settings) -> MarketCreateOut:
    """Store the market definition and return the hash + exact parameters for the factory call.

    Nothing is created on-chain here: the creator's wallet must call MarketFactory.createMarket.
    The indexer later links the on-chain market to this row through `metadata_hash`.
    """
    close, deadline = int(payload.trading_close_time.timestamp()), int(payload.resolution_deadline.timestamp())
    b_wei = int(payload.liquidity_parameter) * WAD
    document = {
        "schema": METADATA_SCHEMA,
        "question": payload.question,
        "description": payload.description,
        "category": payload.category,
        "yes_definition": payload.yes_definition,
        "no_definition": payload.no_definition,
        "resolution_source": payload.resolution_source.model_dump(),
        "resolution_criteria": payload.resolution_criteria,
        "resolution_spec": payload.resolution_spec.model_dump(),
        "trading_close": close,
        "resolution_deadline": deadline,
        "liquidity_b_wei": str(b_wei),
    }
    if payload.data_rule is not None:
        document["data_rule"] = payload.data_rule.model_dump(mode="json")
    text = canonical_json(document)
    digest = keccak_hex(text)
    if db.get(MarketMetadata, digest) is None:
        db.add(MarketMetadata(metadata_hash=digest, canonical_json=text, created_by=creator, created_at=utcnow()))
        db.commit()
    return MarketCreateOut(
        metadata_hash=digest,
        factory_params=FactoryParams(
            metadataHash=digest,
            category=CATEGORY_CODES[payload.category],
            tradingClose=close,
            resolutionDeadline=deadline,
            liquidityB=str(b_wei),
        ),
        factory_address=settings.factory_address,
        note=(
            "Metadata stored off-chain. The market exists only after your wallet calls "
            "MarketFactory.createMarket(factory_params) and the indexer sees the event. TEST tokens only."
        ),
    )


# ------------------------------------------------------------------ reading


def derived_status():
    now = utcnow()
    return case(
        (Market.status == "resolved", "resolved"),
        (Market.status == "invalid", "invalid"),
        (Market.trading_close_time > now, "active"),
        else_="closed",
    )


def _metadata_dict(row: MarketMetadata | None) -> dict | None:
    return json.loads(row.canonical_json) if row else None


def _verified(market: Market, row: MarketMetadata | None, doc: dict | None) -> bool:
    if row is None or doc is None or keccak_hex(row.canonical_json) != market.metadata_hash:
        return False
    return (
        doc.get("trading_close") == int(market.trading_close_time.timestamp())
        and doc.get("resolution_deadline") == int(market.resolution_deadline.timestamp())
        and doc.get("liquidity_b_wei") == str(int(market.liquidity_parameter))
        and CATEGORY_CODES.get(doc.get("category", "")) == CATEGORY_CODES.get(market.category)
    )


def status_of(market: Market, now: datetime | None = None) -> str:
    if market.status in ("resolved", "invalid"):
        return market.status
    return "active" if market.trading_close_time > (now or utcnow()) else "closed"


def to_market_out(market: Market, row: MarketMetadata | None) -> MarketOut:
    doc = _metadata_dict(row)
    yes = Decimal(market.yes_price)
    return MarketOut(
        id=market.blockchain_market_id,
        contract_address=market.contract_address,
        question=(doc or {}).get("question", "(metadata not registered with this backend)"),
        description=(doc or {}).get("description"),
        category=market.category,
        yes_definition=(doc or {}).get("yes_definition"),
        no_definition=(doc or {}).get("no_definition"),
        resolution_source=(doc or {}).get("resolution_source"),
        resolution_criteria=(doc or {}).get("resolution_criteria"),
        resolution_spec=(doc or {}).get("resolution_spec"),
        data_rule=(doc or {}).get("data_rule"),
        resolution_data_note=(
            "Resolves from Open-Meteo reanalysis data (a weather model on a coarse grid), NOT ground-station observations."
            if (doc or {}).get("data_rule") else None
        ),
        metadata_verified=_verified(market, row, doc),
        metadata_hash=market.metadata_hash,
        status=status_of(market),
        winning_outcome=market.winning_outcome,
        yes_price=yes,
        no_price=Decimal(1) - yes,
        liquidity_parameter=str(int(market.liquidity_parameter)),
        q_yes=str(int(market.q_yes)),
        q_no=str(int(market.q_no)),
        collateral=str(int(market.collateral)),
        volume=str(int(market.volume)),
        trade_count=market.trade_count,
        created_by=market.created_by,
        created_at=market.created_at,
        trading_close_time=market.trading_close_time,
        resolution_deadline=market.resolution_deadline,
        resolved_at=market.resolved_at,
    )


SORTS = {
    "created_at": Market.created_at,
    "volume": Market.volume,
    "trade_count": Market.trade_count,
    "closing": Market.trading_close_time,
}


def list_markets(
    db: Session,
    *,
    category: str | None,
    status: str | None,
    q: str | None,
    sort: str,
    order: str,
    limit: int,
    offset: int,
    chain_id: int,
) -> tuple[list[MarketOut], int]:
    stmt: Select = (
        select(Market, MarketMetadata)
        .outerjoin(MarketMetadata, MarketMetadata.metadata_hash == Market.metadata_hash)
        .where(Market.chain_id == chain_id)
    )
    if category:
        stmt = stmt.where(Market.category == category)
    if status:
        stmt = stmt.where(derived_status() == status)
    if q:
        needle = "%" + q.replace("%", r"\%").replace("_", r"\_") + "%"
        stmt = stmt.where(cast(MarketMetadata.canonical_json, JSONB)["question"].astext.ilike(needle))

    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    col = SORTS[sort]
    stmt = stmt.order_by(col.desc() if order == "desc" else col.asc(), Market.id.asc()).limit(limit).offset(offset)
    return [to_market_out(m, md) for m, md in db.execute(stmt).all()], total


def get_market_row(db: Session, market_id: int, chain_id: int) -> tuple[Market, MarketMetadata | None]:
    m = db.scalar(select(Market).where(Market.chain_id == chain_id, Market.blockchain_market_id == market_id))
    if m is None:
        raise HTTPException(404, "market not found")
    return m, db.get(MarketMetadata, m.metadata_hash)


def price_history(db: Session, market: Market, limit: int, offset: int) -> tuple[list[SnapshotOut], int]:
    base = select(PriceSnapshot).where(PriceSnapshot.market_id == market.id)
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    rows = db.scalars(base.order_by(PriceSnapshot.block_number, PriceSnapshot.log_index).limit(limit).offset(offset)).all()
    return (
        [
            SnapshotOut(
                block_number=r.block_number, timestamp=r.block_time, yes_price=r.yes_price,
                q_yes=str(int(r.q_yes)), q_no=str(int(r.q_no)), transaction_hash=r.transaction_hash,
            )
            for r in rows
        ],
        total,
    )


def trade_out(t: Trade, market_id: int, question: str | None, explorer: str) -> TradeOut:
    shares, amount = int(t.shares), int(t.token_amount)
    return TradeOut(
        market_id=market_id, market_question=question, wallet_address=t.wallet_address, outcome=t.outcome,
        action=t.action, shares=str(shares), token_amount=str(amount),
        execution_price=(Decimal(amount) / Decimal(shares)) if shares else Decimal(0),
        yes_price_after=t.yes_price_after, transaction_hash=t.transaction_hash, block_number=t.block_number,
        log_index=t.log_index, timestamp=t.timestamp, explorer_url=(explorer + t.transaction_hash) if explorer else None,
    )


def market_trades(db: Session, market: Market, question: str | None, explorer: str, limit: int, offset: int):
    base = select(Trade).where(Trade.market_id == market.id)
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    rows = db.scalars(base.order_by(Trade.block_number.desc(), Trade.log_index.desc()).limit(limit).offset(offset)).all()
    return [trade_out(t, market.blockchain_market_id, question, explorer) for t in rows], total



def list_trades(db: Session, explorer: str, chain_id: int, *, wallet: str | None, market_id: int | None, limit: int, offset: int):
    """Newest-first trades across markets (optionally for one wallet or one market)."""
    stmt = (
        select(Trade, Market, MarketMetadata)
        .join(Market, Market.id == Trade.market_id)
        .outerjoin(MarketMetadata, MarketMetadata.metadata_hash == Market.metadata_hash)
        .where(Market.chain_id == chain_id)
    )
    if wallet:
        stmt = stmt.where(Trade.wallet_address == wallet.lower())
    if market_id is not None:
        stmt = stmt.where(Market.blockchain_market_id == market_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.execute(stmt.order_by(Trade.block_number.desc(), Trade.log_index.desc()).limit(limit).offset(offset)).all()
    items = [
        trade_out(t, m.blockchain_market_id, json.loads(md.canonical_json)["question"] if md else None, explorer)
        for t, m, md in rows
    ]
    return items, total
