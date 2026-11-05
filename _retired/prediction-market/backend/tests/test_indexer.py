"""Indexer tests against a real Hardhat node, the real contracts and real PostgreSQL."""

import pytest
from sqlalchemy import func, select

from app.blockchain.event_listener import Indexer
from app.blockchain.reconcile import reconcile
from app.database.connection import session_scope
from app.models import ChainEvent, IndexedBlock, IndexerCheckpoint, Market, Position, PriceSnapshot, Trade
from app.workers.indexer import build_indexer

E18 = 10**18
BIG = 2**64


@pytest.fixture(scope="module")
def traders(chain):
    for who in (chain.alice, chain.bob, chain.carol):
        chain.send(chain.token.functions.adminMint(who, 10_000 * E18), chain.admin)
    return chain


def buy(chain, market, who, outcome, shares):
    return chain.send(chain.market(market).functions.buy(outcome, shares, BIG * E18, BIG), who)


def sell(chain, market, who, outcome, shares):
    return chain.send(chain.market(market).functions.sell(outcome, shares, 0, BIG), who)


def counts(session, market_id):
    return {
        "trades": session.scalar(select(func.count()).select_from(Trade).where(Trade.market_id == market_id)),
        "snapshots": session.scalar(select(func.count()).select_from(PriceSnapshot).where(PriceSnapshot.market_id == market_id)),
        "events": session.scalar(select(func.count()).select_from(ChainEvent)),
    }


def test_indexes_everything_and_is_idempotent(db_clean, traders):
    chain = traders
    mid = chain.create_market("idx-basic")
    addr = chain.last_market_address
    buy(chain, addr, chain.alice, 0, 30 * E18)
    buy(chain, addr, chain.bob, 1, 20 * E18)
    sell(chain, addr, chain.alice, 0, 10 * E18)

    idx = build_indexer()
    result = idx.catch_up()
    assert result.events_applied >= 4  # MarketCreated + 3 trades (+ earlier markets in this module)

    with session_scope() as s:
        m = s.scalar(select(Market).where(Market.blockchain_market_id == mid))
        assert m.contract_address == addr.lower()
        assert m.trade_count == 3 and int(m.volume) > 0
        first = counts(s, m.id)
        assert first["trades"] == first["snapshots"] == 3

        # the read model equals the chain
        on = chain.market(addr).functions
        assert (int(m.q_yes), int(m.q_no), int(m.collateral)) == (on.qYes().call(), on.qNo().call(), on.collateral().call())
        alice = s.get(Position, (m.id, chain.alice.lower()))
        assert int(alice.yes_shares) == 20 * E18 == on.yesShares(chain.alice).call()
        assert int(alice.cost_basis) > 0 and int(alice.yes_cost) > 0  # moving-average cost tracked
        assert reconcile(s, idx.client, 31337) == []

    # running again does nothing; replaying from block 0 does not duplicate anything
    assert idx.catch_up().events_applied == 0
    with session_scope() as s:  # rewind the checkpoint to genesis (with its true hash): pure replay
        cp = s.get(IndexerCheckpoint, 31337)
        cp.last_block, cp.last_block_hash = 0, idx.client.block_hash(0)
    replay = build_indexer().catch_up()
    assert replay.reorg_to is None and replay.from_block == 1 and replay.events_applied == 0
    with session_scope() as s:
        m = s.scalar(select(Market).where(Market.blockchain_market_id == mid))
        assert counts(s, m.id) == first


def test_prices_follow_the_contract_after_every_trade(db_clean, traders):
    chain = traders
    mid = chain.create_market("idx-prices")
    addr = chain.last_market_address
    on_chain = []
    for outcome, shares in [(0, 40), (0, 25), (1, 90), (0, 10)]:
        buy(chain, addr, chain.alice, outcome, shares * E18)
        on_chain.append(chain.market(addr).functions.priceYes().call())
    build_indexer().catch_up()
    with session_scope() as s:
        m = s.scalar(select(Market).where(Market.blockchain_market_id == mid))
        history = s.scalars(select(PriceSnapshot).where(PriceSnapshot.market_id == m.id).order_by(PriceSnapshot.block_number, PriceSnapshot.log_index)).all()
        assert [int(h.yes_price * E18) for h in history] == on_chain
        # price direction matches the trades: YES, YES up; NO down; YES up
        assert history[1].yes_price > history[0].yes_price > 0.5
        assert history[2].yes_price < history[1].yes_price
        assert history[3].yes_price > history[2].yes_price


def test_crash_mid_batch_leaves_nothing_half_applied(db_clean, traders, monkeypatch):
    chain = traders
    chain.create_market("idx-crash")
    addr = chain.last_market_address
    buy(chain, addr, chain.alice, 0, 10 * E18)
    buy(chain, addr, chain.bob, 1, 10 * E18)

    import app.blockchain.event_listener as listener

    real = listener.record_and_apply
    calls = {"n": 0}

    def flaky(session, ev, block_time):
        calls["n"] += 1
        if calls["n"] == 4:
            raise RuntimeError("simulated crash in the middle of a batch")
        return real(session, ev, block_time)

    monkeypatch.setattr(listener, "record_and_apply", flaky)
    with pytest.raises(RuntimeError):
        build_indexer().catch_up()
    with session_scope() as s:  # whole batch rolled back: no events, no checkpoint
        assert s.scalar(select(func.count()).select_from(ChainEvent)) == 0
        assert s.get(IndexerCheckpoint, 31337) is None

    monkeypatch.setattr(listener, "record_and_apply", real)  # "restart"
    build_indexer().catch_up()
    with session_scope() as s:
        m = s.scalar(select(Market).where(Market.contract_address == addr.lower()))
        assert m.trade_count == 2
        assert s.scalar(select(func.count()).select_from(Trade).where(Trade.market_id == m.id)) == 2
        assert reconcile(s, build_indexer().client, 31337) == []


def test_resumes_from_checkpoint_and_picks_up_new_events(db_clean, traders):
    chain = traders
    mid = chain.create_market("idx-resume")
    addr = chain.last_market_address
    buy(chain, addr, chain.alice, 0, 10 * E18)
    build_indexer().catch_up()
    with session_scope() as s:
        before = s.get(IndexerCheckpoint, 31337).last_block

    buy(chain, addr, chain.bob, 1, 15 * E18)  # new indexer instance = process restart
    r = build_indexer().catch_up()
    assert r.events_applied == 1 and r.from_block == before + 1
    with session_scope() as s:
        m = s.scalar(select(Market).where(Market.blockchain_market_id == mid))
        assert m.trade_count == 2


def test_only_events_from_known_contracts_are_stored(db_clean, traders):
    chain = traders
    chain.create_market("idx-addr")
    build_indexer().catch_up()
    with session_scope() as s:
        known = {m for (m,) in s.execute(select(Market.contract_address))}
        known |= {chain.deployment["factory"].lower(), chain.deployment["resolutionManager"].lower()}
        stored = {a for (a,) in s.execute(select(ChainEvent.contract_address).distinct())}
        assert stored <= known and stored  # the token's Transfer/Faucet events are not indexed


def test_reorg_is_detected_and_read_model_is_rebuilt(db_clean, traders):
    chain = traders
    mid = chain.create_market("idx-reorg")
    addr = chain.last_market_address
    buy(chain, addr, chain.alice, 0, 10 * E18)
    build_indexer().catch_up()

    snap = chain.snapshot()
    buy(chain, addr, chain.bob, 1, 50 * E18)          # trade X (will be orphaned)
    idx = build_indexer()
    idx.catch_up()
    with session_scope() as s:
        m = s.scalar(select(Market).where(Market.blockchain_market_id == mid))
        assert m.trade_count == 2

    chain.revert(snap)                                  # chain reorganises: X never happened
    buy(chain, addr, chain.carol, 0, 5 * E18)          # trade Y on the new branch
    chain.mine(1)
    result = idx.catch_up()

    assert result.reorg_to is not None
    with session_scope() as s:
        m = s.scalar(select(Market).where(Market.blockchain_market_id == mid))
        wallets = [t.wallet_address for t in s.scalars(select(Trade).where(Trade.market_id == m.id).order_by(Trade.block_number, Trade.log_index))]
        assert wallets == [chain.alice.lower(), chain.carol.lower()], "orphaned trade X must be gone, Y present"
        assert s.get(Position, (m.id, chain.bob.lower())) is None
        assert reconcile(s, idx.client, 31337) == []


def test_position_cost_accounting_uses_moving_average(db_clean, traders):
    chain = traders
    mid = chain.create_market("idx-pnl")
    addr = chain.last_market_address
    buy(chain, addr, chain.alice, 0, 30 * E18)
    sell(chain, addr, chain.alice, 0, 10 * E18)
    build_indexer().catch_up()
    with session_scope() as s:
        m = s.scalar(select(Market).where(Market.blockchain_market_id == mid))
        buy_t, sell_t = s.scalars(select(Trade).where(Trade.market_id == m.id).order_by(Trade.log_index)).all()
        cost, proceeds = int(buy_t.token_amount), int(sell_t.token_amount)
        pos = s.get(Position, (m.id, chain.alice.lower()))
        released = cost * 10 // 30  # average cost of the 10 shares sold
        assert int(pos.yes_cost) == cost - released
        assert int(pos.realized_pnl) == proceeds - released
        assert int(pos.cost_basis) == cost - proceeds  # the quantity the contract uses for refunds
        assert proceeds < cost  # selling immediately loses the spread + margin


def test_voided_market_refunds_are_indexed_and_reconciled(db_clean, traders):
    from web3 import Web3

    chain = traders
    mid = chain.create_market("idx-invalid", close_in=7200)
    addr = chain.last_market_address
    buy(chain, addr, chain.alice, 0, 30 * E18)
    buy(chain, addr, chain.bob, 1, 10 * E18)
    chain.increase_time(3 * 3600)
    chain.send(chain.rm.functions.propose(addr, 2, Web3.keccak(text="source never published"), "test://evidence"), chain.resolver)
    chain.send(chain.rm.functions.finalize(addr), chain.carol)
    chain.send(chain.market(addr).functions.refund(), chain.alice)
    chain.send(chain.market(addr).functions.claimResidual(), chain.creator)

    idx = build_indexer()
    idx.catch_up()
    with session_scope() as s:
        m = s.scalar(select(Market).where(Market.blockchain_market_id == mid))
        assert m.status == "invalid" and m.winning_outcome is None
        alice = s.get(Position, (m.id, chain.alice.lower()))
        bob = s.get(Position, (m.id, chain.bob.lower()))
        assert int(alice.yes_shares) == 0 and int(alice.settled_amount) > 0  # refunded
        assert int(bob.no_shares) == 10 * E18 and int(bob.settled_amount) == 0  # has not claimed yet
        assert reconcile(s, idx.client, 31337) == []


def test_daily_activity_rollup_always_equals_the_trades_even_after_a_reorg(db_clean, traders):
    from app.models import DailyActivity

    def check(session):
        rolled = {d: (n, int(v)) for d, n, v in session.execute(select(DailyActivity.day, DailyActivity.trades, DailyActivity.volume))}
        real = {}
        for t in session.scalars(select(Trade)):
            n, v = real.get(t.timestamp.date(), (0, 0))
            real[t.timestamp.date()] = (n + 1, v + int(t.token_amount))
        assert rolled == real and real, (rolled, real)

    chain = traders
    chain.create_market("idx-rollup")
    addr = chain.last_market_address
    buy(chain, addr, chain.alice, 0, 10 * E18)
    buy(chain, addr, chain.bob, 1, 5 * E18)
    idx = build_indexer()
    idx.catch_up()
    with session_scope() as s:
        check(s)

    snap = chain.snapshot()
    buy(chain, addr, chain.carol, 0, 40 * E18)  # will be orphaned
    idx.catch_up()
    with session_scope() as s:
        check(s)
    chain.revert(snap)
    buy(chain, addr, chain.carol, 1, 3 * E18)
    chain.mine(1)
    assert idx.catch_up().reorg_to is not None
    with session_scope() as s:
        check(s)  # rebuilt from raw events: the orphaned trade is gone from the rollup too
