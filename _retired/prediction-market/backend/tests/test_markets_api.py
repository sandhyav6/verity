import copy
import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.market_service import canonical_json, keccak_hex
from tests.helpers import login
from tests.test_lifecycle_e2e import market_payload


@pytest.fixture
def client(db_clean):
    with TestClient(create_app()) as c:
        login(c)
        yield c


def test_health_and_disclaimer(client):
    h = client.get("/health").json()
    assert h["status"] == "ok" and h["database"] == "ok" and "no monetary value" in h["disclaimer"]
    assert client.get("/health").headers["x-content-type-options"] == "nosniff"


def test_empty_database_gives_proper_empty_states(client):
    page = client.get("/markets").json()
    assert page == {"items": [], "total": 0, "limit": 20, "offset": 0}
    ov = client.get("/analytics/overview").json()
    assert ov["markets_total"] == 0 and ov["trades_total"] == 0 and ov["total_volume"] == "0" and ov["activity"] == []
    assert client.get("/analytics/categories").json() == []
    assert client.get("/portfolio/0x" + "11" * 20).json()["positions"] == []


def test_valid_market_is_registered_and_hash_is_reproducible(client):
    r = client.post("/markets", json=market_payload())
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["factory_params"]["liquidityB"] == str(100 * 10**18)
    assert body["factory_params"]["category"] == 1  # weather
    # re-submitting identical content yields the identical hash (idempotent)

    # the stored document is exactly the hashed bytes
    from app.database.connection import session_scope
    from app.models import MarketMetadata

    with session_scope() as s:
        row = s.get(MarketMetadata, body["metadata_hash"])
        assert keccak_hex(row.canonical_json) == body["metadata_hash"]
        assert json.loads(row.canonical_json)["question"].endswith("?")
        assert row.canonical_json == canonical_json(json.loads(row.canonical_json))


@pytest.mark.parametrize(
    "mutate, field",
    [
        (lambda p: p.update(question="Rain in Chennai next month"), "question"),                 # not a question
        (lambda p: p.update(question="Rain?"), "question"),                                       # too short / vague
        (lambda p: p.update(category="politics"), "category"),                                    # unsupported
        (lambda p: p.update(liquidity_parameter="5"), "liquidity_parameter"),                     # below minimum b
        (lambda p: p.update(liquidity_parameter="1000000"), "liquidity_parameter"),               # above maximum b
        (lambda p: p.update(liquidity_parameter="12.5"), "liquidity_parameter"),                  # not whole
        (lambda p: p.update(trading_close_time="2020-01-01T00:00:00+00:00"), "trading_close_time"),
        (lambda p: p.update(trading_close_time="2031-01-01T00:00:00"), "trading_close_time"),     # naive timestamp
        (lambda p: p.update(resolution_deadline=p["trading_close_time"]), "resolution_deadline"), # not after close
        (lambda p: p.pop("resolution_criteria"), "resolution_criteria"),                          # missing
        (lambda p: p.update(resolution_criteria="see source"), "resolution_criteria"),            # too thin
        (lambda p: p["resolution_source"].pop("dataset"), "dataset"),                             # missing exact dataset
        (lambda p: p["resolution_source"].update(url="not-a-url"), "url"),
        (lambda p: p["resolution_spec"].pop("revision_policy"), "revision_policy"),               # missing revision policy
        (lambda p: p["resolution_spec"].pop("missing_data_policy"), "missing_data_policy"),
        (lambda p: p.update(no_definition=p["yes_definition"]), "no_definition"),                 # indistinguishable outcomes
    ],
)
def test_ambiguous_or_incomplete_markets_are_rejected(client, mutate, field):
    payload = copy.deepcopy(market_payload())
    mutate(payload)
    r = client.post("/markets", json=payload)
    assert r.status_code == 422, r.text
    assert field in r.text


def test_pagination_and_query_validation(client):
    assert client.get("/markets", params={"limit": 0}).status_code == 422
    assert client.get("/markets", params={"offset": -1}).status_code == 422
    assert client.get("/markets", params={"sort": "price"}).status_code == 422
    assert client.get("/markets", params={"status": "weird"}).status_code == 422
    assert client.get("/markets", params={"q": "x" * 101}).status_code == 422
    # SQL metacharacters in the search box are treated as plain text
    assert client.get("/markets", params={"q": "'; DROP TABLE markets;--"}).json()["total"] == 0
    assert client.get("/markets").status_code == 200  # table still exists


def test_unknown_routes_and_methods_do_not_leak_internals(client):
    assert client.get("/markets/1/history").status_code == 404
    r = client.get("/resolutions/1")
    assert r.status_code == 404 and "Traceback" not in r.text
    assert client.delete("/markets/1").status_code == 405


def test_registering_identical_content_is_idempotent(client):
    payload = market_payload()  # one fixed payload, so identical bytes
    first = client.post("/markets", json=payload).json()["metadata_hash"]
    second = client.post("/markets", json=payload).json()["metadata_hash"]
    assert first == second
    from sqlalchemy import func, select

    from app.database.connection import session_scope
    from app.models import MarketMetadata

    with session_scope() as s:
        assert s.scalar(select(func.count()).select_from(MarketMetadata)) == 1

    changed = copy.deepcopy(payload)
    changed["description"] += " (edited)"
    assert client.post("/markets", json=changed).json()["metadata_hash"] != first


def test_rate_limit_applies_to_auth_endpoints(db_clean):
    from app.api.deps import limiter

    limiter.enabled = True
    limiter.reset()
    try:
        with TestClient(create_app()) as c:
            codes = [c.get("/auth/nonce").status_code for _ in range(12)]
        assert codes[:10] == [200] * 10 and 429 in codes[10:]
    finally:
        limiter.enabled = False
        limiter.reset()


def test_public_config_exposes_addresses_but_never_the_backends_private_rpc_url(db_clean):
    from app.core.config import Settings, get_settings

    app = create_app()
    base = get_settings()
    app.dependency_overrides[get_settings] = lambda: Settings(
        **{**base.model_dump(), "rpc_url": "https://node.example/v2/SECRET-PROVIDER-KEY", "public_rpc_url": "https://public.example/rpc",
           "factory_address": "0x" + "1" * 40, "token_address": "0x" + "2" * 40, "resolution_manager_address": "0x" + "3" * 40}
    )
    body = TestClient(app).get("/config").json()
    assert body["rpc_url"] == "https://public.example/rpc"
    assert body["factory_address"] == "0x" + "1" * 40 and body["chain_id"] == 31337
    assert "SECRET-PROVIDER-KEY" not in json.dumps(body)
    assert "no monetary value" in body["notice"]
    assert set(body) == {"chain_id", "chain_name", "rpc_url", "explorer_tx_url", "factory_address", "token_address",
                         "resolution_manager_address", "indexer_confirmations", "siwe_domain", "notice"}


def test_trades_feed_is_empty_and_validated(client):
    assert client.get("/trades").json() == {"items": [], "total": 0, "limit": 20, "offset": 0}
    assert client.get("/trades", params={"wallet": "0x" + "11" * 20}).json()["total"] == 0
    assert client.get("/trades", params={"wallet": "nope"}).status_code == 422
    assert client.get("/trades", params={"limit": 101}).status_code == 422
    assert client.get("/trades", params={"market_id": 0}).status_code == 422


def test_chain_clock_follows_block_time_only_when_asked_and_never_breaks_the_api(monkeypatch):
    from datetime import datetime, timezone

    from app.core import clock
    from app.core.config import Settings

    class FakeClient:
        def __init__(self, ts=None):
            self.ts = ts

        def block(self, _):
            if self.ts is None:
                raise ConnectionError("node down")
            return {"timestamp": self.ts}

    wall = lambda: Settings(clock_source="wall")  # noqa: E731
    chainmode = lambda: Settings(clock_source="chain")  # noqa: E731
    monkeypatch.setattr(clock, "_cache", None)

    monkeypatch.setattr(clock, "get_settings", wall)
    assert abs((clock.utcnow() - datetime.now(timezone.utc)).total_seconds()) < 5  # default: wall clock

    monkeypatch.setattr(clock, "get_settings", chainmode)
    monkeypatch.setattr("app.api.deps.get_chain", lambda s: FakeClient(ts=2_000_000_000))
    assert clock.utcnow() == datetime.fromtimestamp(2_000_000_000, tz=timezone.utc)  # block time

    monkeypatch.setattr(clock, "_cache", None)
    monkeypatch.setattr("app.api.deps.get_chain", lambda s: FakeClient(ts=None))
    assert abs((clock.utcnow() - datetime.now(timezone.utc)).total_seconds()) < 5  # node down: falls back to wall clock
