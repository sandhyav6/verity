import hashlib
import json
from datetime import date, datetime, timedelta, timezone

import httpx
import pytest
from eth_account import Account
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text

from app.core.config import Settings, get_settings
from app.api.deps import get_weather_source
from app.database.connection import get_engine, session_scope
from app.main import create_app
from app.models import ExternalData, Market, MarketMetadata
from app.workers import data_worker
from tests.data_fixtures import ok, payload, source_returning
from tests.helpers import login

ADMIN = Account.create()
NOW = datetime.now(timezone.utc)
SHA = hashlib.sha256(b"archived RBI press release (test fixture)").hexdigest()
WEATHER_BODY = {"location": "Chennai", "latitude": "13.0827", "longitude": "80.2707", "start_date": "2026-10-01", "end_date": "2026-10-05"}


def make_client(source=None, admin=ADMIN):
    app = create_app()
    base = get_settings()
    app.dependency_overrides[get_settings] = lambda: Settings(**{**base.model_dump(), "admin_addresses": [admin.address]})
    if source is not None:
        app.dependency_overrides[get_weather_source] = lambda: source
    return TestClient(app)


def manual(**over):
    body = {
        "provider": "rbi", "metric": "policy_repo_rate", "source_url": "https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=00000",
        "document_sha256": SHA, "retrieved_at": (NOW - timedelta(hours=1)).isoformat(), "observed_at": (NOW - timedelta(days=20)).isoformat(),
        "publication_date": (NOW - timedelta(days=20)).date().isoformat(), "period_start": (NOW - timedelta(days=60)).date().isoformat(),
        "period_end": (NOW - timedelta(days=30)).date().isoformat(), "value": "5.50", "notes": "TEST FIXTURE value",
    }
    body.update(over)
    return body


# ---------------------------------------------------------------- storage semantics


def test_duplicates_revisions_and_reverts_never_overwrite_history(db_clean):
    src_a = payload([1.0] * 5)
    src_b = payload([1.0, 1.0, 1.0, 1.0, 9.0])
    client = make_client(source_returning(ok(src_a)))
    login(client, ADMIN)

    first = client.post("/data/weather/refresh", json=WEATHER_BODY).json()
    again = client.post("/data/weather/refresh", json=WEATHER_BODY).json()
    assert first["outcome"] == "created" and again["outcome"] == "duplicate"
    assert again["record"]["id"] == first["record"]["id"]

    client.app.dependency_overrides[get_weather_source] = lambda: source_returning(ok(src_b))
    revised = client.post("/data/weather/refresh", json=WEATHER_BODY).json()
    assert revised["outcome"] == "revision" and revised["record"]["supersedes_id"] == first["record"]["id"]
    assert revised["record"]["value"] == "13.0000000000"

    client.app.dependency_overrides[get_weather_source] = lambda: source_returning(ok(src_a))  # provider reverts
    reverted = client.post("/data/weather/refresh", json=WEATHER_BODY).json()
    assert reverted["outcome"] == "revision" and reverted["record"]["id"] not in (first["record"]["id"], revised["record"]["id"])

    chain = client.get(f"/data/records/{first['record']['id']}/revisions").json()
    assert [r["value"] for r in chain] == ["5.0000000000", "13.0000000000", "5.0000000000"]  # original value preserved
    assert [r["is_latest"] for r in chain] == [False, False, True]
    assert chain[0]["supersedes_id"] is None

    listing = client.get("/data/weather").json()
    assert listing["total"] == 1 and listing["items"][0]["id"] == reverted["record"]["id"]  # latest only by default
    assert client.get("/data/weather", params={"latest_only": "false"}).json()["total"] == 3


def test_weather_record_exposes_provenance_and_raw_bytes_verify(db_clean):
    body = payload([2.5, 0.0, 0.0, 10.0, 0.0])
    client = make_client(source_returning(ok(body)))
    login(client, ADMIN)
    rec = client.post("/data/weather/refresh", json=WEATHER_BODY).json()["record"]

    assert rec["is_external_data"] is True and rec["category"] == "weather" and rec["provider"] == "open-meteo"
    assert rec["validation_status"] == "valid" and float(rec["value"]) == 12.5 and rec["unit"] == "mm"
    assert rec["source_url"].startswith("https://archive-api.open-meteo.com/v1/archive?") and "models=era5" in rec["source_url"]
    assert rec["freshness"]["state"] == "fresh" and rec["entered_manually"] is False
    assert (rec["grid_latitude"], rec["grid_longitude"]) == ("13.00000", "80.25000")
    assert "Open-Meteo.com" in rec["attribution"] and "not station observations" in rec["transformation"]
    raw = client.get(rec["raw_payload_reference"]).text
    assert hashlib.sha256(raw.encode()).hexdigest() == rec["raw_payload_hash"] and raw == body


def test_provider_failure_stores_nothing_and_substitutes_nothing(db_clean):
    login_client = make_client(source_returning(httpx.ConnectError("down")))
    login(login_client, ADMIN)
    r = login_client.post("/data/weather/refresh", json=WEATHER_BODY)
    assert r.status_code == 503
    login_client.app.dependency_overrides[get_weather_source] = lambda: source_returning(httpx.Response(400, text="no"))
    assert login_client.post("/data/weather/refresh", json=WEATHER_BODY).status_code == 502
    with session_scope() as s:
        assert s.scalar(select(func.count()).select_from(ExternalData)) == 0


def test_incomplete_and_invalid_records_are_stored_but_labelled(db_clean):
    client = make_client(source_returning(ok(payload([3.0, None, None, None, None]))))
    login(client, ADMIN)
    rec = client.post("/data/weather/refresh", json=WEATHER_BODY).json()["record"]
    assert rec["validation_status"] == "incomplete" and rec["value"] is None
    client.app.dependency_overrides[get_weather_source] = lambda: source_returning(ok("garbage"))
    body = {**WEATHER_BODY, "end_date": "2026-10-04"}
    assert client.post("/data/weather/refresh", json=body).json()["record"]["validation_status"] == "invalid"
    assert client.get("/data/weather", params={"validation_status": "incomplete"}).json()["total"] == 1


def test_freshness_turns_stale(db_clean):
    client = make_client(source_returning(ok(payload([1.0] * 5))))
    login(client, ADMIN)
    rid = client.post("/data/weather/refresh", json=WEATHER_BODY).json()["record"]["id"]
    with get_engine().begin() as c:
        c.execute(text("update external_data set last_seen_at = now() - interval '3 days' where id = :i"), {"i": rid})
    assert client.get(f"/data/records/{rid}").json()["freshness"]["state"] == "stale"
    assert client.get("/data/sources").json()  # status page still renders


# ---------------------------------------------------------------- access control


def test_only_admins_can_write_external_data(db_clean):
    client = make_client(source_returning(ok(payload([1.0] * 5))))
    assert client.post("/data/weather/refresh", json=WEATHER_BODY).status_code == 401
    assert client.post("/data/submissions", json=manual()).status_code == 401
    login(client, Account.create())  # a signed-in non-admin
    assert client.post("/data/weather/refresh", json=WEATHER_BODY).status_code == 403
    assert client.post("/data/submissions", json=manual()).status_code == 403
    assert client.get("/data/weather").status_code == 200  # reading is public


def test_weather_refresh_validates_input(db_clean):
    client = make_client(source_returning(ok(payload([1.0] * 5))))
    login(client, ADMIN)
    assert client.post("/data/weather/refresh", json={**WEATHER_BODY, "latitude": "95"}).status_code == 422
    assert client.post("/data/weather/refresh", json={**WEATHER_BODY, "end_date": "2026-09-01"}).status_code == 422
    assert client.post("/data/weather/refresh", json={**WEATHER_BODY, "model": "gfs"}).status_code == 422


# ---------------------------------------------------------------- manual (non-crawled) sources


def test_manual_submission_is_stored_and_labelled_as_human_entered(db_clean):
    client = make_client()
    login(client, ADMIN)
    r = client.post("/data/submissions", json=manual())
    assert r.status_code == 201, r.text
    rec = r.json()["record"]
    assert rec["validation_status"] == "manual_submitted" and rec["entered_manually"] is True
    assert rec["submitted_by"] == ADMIN.address.lower() and float(rec["value"]) == 5.5 and rec["unit"] == "%"
    assert rec["freshness"]["state"] == "manual" and rec["raw_payload_hash"] == SHA
    assert "NOT fetched or verified" in " ".join(rec["validation_notes"])
    assert rec["dataset_version"].startswith("published ")

    eco = client.get("/data/economic").json()
    assert eco["total"] == 1 and eco["items"][0]["provider"] == "rbi"
    assert client.get("/data/sports").json()["total"] == 0 and client.get("/data/technology").json()["total"] == 0
    assert client.post("/data/submissions", json=manual()).json()["outcome"] == "duplicate"
    other = hashlib.sha256(b"revised document").hexdigest()
    assert client.post("/data/submissions", json=manual(document_sha256=other, value="5.25")).json()["outcome"] == "revision"


@pytest.mark.parametrize(
    "over, fragment",
    [
        ({"source_url": "http://www.rbi.org.in/x"}, "https URL"),                      # not https
        ({"source_url": "https://evil.example/rbi.org.in"}, "https URL"),              # wrong host
        ({"source_url": "https://rbi.org.in.evil.example/x"}, "https URL"),            # lookalike host
        ({"document_sha256": "abc"}, None),                                            # schema rejects (422)
        ({"value": "55"}, "outside plausible range"),                                  # repo rate of 55 %
        ({"value": None}, "value is required"),
        ({"publication_date": None}, "publication_date is required"),
        ({"publication_date": (NOW + timedelta(days=3)).date().isoformat()}, "in the future"),
        ({"retrieved_at": (NOW + timedelta(days=1)).isoformat()}, "retrieved_at is in the future"),
        ({"metric": "made_up_metric"}, "not supported"),
        ({"provider": "mospi", "metric": "cpi_inflation_yoy", "value": "4.2"}, "https URL"),  # RBI url for MoSPI data
        ({"period_end": "2020-01-01"}, "before period_start"),
    ],
)
def test_manual_submissions_are_validated(db_clean, over, fragment):
    client = make_client()
    login(client, ADMIN)
    r = client.post("/data/submissions", json=manual(**over))
    assert r.status_code == 422, r.text
    if fragment:
        assert fragment in r.text


def test_publication_cannot_precede_the_period_it_reports(db_clean):
    """A period ending does not mean the figure has been published, and a figure cannot predate its period."""
    client = make_client()
    login(client, ADMIN)
    bad = manual(publication_date=(NOW - timedelta(days=45)).date().isoformat(), period_end=(NOW - timedelta(days=30)).date().isoformat())
    r = client.post("/data/submissions", json=bad)
    assert r.status_code == 422 and "before the end of the period" in r.text


def test_textual_milestones_for_isro_and_cricket(db_clean):
    client = make_client()
    login(client, ADMIN)
    isro = manual(provider="isro", metric="mission_milestone", source_url="https://www.isro.gov.in/Mission_Example.html",
                  value=None, text="Launch completed (test fixture)", period_start=None, period_end=None)
    r = client.post("/data/submissions", json=isro)
    assert r.status_code == 201 and r.json()["record"]["text"].startswith("Launch completed")
    assert client.get("/data/technology").json()["total"] == 1
    missing = client.post("/data/submissions", json={**isro, "text": None, "document_sha256": hashlib.sha256(b"x").hexdigest()})
    assert missing.status_code == 422
    cricket = manual(provider="bcci", metric="match_result", source_url="https://www.bcci.tv/matches/1", value=None,
                     text="India won by 5 wickets (test fixture)", publication_date=None, period_start=None, period_end=None)
    assert client.post("/data/submissions", json=cricket).status_code == 201
    assert client.get("/data/sports").json()["items"][0]["provider"] == "bcci"


def test_source_catalog_is_honest_about_what_is_automated(db_clean):
    client = make_client()
    by_provider = {s["provider"]: s for s in client.get("/data/sources").json()}
    assert by_provider["open-meteo"]["mode"] == "automated"
    for p in ("rbi", "mospi", "isro", "bcci", "espncricinfo"):
        assert by_provider[p]["mode"] == "manual submission" and by_provider[p]["freshness"] == "no data"
    assert "Reanalysis" in by_provider["open-meteo"]["terms_note"] and "non-commercial" in by_provider["open-meteo"]["terms_note"]


def test_external_data_never_leaks_into_blockchain_analytics(db_clean):
    client = make_client(source_returning(ok(payload([1.0] * 5))))
    login(client, ADMIN)
    client.post("/data/weather/refresh", json=WEATHER_BODY)
    client.post("/data/submissions", json=manual())
    ov = client.get("/analytics/overview").json()
    assert ov["trades_total"] == 0 and ov["markets_total"] == 0 and ov["total_volume"] == "0"


# ---------------------------------------------------------------- worker


def add_weather_market(rule_end=date.today() + timedelta(days=5)):
    """TEST FIXTURE rows (a market + its metadata) so the worker has something to refresh."""
    rule = {"provider": "open-meteo", "model": "era5", "variable": "precipitation_sum", "aggregation": "sum", "location": "Chennai",
            "latitude": "13.0827", "longitude": "80.2707", "start_date": (rule_end - timedelta(days=4)).isoformat(),
            "end_date": rule_end.isoformat(), "operator": ">", "threshold": "100", "unit": "mm"}
    doc = json.dumps({"question": "Test?", "data_rule": rule}, sort_keys=True, separators=(",", ":"))
    h = "0x" + hashlib.sha256(doc.encode()).hexdigest()
    with session_scope() as s:
        s.add(MarketMetadata(metadata_hash=h, canonical_json=doc, created_by="0x" + "0" * 40))
        s.add(Market(chain_id=31337, contract_address="0x" + "1" * 40, blockchain_market_id=1, metadata_hash=h, category="weather",
                     created_by="0x" + "0" * 40, liquidity_parameter=100 * 10**18, trading_close_time=NOW + timedelta(days=1),
                     resolution_deadline=NOW + timedelta(days=9), created_block=1, created_at=NOW, status="active"))
    return rule


def test_worker_refreshes_only_what_markets_need_and_survives_failures(db_clean):
    assert data_worker.run_cycle(source_returning(ok(payload([1.0] * 5)))) ["rules"] == 0  # no markets, no requests
    rule = add_weather_market()
    start = date.fromisoformat(rule["start_date"])

    calls = []
    summary = data_worker.run_cycle(source_returning(ok(payload([1.0] * 5, start=start)), calls=calls))
    assert (summary["rules"], summary["created"], summary["failed"]) == (1, 1, 0) and len(calls) == 1
    assert data_worker.run_cycle(source_returning(ok(payload([1.0] * 5, start=start))))["duplicate"] == 1
    assert data_worker.run_cycle(source_returning(ok(payload([1.0, 1.0, 1.0, 1.0, 7.0], start=start))))["revision"] == 1
    failed = data_worker.run_cycle(source_returning(httpx.ConnectTimeout("x")))
    assert failed["failed"] == 1  # logged, not raised

    with session_scope() as s:
        assert s.scalar(select(func.count()).select_from(ExternalData)) == 2  # original + revision, nothing invented by the failure


def test_worker_skips_when_another_instance_holds_the_lock(db_clean):
    add_weather_market()
    with get_engine().connect() as other:
        assert other.execute(text("select pg_try_advisory_lock(:k)"), {"k": data_worker.LOCK_KEY}).scalar()
        calls = []
        summary = data_worker.run_cycle(source_returning(ok(payload([1.0] * 5)), calls=calls))
        other.execute(text("select pg_advisory_unlock(:k)"), {"k": data_worker.LOCK_KEY})
    assert summary["skipped_locked"] is True and calls == []


def test_worker_ignores_old_and_resolved_markets(db_clean):
    add_weather_market(rule_end=date.today() - timedelta(days=200))  # long settled
    assert data_worker.run_cycle(source_returning(ok(payload([1.0] * 5))))["rules"] == 0
