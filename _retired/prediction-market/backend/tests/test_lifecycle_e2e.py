"""End-to-end lifecycle: wallet login -> market metadata -> on-chain creation -> trades -> indexer ->
API -> close -> evidence -> resolution -> redemption -> portfolio/analytics.

Real Hardhat node, real contracts, real PostgreSQL, real SIWE signatures. The only thing not covered
here is "retrieve real-world source data" (Phase 3), so the evidence fixture below is a clearly
labelled TEST fixture, not data from a real provider.
"""

from datetime import datetime, timedelta, timezone

import pytest
from eth_account import Account
from fastapi.testclient import TestClient
from web3 import Web3

from app.main import create_app
from app.services.market_service import keccak_hex
from app.workers.indexer import build_indexer
from tests.helpers import login

E18 = 10**18
BIG = 2**64
# Well-known PUBLIC Hardhat development keys for accounts #1 and #2 (local test chain only).
CREATOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
RESOLVER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"


def market_payload(close_in_hours=2):
    now = datetime.now(timezone.utc)
    return {
        "question": "Will Chennai receive more than 100 mm of rainfall between 1 and 30 November?",
        "description": "TEST market used by the automated lifecycle test; not a real forecast.",
        "category": "weather",
        "yes_definition": "Total rainfall for the period exceeds 100 mm.",
        "no_definition": "Total rainfall for the period is 100 mm or less.",
        "resolution_source": {"name": "Open-Meteo Historical Weather API", "url": "https://open-meteo.com/en/docs/historical-weather-api", "dataset": "daily precipitation_sum at 13.08N 80.27E"},
        "resolution_criteria": "Sum daily precipitation_sum for 1-30 November from the named dataset; YES if the sum is strictly above 100 mm.",
        "resolution_spec": {
            "measurement": "Total of daily precipitation_sum",
            "unit": "mm",
            "observation_period": "1 November to 30 November inclusive",
            "revision_policy": "The value first published after 30 November is authoritative.",
            "missing_data_policy": "If any day is missing the market is voided (INVALID) after the deadline.",
        },
        "trading_close_time": (now + timedelta(hours=close_in_hours)).isoformat(),
        "resolution_deadline": (now + timedelta(days=3)).isoformat(),
        "liquidity_parameter": "100",
    }


def test_full_lifecycle(db_clean, chain, monkeypatch):
    # The API derives "closed" from the clock; point it at the (time-travelling) test chain.
    monkeypatch.setattr("app.services.market_service.utcnow", lambda: datetime.fromtimestamp(chain.now(), tz=timezone.utc))

    app_client = TestClient(create_app())
    idx = build_indexer()
    creator, resolver = Account.from_key(CREATOR_KEY), Account.from_key(RESOLVER_KEY)
    assert creator.address == chain.creator and resolver.address == chain.resolver  # deployment roles

    # --- 1-3. A creator signs in, registers the market definition, and creates it on-chain
    _, r = login(app_client, creator)
    assert r.status_code == 200
    r = app_client.post("/markets", json=market_payload())
    assert r.status_code == 201, r.text
    created = r.json()
    fp = created["factory_params"]
    assert fp["metadataHash"] == created["metadata_hash"] and fp["category"] == 1

    receipt = chain.send(
        chain.factory.functions.createMarket(
            (Web3.to_bytes(hexstr=fp["metadataHash"]), fp["category"], fp["tradingClose"], fp["resolutionDeadline"], int(fp["liquidityB"]))
        ),
        chain.creator,
    )
    market_id = chain.factory.events.MarketCreated().process_receipt(receipt)[0]["args"]["id"]
    market_addr = chain.factory.functions.marketById(market_id).call()

    # --- 4-5. Traders obtain test tokens from the faucet
    for who in (chain.alice, chain.bob):
        chain.send(chain.token.functions.faucet(), who)
        assert chain.token.functions.balanceOf(who).call() == 1000 * E18
    start_balance = {w: chain.token.functions.balanceOf(w).call() for w in (chain.alice, chain.bob)}

    idx.catch_up()
    m = app_client.get(f"/markets/{market_id}").json()
    assert m["status"] == "active" and m["metadata_verified"] is True
    assert m["question"].startswith("Will Chennai") and float(m["yes_price"]) == 0.5

    # --- 6-9. Alice buys YES, Bob buys NO; the LMSR price moves with each trade
    market = chain.market(market_addr)
    p0 = market.functions.priceYes().call()
    cost_a = market.functions.quoteBuy(0, 60 * E18).call()
    chain.send(market.functions.buy(0, 60 * E18, cost_a, BIG), chain.alice)
    p1 = market.functions.priceYes().call()
    cost_b = market.functions.quoteBuy(1, 20 * E18).call()
    chain.send(market.functions.buy(1, 20 * E18, cost_b, BIG), chain.bob)
    p2 = market.functions.priceYes().call()
    assert p1 > p0 and p2 < p1

    # --- 10-11. The indexer processes the events; both trades are in the database and API
    idx.catch_up()
    trades = app_client.get(f"/markets/{market_id}/trades").json()
    assert trades["total"] == 2
    by_wallet = {t["wallet_address"]: t for t in trades["items"]}
    assert by_wallet[chain.alice.lower()]["token_amount"] == str(cost_a) and by_wallet[chain.alice.lower()]["outcome"] == "YES"
    assert by_wallet[chain.bob.lower()]["token_amount"] == str(cost_b)
    assert 0 < float(by_wallet[chain.alice.lower()]["execution_price"]) < 1
    history = app_client.get(f"/markets/{market_id}/history").json()["items"]
    assert [int(float(h["yes_price"]) * 1e9) for h in history] == pytest.approx([int(p1 / 1e9), int(p2 / 1e9)], abs=1)
    m = app_client.get(f"/markets/{market_id}").json()
    assert int(float(m["yes_price"]) * 1e9) == pytest.approx(int(p2 / 1e9), abs=1)
    assert m["trade_count"] == 2 and m["volume"] == str(cost_a + cost_b)

    # transaction status endpoint: success, confirmed and indexed
    tx = app_client.get(f"/transactions/{trades['items'][0]['transaction_hash']}").json()
    assert tx["status"] == "success" and tx["indexed"] is True and "SharesPurchased" in tx["indexed_events"]
    assert app_client.get("/transactions/0x" + "00" * 32).json()["status"] == "not_found"
    assert app_client.get("/transactions/not-a-hash").status_code == 422

    # --- evidence cannot be prepared before trading closes
    app_client.cookies.clear()
    login(app_client, resolver)
    evidence = {
        "proposed_outcome": "YES", "source_name": "Open-Meteo Historical Weather API (TEST FIXTURE)",
        "source_url": "https://open-meteo.com/en/docs/historical-weather-api",
        "evidence_retrieved_at": datetime.now(timezone.utc).isoformat(),
        "observation_period": "1 November to 30 November inclusive",
        "raw_evidence_reference": "test-fixture://rainfall/chennai/2026-11.json",
        "raw_evidence_hash": "0x" + "ab" * 32, "normalized_result": "112.4", "unit": "mm",
    }
    early = app_client.post(f"/resolutions/{market_id}/propose", json=evidence)
    assert early.status_code == 409, "market is still open for trading"

    # --- 12. Close the market (time passes); the API now reports it as closed
    chain.increase_time(3 * 3600)
    assert app_client.get(f"/markets/{market_id}").json()["status"] == "closed"
    with pytest.raises(Exception, match="0xe2c865df"):  # TradingClosed() custom error from the contract
        market.functions.buy(0, E18, BIG * E18, BIG).call({"from": chain.alice})

    # --- 13-15. Evidence -> hash -> on-chain proposal -> finalize. Only a RESOLVER_ROLE wallet may prepare it
    app_client.cookies.clear()
    login(app_client, Account.from_key("0x" + "11" * 32))
    assert app_client.post(f"/resolutions/{market_id}/propose", json=evidence).status_code == 403
    app_client.cookies.clear()
    login(app_client, resolver)
    prepared = app_client.post(f"/resolutions/{market_id}/propose", json=evidence)
    assert prepared.status_code == 201, prepared.text
    prepared = prepared.json()
    assert prepared["verdict"] == 0 and prepared["market_address"] == market_addr.lower()

    # the stored document hashes to the advertised evidence hash (anyone can verify)
    doc = app_client.get(f"/resolutions/{market_id}/evidence/{prepared['evidence_hash']}").text
    assert keccak_hex(doc) == prepared["evidence_hash"]

    chain.send(
        chain.rm.functions.propose(market_addr, 0, Web3.to_bytes(hexstr=prepared["evidence_hash"]), prepared["evidence_uri"]),
        chain.resolver,
    )
    chain.send(chain.rm.functions.finalize(market_addr), chain.alice)  # permissionless once the window passed
    idx.catch_up()

    res = app_client.get(f"/resolutions/{market_id}").json()
    assert res["market_status"] == "resolved" and res["winning_outcome"] == "YES"
    p = res["proposals"][0]
    assert p["state"] == "finalized" and p["final_outcome"] == "YES" and p["evidence_available"] is True
    assert p["resolver_address"] == chain.resolver.lower() and p["dispute_status"] == "none"
    ev = app_client.get(f"/markets/{market_id}/evidence").json()
    assert len(ev) == 1 and ev[0]["hash_verified"] is True and ev[0]["bundle"]["normalized_result"] == "112.4"
    late = app_client.post(f"/resolutions/{market_id}/dispute", json=evidence)  # a settled market cannot be disputed
    assert late.status_code == 409

    # --- 16-18. Winner redeems; the loser cannot; on-chain balances are exactly as expected
    chain.send(market.functions.redeem(), chain.alice)
    with pytest.raises(Exception):
        market.functions.redeem().call({"from": chain.bob})  # losing NO shares: NothingToRedeem
    with pytest.raises(Exception):
        market.functions.redeem().call({"from": chain.alice})  # double redemption: NothingToRedeem
    assert chain.token.functions.balanceOf(chain.alice).call() == start_balance[chain.alice] - cost_a + 60 * E18
    assert chain.token.functions.balanceOf(chain.bob).call() == start_balance[chain.bob] - cost_b

    # --- 19. Portfolio and analytics reflect it (all from indexed records, checked against the chain)
    idx.catch_up()
    pf = app_client.get(f"/portfolio/{chain.alice}").json()
    assert pf["token_balance"] == str(chain.token.functions.balanceOf(chain.alice).call())
    pos = pf["positions"][0]
    assert pos["yes_shares"] == "0" and int(pos["realized_pnl"]) == 60 * E18 - cost_a  # profit from the winning side
    pf_bob = app_client.get(f"/portfolio/{chain.bob}").json()
    assert int(pf_bob["positions"][0]["no_shares"]) == 20 * E18 and pf_bob["positions"][0]["redeemable_amount"] == "0"
    hist = app_client.get(f"/portfolio/{chain.alice}/history").json()
    assert len(hist) == 1 and hist[0]["cumulative_net_spent"] == str(cost_a)

    ov = app_client.get("/analytics/overview").json()
    assert ov["markets_by_status"]["resolved"] == 1 and ov["trades_total"] == 2 and ov["unique_traders"] == 2
    assert ov["total_volume"] == str(cost_a + cost_b) and ov["last_indexed_block"] is not None
    cats = app_client.get("/analytics/categories").json()
    assert cats == [{"category": "weather", "markets": 1, "trades": 2, "volume": str(cost_a + cost_b)}]
    assert app_client.get("/analytics/markets").json()[0]["unique_traders"] == 2

    # the creator can recover the unspent subsidy; DB collateral still matches the chain
    chain.send(market.functions.claimResidual(), chain.creator)
    idx.catch_up()
    from app.blockchain.reconcile import reconcile
    from app.database.connection import session_scope

    with session_scope() as s:
        assert reconcile(s, idx.client, 31337) == []

    # trades feed: newest first, filterable by wallet and market, with the market's question attached
    feed = app_client.get("/trades").json()
    assert feed["total"] == 2 and {t["wallet_address"] for t in feed["items"]} == {chain.alice.lower(), chain.bob.lower()}
    assert feed["items"][0]["market_question"].startswith("Will Chennai") and feed["items"][0]["block_number"] >= feed["items"][1]["block_number"]
    mine = app_client.get("/trades", params={"wallet": chain.alice.upper().replace("0X", "0x")}).json()
    assert mine["total"] == 1 and mine["items"][0]["outcome"] == "YES"
    assert app_client.get("/trades", params={"market_id": market_id}).json()["total"] == 2
    assert app_client.get("/trades", params={"market_id": 999}).json()["total"] == 0
    assert "server_time" in app_client.get(f"/resolutions/{market_id}").json()

    # list endpoint: filters, search, sort, pagination
    listing = app_client.get("/markets", params={"status": "resolved", "category": "weather", "q": "chennai", "limit": 1}).json()
    assert listing["total"] == 1 and listing["items"][0]["id"] == market_id
    assert app_client.get("/markets", params={"status": "active"}).json()["total"] == 0
    assert app_client.get("/markets", params={"q": "nothing-matches-this"}).json()["total"] == 0
    assert app_client.get("/markets", params={"limit": 1000}).status_code == 422
    assert app_client.get("/markets/99999").status_code == 404
    assert app_client.get("/portfolio/not-an-address").status_code == 422
