"""Stage 2: data-backed DRAFTS for a human resolver, against a real chain and database.
Weather API responses are mocked (clearly labelled fixtures); everything else is real."""

import copy
import hashlib
from datetime import datetime, timezone

import httpx
from eth_account import Account
from fastapi.testclient import TestClient
from web3 import Web3

from app.api.deps import get_weather_source
from app.data_sources.http import HttpFetcher
from app.data_sources.weather import OpenMeteoSource
from app.main import create_app
from app.services.market_service import keccak_hex
from app.workers.indexer import build_indexer
from tests.data_fixtures import payload
from tests.helpers import login
from tests.test_lifecycle_e2e import CREATOR_KEY, RESOLVER_KEY, market_payload

RULE = {"location": "Chennai", "latitude": "13.0827", "longitude": "80.2707", "start_date": "2026-10-01",
        "end_date": "2026-10-05", "operator": ">", "threshold": "100"}


def test_draft_from_data_to_onchain_resolution(db_clean, chain, monkeypatch):
    now = lambda: datetime.fromtimestamp(chain.now(), tz=timezone.utc)  # noqa: E731
    monkeypatch.setattr("app.services.market_service.utcnow", now)
    monkeypatch.setattr("app.services.resolution_service.utcnow", now)

    current = {"body": payload([50, 30, 20, 10, 2.4])}  # total 112.4 (TEST FIXTURE)
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, text=current["body"])

    weather = OpenMeteoSource(HttpFetcher("open-meteo", min_interval=0, transport=httpx.MockTransport(handler), sleep=lambda s: None))
    app = create_app()
    app.dependency_overrides[get_weather_source] = lambda: weather
    client = TestClient(app)
    idx = build_indexer()
    creator, resolver = Account.from_key(CREATOR_KEY), Account.from_key(RESOLVER_KEY)

    def new_market(with_rule=True, **text_overrides):
        body = market_payload()
        if with_rule:
            body["data_rule"] = copy.deepcopy(RULE)
        body.update(text_overrides)
        client.cookies.clear()
        login(client, creator)
        r = client.post("/markets", json=body)
        assert r.status_code == 201, r.text
        fp = r.json()["factory_params"]
        receipt = chain.send(chain.factory.functions.createMarket(
            (Web3.to_bytes(hexstr=fp["metadataHash"]), fp["category"], fp["tradingClose"], fp["resolutionDeadline"], int(fp["liquidityB"]))), chain.creator)
        return chain.factory.events.MarketCreated().process_receipt(receipt)[0]["args"]

    # --- market definitions are checked
    bad = market_payload()
    bad["data_rule"] = copy.deepcopy(RULE)
    bad["resolution_criteria"] += " Use the IMD station at Nungambakkam for the daily totals."
    client.cookies.clear()
    login(client, creator)
    r = client.post("/markets", json=bad)
    assert r.status_code == 422 and "reanalysis" in r.text  # cannot promise station data and resolve from a model
    wrong_cat = market_payload() | {"category": "economy", "data_rule": copy.deepcopy(RULE)}
    assert client.post("/markets", json=wrong_cat).status_code == 422

    yes_m = new_market(question="Will Chennai exceed 100 mm of rain in the first five days of October 2026?")
    tie_m = new_market(question="Will Chennai exceed 100 mm of rain in 1-5 October 2026 (tie test market)?")
    inc_m = new_market(question="Will Chennai exceed 100 mm of rain in 1-5 October 2026 (incomplete data market)?")
    plain_m = new_market(with_rule=False, question="Will Chennai receive any rain on 1 October 2026 (manual market)?")
    idx.catch_up()
    assert client.get(f"/markets/{yes_m['id']}").json()["data_rule"]["threshold"] == "100"
    assert "NOT ground-station" in client.get(f"/markets/{yes_m['id']}").json()["resolution_data_note"]
    assert client.get(f"/markets/{plain_m['id']}").json()["resolution_data_note"] is None

    # --- drafts need the RESOLVER_ROLE and a closed market
    client.cookies.clear()
    login(client, Account.create())
    assert client.post(f"/resolutions/{yes_m['id']}/draft-from-data").status_code == 403
    client.cookies.clear()
    login(client, resolver)
    early = client.post(f"/resolutions/{yes_m['id']}/draft-from-data")
    assert early.status_code == 409 and "active" in early.json()["detail"] and seen == []  # no data fetched for an open market

    chain.increase_time(3 * 3600)

    # --- YES: 112.4 mm > 100
    d = client.post(f"/resolutions/{yes_m['id']}/draft-from-data")
    assert d.status_code == 200, d.text
    draft = d.json()
    assert draft["requires_human_review"] is True and draft["suggested_outcome"] == "YES"
    ev = draft["evidence"]
    assert ev["normalized_result"] == "112.4" and ev["unit"] == "mm" and ev["observation_period"] == "2026-10-01 to 2026-10-05 inclusive"
    assert "reanalysis" in ev["notes"] and "ERA5" in ev["source_name"]
    raw = client.get(ev["raw_evidence_reference"].replace("http://localhost:8000", "")).text  # exact bytes we received
    assert "0x" + hashlib.sha256(raw.encode()).hexdigest() == ev["raw_evidence_hash"]
    assert client.get(f"/markets/{yes_m['id']}/evidence").json() == []  # a draft stores no evidence and resolves nothing
    assert client.get(f"/markets/{yes_m['id']}").json()["status"] == "closed"

    # the human reviews the draft, prepares evidence from it, then signs the on-chain proposal themselves
    prepared = client.post(f"/resolutions/{yes_m['id']}/propose", json=ev)
    assert prepared.status_code == 201, prepared.text
    p = prepared.json()
    assert p["verdict"] == 0
    chain.send(chain.rm.functions.propose(yes_m["market"], 0, Web3.to_bytes(hexstr=p["evidence_hash"]), p["evidence_uri"]), chain.resolver)
    chain.send(chain.rm.functions.finalize(yes_m["market"]), chain.alice)
    idx.catch_up()
    res = client.get(f"/resolutions/{yes_m['id']}").json()
    assert res["market_status"] == "resolved" and res["winning_outcome"] == "YES" and res["proposals"][0]["evidence_available"]
    stored = client.get(f"/resolutions/{yes_m['id']}/evidence/{p['evidence_hash']}").text
    assert keccak_hex(stored) == p["evidence_hash"]
    assert client.get(f"/markets/{yes_m['id']}/evidence").json()[0]["bundle"]["raw_evidence_hash"] == ev["raw_evidence_hash"]

    # --- exactly on the threshold with ">" is NO, and the draft says to double-check
    current["body"] = payload([50, 30, 20, 0, 0])  # total 100
    tie = client.post(f"/resolutions/{tie_m['id']}/draft-from-data").json()
    assert tie["suggested_outcome"] == "NO" and any("exactly on the threshold" in w for w in tie["warnings"])
    assert any("CHANGED" in w for w in tie["warnings"])  # the provider's numbers for this period moved since the first record

    # --- incomplete data: wait before the resolution deadline, INVALID draft after it
    current["body"] = payload([50, 30, None, None, None])
    wait = client.post(f"/resolutions/{inc_m['id']}/draft-from-data")
    assert wait.status_code == 409 and "not available yet" in wait.json()["detail"]
    chain.increase_time(4 * 86400)
    void = client.post(f"/resolutions/{inc_m['id']}/draft-from-data").json()
    assert void["suggested_outcome"] == "INVALID" and any("INVALID per the missing-data policy" in w for w in void["warnings"])
    assert void["evidence"]["normalized_result"] == "incomplete"

    # --- garbage from the provider is never turned into an outcome
    current["body"] = "<html>maintenance</html>"
    assert client.post(f"/resolutions/{inc_m['id']}/draft-from-data").status_code == 409

    # --- markets without a machine-checkable rule need manual evidence
    r = client.post(f"/resolutions/{plain_m['id']}/draft-from-data")
    assert r.status_code == 422 and "no machine-checkable data_rule" in r.json()["detail"]

    # --- provider outage is reported, not hidden
    def down(request):
        raise httpx.ConnectError("offline")

    app.dependency_overrides[get_weather_source] = lambda: OpenMeteoSource(
        HttpFetcher("open-meteo", min_interval=0, backoff=0, transport=httpx.MockTransport(down), sleep=lambda s: None))
    current["body"] = payload([1] * 5)
    assert client.post(f"/resolutions/{inc_m['id']}/draft-from-data").status_code == 503
