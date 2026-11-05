"""Polling event indexer.

Design (see docs/architecture.md):
  * Polling `eth_getLogs`, never relying on WebSockets. Missed events are recovered because the
    checkpoint only advances after a batch is fully committed.
  * Only blocks <= head - confirmations are indexed, so no indexed row is "unconfirmed".
  * One DB transaction per batch: raw events + derived rows + checkpoint commit together.
  * Reorg detection: the checkpoint block hash is compared with the chain on every run.
"""

import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.blockchain.client import ChainClient, ChainUnavailable
from app.blockchain.contract_registry import ContractRegistry, DecodedEvent
from app.blockchain.event_processor import rebuild_derived, record_and_apply
from app.core.config import Settings
from app.database.base import utcnow
from app.database.connection import session_scope
from app.models import ChainEvent, IndexedBlock, IndexerCheckpoint

log = logging.getLogger(__name__)


@dataclass
class IndexResult:
    head: int
    from_block: int | None = None
    to_block: int | None = None
    events_applied: int = 0
    reorg_to: int | None = None  # set when a reorganisation was detected and rolled back
    caught_up: bool = True


class Indexer:
    def __init__(self, client: ChainClient, registry: ContractRegistry, settings: Settings):
        self.client = client
        self.registry = registry
        self.settings = settings
        self.chain_id = settings.chain_id
        self.registry_address = settings.registry_address.lower()
        if not self.registry_address:
            raise ValueError("REGISTRY_ADDRESS must be configured")

    # ------------------------------------------------------------------ public API

    def run_once(self) -> IndexResult:
        """Index at most one batch. Safe to call repeatedly and after any crash."""
        self.client.assert_chain()
        head = self.client.head()
        safe_head = head - self.settings.indexer_confirmations
        result = IndexResult(head=head)

        with session_scope() as session:
            cp = session.get(IndexerCheckpoint, self.chain_id)
            if cp is not None:
                chain_hash = self.client.block_hash(cp.last_block) if cp.last_block <= head else None
                if chain_hash != cp.last_block_hash:
                    result.reorg_to = self._rollback(session, head)
                    cp = session.get(IndexerCheckpoint, self.chain_id)

            next_block = cp.last_block + 1 if cp else self.settings.start_block
            if next_block > safe_head:
                return result

            to_block = min(safe_head, next_block + self.settings.indexer_batch_size - 1)
            result.from_block, result.to_block = next_block, to_block
            result.caught_up = to_block >= safe_head

            tip_hash = self.client.block_hash(to_block)
            events = self._fetch_events(session, next_block, to_block)
            if self.client.block_hash(to_block) != tip_hash or tip_hash is None:
                session.rollback()  # chain moved under us while reading: discard the batch, retry later
                log.warning("block %d changed during fetch; retrying", to_block)
                result.to_block, result.caught_up = None, False
                return result

            block_times = {n: self._block_time(n) for n in {e.block_number for e in events}}
            for ev in events:
                if record_and_apply(session, ev, block_times[ev.block_number]):
                    result.events_applied += 1

            for n, h in {**{e.block_number: e.block_hash for e in events}, to_block: tip_hash}.items():
                session.execute(
                    pg_insert(IndexedBlock)
                    .values(chain_id=self.chain_id, number=n, hash=h)
                    .on_conflict_do_update(index_elements=["chain_id", "number"], set_={"hash": h})
                )
            session.execute(
                pg_insert(IndexerCheckpoint)
                .values(chain_id=self.chain_id, last_block=to_block, last_block_hash=tip_hash, updated_at=utcnow())
                .on_conflict_do_update(
                    index_elements=["chain_id"],
                    set_={"last_block": to_block, "last_block_hash": tip_hash, "updated_at": utcnow()},
                )
            )
        return result

    def catch_up(self) -> IndexResult:
        """Run batches until the indexer reaches the confirmed head (or a batch must be retried)."""
        total = IndexResult(head=0)
        while True:
            r = self.run_once()
            total.head = r.head
            total.events_applied += r.events_applied
            if r.reorg_to is not None:
                total.reorg_to = r.reorg_to
            if r.from_block is not None and total.from_block is None:
                total.from_block = r.from_block
            if r.to_block is not None:
                total.to_block = r.to_block
            if r.to_block is None or r.caught_up:
                return total

    def run_forever(self, stop=lambda: False) -> None:
        backoff = 1.0
        log.info(
            "indexer started: chain %d from block %d, %d confirmations, polling every %.1fs",
            self.chain_id, self.settings.start_block, self.settings.indexer_confirmations, self.settings.indexer_poll_seconds,
        )
        while not stop():
            try:
                r = self.catch_up()
                if r.events_applied:
                    log.info("indexed %d events up to block %s (head %d)", r.events_applied, r.to_block, r.head)
                backoff = 1.0
                time.sleep(self.settings.indexer_poll_seconds)
            except (ChainUnavailable, OperationalError) as exc:
                log.error("indexer paused: %s (retry in %.0fs)", exc, backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    # ------------------------------------------------------------------ internals

    def _block_time(self, number: int) -> datetime:
        return datetime.fromtimestamp(self.client.block(number)["timestamp"], tz=timezone.utc)

    def _fetch_events(self, session: Session, from_block: int, to_block: int) -> list[DecodedEvent]:
        kinds = {self.registry_address: "registry"}
        events = self._decode(self.client.logs(from_block, to_block, list(kinds)), kinds)
        events.sort(key=lambda e: e.order_key)
        return events

    def _decode(self, logs: list, kinds: dict[str, str]) -> list[DecodedEvent]:
        out = []
        for lg in logs:
            kind = kinds.get(lg["address"].lower())  # also validates the emitting contract address
            if kind is None:
                continue
            ev = self.registry.decode(kind, lg)
            if ev is not None:
                out.append(ev)
        return out

    def _rollback(self, session: Session, head: int) -> int | None:
        """Find the newest stored block still on the canonical chain, drop everything after it and
        rebuild derived tables. Returns the ancestor block number (None = rebuilt from scratch)."""
        rows = session.scalars(
            select(IndexedBlock).where(IndexedBlock.chain_id == self.chain_id).order_by(IndexedBlock.number.desc())
        ).all()
        ancestor = next((r for r in rows if r.number <= head and self.client.block_hash(r.number) == r.hash), None)
        keep = ancestor.number if ancestor else -1
        log.warning("reorg detected: rolling back to block %s", ancestor.number if ancestor else "genesis")

        session.execute(delete(ChainEvent).where(ChainEvent.chain_id == self.chain_id, ChainEvent.block_number > keep))
        session.execute(delete(IndexedBlock).where(IndexedBlock.chain_id == self.chain_id, IndexedBlock.number > keep))
        rebuild_derived(session, self.chain_id)
        if ancestor is None:
            session.execute(delete(IndexerCheckpoint).where(IndexerCheckpoint.chain_id == self.chain_id))
            session.flush()
            return None
        cp = session.get(IndexerCheckpoint, self.chain_id)
        cp.last_block, cp.last_block_hash, cp.updated_at = ancestor.number, ancestor.hash, utcnow()
        session.flush()
        return ancestor.number
