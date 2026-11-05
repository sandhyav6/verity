"""Stage 3 (bonded proposals, disputes, arbiter) end to end: real chain, real contracts, real PostgreSQL,
real SIWE sessions. Nothing is mocked except the clock used for derived market status."""

from datetime import datetime, timezone

import pytest
from eth_account import Account
from fastapi.testclient import TestClient
from web3 import Web3

from app.blockchain.reconcile import reconcile
from app.database.connection import session_scope
from app.main import create_app
from app.services.market_service import keccak_hex
from app.workers.indexer import build_indexer
from tests.helpers import login
from tests.test_lifecycle_e2e import CREATOR_KEY, market_payload

E18 = 10**18
BIG = 2**64
MNEMONIC = "test test test test test test test test test test test junk"  # public Hardhat development mnemonic
Account.enable_unaudited_hdwallet_features()


def hd(i: int):
    return Account.from_mnemonic(MNEMONIC, account_path=f"m/44'/60'/0'/0/{i}")


def evidence(outcome: str, tag: str) -> dict:
    return {
        "proposed_outcome": outcome, "source_name": f"Open-Meteo Historical Weather API (TEST FIXTURE {tag})",
        "source_url": "https://open-meteo.com/en/docs/historical-weather-api",
        "evidence_retrieved_at": datetime.now(timezone.utc).isoformat(), "observation_period": "1 October to 5 October 2026 inclusive",
        "raw_evidence_reference": f"test-fixture://{tag}.json", "raw_evidence_hash": "0x" + "cd" * 32,
        "normalized_result": "112.4" if outcome == "YES" else "88.0", "unit": "mm", "notes": f"{tag}; not real data.",
    }


class World:
    """A system with one traded, closed market and signed-in clients for each role."""

    def __init__(self, chain, monkeypatch):
        self.chain = chain
        now = lambda: datetime.fromtimestamp(chain.now(), tz=timezone.utc)  # noqa: E731
        monkeypatch.setattr("app.services.market_service.utcnow", now)
        monkeypatch.setattr("app.services.resolution_service.utcnow", now)
        self.app = create_app()
        self.idx = build_indexer()
        self.proposer, self.disputer, self.arbiter = hd(7), hd(5), hd(6)
        assert (self.proposer.address, self.disputer.address, self.arbiter.address) == (chain.proposer, chain.carol, chain.arbiter)

    def client(self, account) -> TestClient:
        c = TestClient(self.app)
        _, r = login(c, account)
        assert r.status_code == 200, r.text
        return c

    def new_market(self, close_in_hours=2):
        chain = self.chain
        for who in (chain.alice, chain.bob, chain.proposer, chain.carol):
            chain.send(chain.token.functions.adminMint(who, 1000 * E18), chain.admin)
        creator = self.client(Account.from_key(CREATOR_KEY))
        body = market_payload(close_in_hours)
        # times relative to the CHAIN's clock (earlier tests advanced it past the wall clock)
        body["trading_close_time"] = datetime.fromtimestamp(chain.now() + close_in_hours * 3600, tz=timezone.utc).isoformat()
        body["resolution_deadline"] = datetime.fromtimestamp(chain.now() + 30 * 86400, tz=timezone.utc).isoformat()
        r = creator.post("/markets", json=body)
        assert r.status_code == 201, r.text
        fp = r.json()["factory_params"]
        receipt = chain.send(chain.factory.functions.createMarket(
            (Web3.to_bytes(hexstr=fp["metadataHash"]), fp["category"], fp["tradingClose"], fp["resolutionDeadline"], int(fp["liquidityB"]))), chain.creator)
        args = chain.factory.events.MarketCreated().process_receipt(receipt)[0]["args"]
        market = chain.market(args["market"])
        chain.send(market.functions.buy(0, 30 * E18, 10**30, BIG), chain.alice)   # alice holds YES
        chain.send(market.functions.buy(1, 20 * E18, 10**30, BIG), chain.bob)     # bob holds NO
        chain.increase_time(3 * 3600)
        self.idx.catch_up()
        return args["id"], market

    def sync(self):
        self.idx.catch_up()

    def bal(self, who) -> int:
        return self.chain.token.functions.balanceOf(who).call()


@pytest.fixture
def world(db_clean, chain, monkeypatch):
    return World(chain, monkeypatch)


def rm_call(world, fn, who):
    return world.chain.send(fn, who)


def bonded_proposal(world, mid, market, outcome="YES", verdict=0):
    """The proposer's full path: prepare evidence via the API, then escrow the bond on-chain."""
    c = world.client(world.proposer)
    r = c.post(f"/resolutions/{mid}/propose", params={"bonded": "true"}, json=evidence(outcome, "proposer"))
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["bonded"] is True and "proposeBonded" in p["call"]
    rm_call(world, world.chain.rm.functions.proposeBonded(market.address, verdict, Web3.to_bytes(hexstr=p["evidence_hash"]), p["evidence_uri"]), world.chain.proposer)
    world.sync()
    return p


def dispute_it(world, mid, market, outcome="NO"):
    c = world.client(world.disputer)
    r = c.post(f"/resolutions/{mid}/dispute", json=evidence(outcome, "disputer"))
    assert r.status_code == 201, r.text
    d = r.json()
    rm_call(world, world.chain.rm.functions.dispute(market.address, Web3.to_bytes(hexstr=d["evidence_hash"]), d["evidence_uri"]), world.chain.carol)
    world.sync()
    return d


def arbitrate_it(world, mid, market, verdict_name, verdict_code):
    c = world.client(world.arbiter)
    r = c.post(f"/resolutions/{mid}/arbitration-note", json={"verdict": verdict_name, "rationale": "Both parties' evidence reviewed; the stored raw data supports this verdict.", "references": ["test-fixture://both"]})
    assert r.status_code == 201, r.text
    note = r.json()
    assert "arbitrate" in note["call"]
    rm_call(world, world.chain.rm.functions.arbitrate(market.address, verdict_code, Web3.to_bytes(hexstr=note["evidence_hash"])), world.chain.arbiter)
    world.sync()
    return note


def proposal(client, mid):
    return client.get(f"/resolutions/{mid}").json()["proposals"][-1]


def test_anyone_can_propose_with_a_bond_and_an_undisputed_result_finalizes(world):
    chain = world.chain
    mid, market = world.new_market()
    c = world.client(world.proposer)
    # no resolver role: the unbonded route is closed to this wallet, the bonded one is open
    assert c.post(f"/resolutions/{mid}/propose", json=evidence("YES", "x")).status_code == 403

    start = world.bal(chain.proposer)
    p = bonded_proposal(world, mid, market)
    assert start - world.bal(chain.proposer) == 100 * E18  # bond escrowed
    assert chain.token.functions.balanceOf(chain.rm.address).call() == chain.rm.functions.totalLockedBonds().call() >= 100 * E18

    pr = proposal(c, mid)
    assert pr["state"] == "proposed" and pr["bond"] == str(100 * E18) and pr["dispute_status"] == "none"
    assert pr["resolver_address"] == chain.proposer.lower() and pr["evidence_available"] is True
    assert c.post(f"/resolutions/{mid}/propose", params={"bonded": "true"}, json=evidence("NO", "y")).status_code == 409  # already pending

    with pytest.raises(Exception):  # still inside the challenge window
        chain.rm.functions.finalize(market.address).call({"from": chain.alice})
    chain.increase_time(3600)
    chain.send(chain.rm.functions.finalize(market.address), chain.alice)
    world.sync()
    assert world.bal(chain.proposer) == start  # bond returned
    res = c.get(f"/resolutions/{mid}").json()
    assert res["market_status"] == "resolved" and res["winning_outcome"] == "YES" and res["proposals"][-1]["state"] == "finalized"
    assert c.get(f"/resolutions/{mid}/evidence/{p['evidence_hash']}").text and keccak_hex(c.get(f"/resolutions/{mid}/evidence/{p['evidence_hash']}").text) == p["evidence_hash"]


@pytest.mark.parametrize(
    "ruling, code, proposer_wins",
    [("YES", 0, True), ("NO", 1, False), ("INVALID", 2, False)],
)
def test_dispute_and_arbitration_settle_bonds_and_the_market(world, ruling, code, proposer_wins):
    chain = world.chain
    mid, market = world.new_market()
    p0, d0 = world.bal(chain.proposer), world.bal(chain.carol)
    bonded_proposal(world, mid, market, "YES", 0)
    d = dispute_it(world, mid, market, "NO")

    c = world.client(world.disputer)
    pr = proposal(c, mid)
    assert pr["state"] == "disputed" and pr["dispute_status"] == "disputed"
    assert pr["disputer_address"] == chain.carol.lower() and pr["dispute_bond"] == str(100 * E18)
    assert pr["dispute_evidence_hash"] == d["evidence_hash"] and pr["dispute_evidence_available"] is True
    assert c.post(f"/resolutions/{mid}/dispute", json=evidence("NO", "again")).status_code == 409  # one dispute per proposal
    with pytest.raises(Exception):
        chain.rm.functions.finalize(market.address).call({"from": chain.alice})  # disputed: only the arbiter can decide

    note = arbitrate_it(world, mid, market, ruling, code)
    pr = proposal(c, mid)
    assert pr["state"] == "finalized" and pr["final_outcome"] == ruling
    assert pr["dispute_status"] == ("upheld" if proposer_wins else "overturned")
    assert pr["arbiter_address"] == chain.arbiter.lower() and pr["arbiter_rationale_available"] is True
    assert pr["arbiter_rationale_hash"] == note["evidence_hash"]

    # the loser's bond went to the winner, to the wei
    assert world.bal(chain.proposer) == p0 + (100 * E18 if proposer_wins else -100 * E18)
    assert world.bal(chain.carol) == d0 + (-100 * E18 if proposer_wins else 100 * E18)
    assert chain.rm.functions.totalLockedBonds().call() == 0

    market_view = c.get(f"/markets/{mid}").json()
    assert market_view["status"] == ("invalid" if ruling == "INVALID" else "resolved") and market_view["winning_outcome"] == (None if ruling == "INVALID" else ruling)
    kinds = {e["kind"] for e in c.get(f"/markets/{mid}/evidence").json()}
    assert kinds == {"proposal", "dispute", "arbitration"} and all(e["hash_verified"] for e in c.get(f"/markets/{mid}/evidence").json())

    with session_scope() as s:
        assert reconcile(s, world.idx.client, 31337) == []


def test_an_undecided_dispute_can_be_unwound_and_the_read_model_follows(world):
    chain = world.chain
    mid, market = world.new_market()
    p0, d0 = world.bal(chain.proposer), world.bal(chain.carol)
    bonded_proposal(world, mid, market)
    dispute_it(world, mid, market)
    chain.increase_time(14 * 86400)
    chain.send(chain.rm.functions.releaseBonds(market.address), chain.alice)
    world.sync()
    assert (world.bal(chain.proposer), world.bal(chain.carol)) == (p0, d0)
    pr = proposal(world.client(world.proposer), mid)
    assert pr["state"] == "cancelled" and pr["dispute_status"] == "released"
    # the market is still open for resolution: a fresh proposal can be prepared
    r = world.client(world.proposer).post(f"/resolutions/{mid}/propose", params={"bonded": "true"}, json=evidence("YES", "second-try"))
    assert r.status_code == 201


def test_unbonded_resolver_proposals_with_a_window_can_be_disputed(world):
    chain = world.chain
    chain.send(chain.rm.functions.setChallengeWindow(1800), chain.admin)
    mid, market = world.new_market()
    resolver = world.client(Account.from_key("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"))
    r = resolver.post(f"/resolutions/{mid}/propose", json=evidence("YES", "resolver"))
    assert r.status_code == 201 and r.json()["bonded"] is False
    p = r.json()
    chain.send(chain.rm.functions.propose(market.address, 0, Web3.to_bytes(hexstr=p["evidence_hash"]), p["evidence_uri"]), chain.resolver)
    world.sync()
    assert proposal(resolver, mid)["bond"] == "0"
    dispute_it(world, mid, market, "NO")
    assert proposal(resolver, mid)["state"] == "disputed"
    chain.send(chain.rm.functions.setChallengeWindow(0), chain.admin)  # restore for other tests in this module


def test_dispute_and_arbitration_endpoints_enforce_their_rules(world):
    chain = world.chain
    mid, market = world.new_market()
    anon = TestClient(world.app)
    assert anon.post(f"/resolutions/{mid}/dispute", json=evidence("NO", "x")).status_code == 401
    assert anon.post(f"/resolutions/{mid}/arbitration-note", json={"verdict": "NO", "rationale": "x" * 40}).status_code == 401

    disputer = world.client(world.disputer)
    assert disputer.post(f"/resolutions/{mid}/dispute", json=evidence("NO", "x")).status_code == 409  # nothing to dispute yet

    bonded_proposal(world, mid, market)
    proposer = world.client(world.proposer)
    assert proposer.post(f"/resolutions/{mid}/dispute", json=evidence("NO", "self")).status_code == 409  # not your own proposal
    assert disputer.post(f"/resolutions/{mid}/arbitration-note", json={"verdict": "NO", "rationale": "y" * 40}).status_code == 403  # not an arbiter
    arbiter = world.client(world.arbiter)
    assert arbiter.post(f"/resolutions/{mid}/arbitration-note", json={"verdict": "NO", "rationale": "y" * 40}).status_code == 409  # not disputed yet
    assert arbiter.post(f"/resolutions/{mid}/arbitration-note", json={"verdict": "MAYBE", "rationale": "y" * 40}).status_code == 422
    assert arbiter.post(f"/resolutions/{mid}/arbitration-note", json={"verdict": "NO", "rationale": "short"}).status_code == 422

    chain.increase_time(3600)  # window over
    late = disputer.post(f"/resolutions/{mid}/dispute", json=evidence("NO", "late"))
    assert late.status_code == 409 and "ended" in late.json()["detail"]

    # an open (still tradable) market has nothing to dispute either
    mid2, _ = world.new_market(close_in_hours=48)
    open_try = disputer.post(f"/resolutions/{mid2}/dispute", json=evidence("NO", "x"))
    assert open_try.status_code == 409


def test_the_resolution_view_explains_the_trust_model_honestly(world):
    mid, market = world.new_market()
    text = world.client(world.proposer).get(f"/resolutions/{mid}").json()["trust_model"]
    assert "NOT a decentralized oracle" in text and "single trusted arbiter" in text


def test_a_wallet_cannot_flood_the_evidence_store(world):
    mid, market = world.new_market()
    c = world.client(world.proposer)
    codes = [c.post(f"/resolutions/{mid}/propose", params={"bonded": "true"}, json={**evidence("YES", "spam"), "notes": f"attempt {i}"}).status_code for i in range(27)]
    assert codes[:25] == [201] * 25 and codes[25:] == [409, 409]
    r = c.post(f"/resolutions/{mid}/propose", params={"bonded": "true"}, json={**evidence("YES", "spam"), "notes": "one more"})
    assert "too many" in r.json()["detail"]
    other = world.client(world.disputer)  # the cap is per wallet: someone else is unaffected
    assert other.post(f"/resolutions/{mid}/propose", params={"bonded": "true"}, json=evidence("NO", "fine")).status_code == 201
