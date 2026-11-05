"""Data worker:  python -m app.workers.data_worker [--once]

Refreshes ONLY the weather data that open markets actually need (their `data_rule`), on a schedule.
No other provider is crawled (see data_sources/manual.py). A Postgres advisory lock stops two worker
instances from running the same cycle. Failures are logged and the cycle continues; nothing is
substituted for data that could not be fetched.
"""

import json
import logging
import sys
from datetime import date, timedelta
from decimal import Decimal

from apscheduler.schedulers.blocking import BlockingScheduler
from sqlalchemy import select, text

from app.core.logging import configure_logging
from app.data_sources.http import SourceRejected, SourceUnavailable
from app.data_sources.weather import DataNotYetAvailable, OpenMeteoSource, WeatherQuery
from app.database.connection import get_engine, new_session
from app.models import Market, MarketMetadata
from app.services.data_ingestion_service import ingest_weather

log = logging.getLogger(__name__)
LOCK_KEY = 7_303_001  # arbitrary app-wide constant for pg_advisory_lock
INTERVAL_HOURS = 6
LOOKBACK_DAYS = 45  # keep refreshing a rule's period until this long after it ended (reanalysis settles)


def active_rules(db) -> list[dict]:
    """Distinct data rules of markets that still need data."""
    rules, seen = [], set()
    rows = db.execute(
        select(Market, MarketMetadata).join(MarketMetadata, MarketMetadata.metadata_hash == Market.metadata_hash).where(Market.status == "active")
    ).all()
    for _, meta in rows:
        rule = json.loads(meta.canonical_json).get("data_rule")
        if not rule or date.fromisoformat(rule["end_date"]) < date.today() - timedelta(days=LOOKBACK_DAYS):
            continue
        key = (rule["location"], rule["latitude"], rule["longitude"], rule["start_date"], rule["end_date"], rule["model"])
        if key not in seen:
            seen.add(key)
            rules.append(rule)
    return rules


def run_cycle(source: OpenMeteoSource | None = None) -> dict:
    source = source or OpenMeteoSource()
    summary = {"rules": 0, "created": 0, "duplicate": 0, "revision": 0, "failed": 0, "not_yet": 0, "skipped_locked": False}
    with get_engine().connect() as lock_conn:  # dedicated connection holds the session-level lock
        if not lock_conn.execute(text("select pg_try_advisory_lock(:k)"), {"k": LOCK_KEY}).scalar():
            summary["skipped_locked"] = True
            log.info("another data worker holds the lock; skipping this cycle")
            return summary
        try:
            db = new_session()
            try:
                for rule in active_rules(db):
                    summary["rules"] += 1
                    q = WeatherQuery(
                        rule["location"], Decimal(rule["latitude"]), Decimal(rule["longitude"]),
                        date.fromisoformat(rule["start_date"]), date.fromisoformat(rule["end_date"]), rule["model"],
                    )
                    try:
                        summary[ingest_weather(db, source, q).outcome] += 1
                    except DataNotYetAvailable:
                        summary["not_yet"] += 1  # the period has not reached the provider's archive yet: normal
                    except (SourceUnavailable, SourceRejected) as exc:
                        summary["failed"] += 1
                        log.error("weather ingestion failed for %s: %s", rule["location"], exc)
            finally:
                db.close()
        finally:
            lock_conn.execute(text("select pg_advisory_unlock(:k)"), {"k": LOCK_KEY})
    log.info("data cycle finished: %s", summary)
    return summary


def main() -> None:
    configure_logging()
    if "--once" in sys.argv:
        run_cycle()
        return
    run_cycle()
    scheduler = BlockingScheduler(timezone="UTC")
    scheduler.add_job(run_cycle, "interval", hours=INTERVAL_HOURS, max_instances=1, coalesce=True)
    scheduler.start()


if __name__ == "__main__":
    main()
