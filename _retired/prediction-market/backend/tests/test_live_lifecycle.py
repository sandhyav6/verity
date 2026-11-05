"""Full lifecycle with REAL source data: real Hardhat node + contracts + PostgreSQL + the real Open-Meteo API.

Marked `live` (needs internet; excluded from the default run):  python -m pytest -m live tests/test_live_lifecycle.py
It asserts structure and consistency, never a specific rainfall value, because the provider's data can change.
"""

import copy
import hashlib
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from eth_account import Account
from fastapi.testclient import TestClient
from web3 import Web3

from app.main import create_app
from app.services.market_service import keccak_hex
from app.workers.indexer import build_indexer
from tests.helpers import login
from tests.test_lifecycle_e2e import CREATOR_KEY, RESOLVER_KEY, market_payload

pytestmark = pytest.mark.live
E18 = 10**18
BIG = 2**64


def test_lifecycle_resolved_from_real_open_meteo_data(db_clean, chain, monkeypatch):
    now = lambda: datetime.fromtimestamp(chain.now(), tz=timezone.utc)  # noqa: E731
    monkeypatch.setattr("app.services.market_service.utcnow", now)
    monkeypatch.setattr("app.services.resolution_service.utcnow", now)

    start, end = date.today() - timedelta(days=60), date.today() - timedelta(days=50)  # a settled period
    app = create_app()  # NOTE: no weather-source override: the real adapter talks to the real API
    client = TestClient(app)
    idx = build_indexer()
    creator, resolver = Account.from_key(CREATOR_KEY), Account.from_key(RESOLVER_KEY)

    body = market_payload()
    body["question"] = f"Will Chennai receive more than 1 mm of rain between {start} and {end} (live-data test)?"
    body["resolution_criteria"] = f"Sum daily precipitation_sum for {start} to {end} from the named dataset; YES if the sum is strictly above 1 mm."
    body["resolution_spec"]["observation_period"] = f"{start} to {end} inclusive"
    body["data_rule"] = {"location": "Chennai", "latitude": "13.0827", "longitude": "80.2707", "start_date": start.isoformat(), "end_date": end.isoformat(),
                         "operator": ">", "threshold": "1"}
    login(client, creator)
    fp = client.post("/markets", json=body).json()["factory_params"]
    receipt = chain.send(chain.factory.functions.createMarket((Web3.to_bytes(hexstr=fp["metadataHash"]), fp["category"], fp["tradingClose"], fp["resolutionDeadline"], int(fp["liquidityB"]))), chain.creator)
    mid = chain.factory.events.MarketCreated().process_receipt(receipt)[0]["args"]["id"]
    market = chain.market(chain.factory.functions.marketById(mid).call())

    for who in (chain.alice, chain.bob):
        chain.send(chain.token.functions.faucet(), who)
    chain.send(market.functions.buy(0, 20 * E18, 10**30, BIG), chain.alice)
    chain.send(market.functions.buy(1, 10 * E18, 10**30, BIG), chain.bob)
    chain.increase_time(3 * 3600)
    idx.catch_up()

    client.cookies.clear()
    login(client, resolver)
    r = client.post(f"/resolutions/{mid}/draft-from-data")  # REAL network call
    assert r.status_code == 200, r.text
    draft = r.json()
    ev = draft["evidence"]
    assert draft["requires_human_review"] and ev["unit"] == "mm" and "reanalysis" in ev["notes"]

    # the stored raw bytes are what the provider sent, and they hash to the evidence's raw hash
    raw = client.get(ev["raw_evidence_reference"].replace("http://localhost:8000", "")).text
    assert "0x" + hashlib.sha256(raw.encode()).hexdigest() == ev["raw_evidence_hash"]
    assert ev["source_url"].startswith("https://archive-api.open-meteo.com/v1/archive?")
    total = Decimal(ev["normalized_result"])
    assert total >= 0 and draft["suggested_outcome"] == ("YES" if total > 1 else "NO")  # the rule, applied to the real value

    # a human reviews, prepares evidence, signs on-chain; the market resolves and winners redeem
    prepared = client.post(f"/resolutions/{mid}/propose", json=ev).json()
    chain.send(chain.rm.functions.propose(market.address, prepared["verdict"], Web3.to_bytes(hexstr=prepared["evidence_hash"]), prepared["evidence_uri"]), chain.resolver)
    chain.send(chain.rm.functions.finalize(market.address), chain.alice)
    idx.catch_up()
    res = client.get(f"/resolutions/{mid}").json()
    assert res["market_status"] == "resolved" and res["winning_outcome"] == draft["suggested_outcome"]
    assert keccak_hex(client.get(f"/resolutions/{mid}/evidence/{prepared['evidence_hash']}").text) == prepared["evidence_hash"]

    winner, loser = (chain.alice, chain.bob) if draft["suggested_outcome"] == "YES" else (chain.bob, chain.alice)
    chain.send(market.functions.redeem(), winner)
    with pytest.raises(Exception):
        market.functions.redeem().call({"from": loser})  # losing shares cannot be redeemed
    # the Data Explorer holds the real record with its provenance
    rec = client.get("/data/weather", params={"limit": 5}).json()["items"][0]
    assert rec["provider"] == "open-meteo" and rec["validation_status"] == "valid" and "CC BY 4.0" in rec["attribution"]
    _ = copy
