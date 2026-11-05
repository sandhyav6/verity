#!/usr/bin/env python
"""Reproducible benchmark of the whole system. Nothing is invented: every number is measured here.

    cd backend && python ../scripts/bench.py          (Python 3.12 venv with requirements-dev.txt; Node.js on PATH)

It starts its own throwaway stack on private ports (embedded PostgreSQL, Hardhat node, API, indexer), measures,
writes docs/benchmarks/results.json and docs/benchmarks.md, and tears everything down.

Measured:  gas per operation (contracts/scripts/benchmark-gas.ts) · API latency per endpoint · event indexing lag
           (tx mined -> visible through the API) · resolution-evidence processing · live data ingestion (Open-Meteo)
           · LMSR calculation time (browser-side TS and the 50-digit reference) · database query performance on a
           throwaway database loaded with SYNTHETIC rows (clearly labelled; never used by the app).
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND, CONTRACTS, FRONTEND = ROOT / "backend", ROOT / "contracts", ROOT / "frontend"
sys.path.insert(0, str(BACKEND))

import httpx  # noqa: E402
import pgserver  # noqa: E402
from eth_account import Account  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402
from web3 import Web3  # noqa: E402

from tests.helpers import build_message, sign  # noqa: E402

NPX = shutil.which("npx") or shutil.which("npx.cmd")
procs: list[subprocess.Popen] = []


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def pct(xs: list[float], p: float) -> float:
    s = sorted(xs)
    return s[min(len(s) - 1, int(round(p / 100 * (len(s) - 1))))]


def summarize(ms: list[float]) -> dict:
    return {"runs": len(ms), "p50_ms": round(pct(ms, 50), 2), "p95_ms": round(pct(ms, 95), 2), "max_ms": round(max(ms), 2), "mean_ms": round(statistics.mean(ms), 2)}


def kill_all() -> None:
    for p in procs:
        try:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
            else:
                p.terminate()
        except Exception:
            pass


# ----------------------------------------------------------------------------------------------- gas


def bench_gas() -> dict:
    r = subprocess.run([NPX, "hardhat", "run", "scripts/benchmark-gas.ts"], cwd=CONTRACTS, capture_output=True, text=True, check=True)
    start = r.stdout.index("{")
    return json.loads(r.stdout[start:])


# ----------------------------------------------------------------------------------------------- LMSR


def bench_lmsr() -> dict:
    ts = subprocess.run(["node", "scripts/bench-lmsr.mjs"], cwd=FRONTEND, capture_output=True, text=True, check=True)
    from mpmath import exp, log, mp, mpf

    mp.dps = 50
    n = 20_000
    t0 = time.perf_counter()
    for i in range(n):
        mpf(100) * log(exp(mpf(120 + i % 7) / 100) + exp(mpf(40) / 100))
    ref_us = (time.perf_counter() - t0) / n * 1e6
    return {"browser_typescript": json.loads(ts.stdout), "mpmath_50_digit_reference_us_per_cost": round(ref_us, 1)}


# ----------------------------------------------------------------------------------------------- database scale


def bench_db(server_uri: str) -> dict:
    """Load a throwaway database with synthetic rows and time the real service functions."""
    admin = create_engine(server_uri.replace("postgresql://", "postgresql+psycopg://"), isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text("CREATE DATABASE pm_bench_scale"))
    url = server_uri.replace("postgresql://", "postgresql+psycopg://").rsplit("/", 1)[0] + "/pm_bench_scale"
    env = {**os.environ, "DATABASE_URL": url}
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=BACKEND, env=env, check=True, capture_output=True)

    markets, trades_per_market = 200, 1000
    eng = create_engine(url)
    with eng.begin() as c:
        c.execute(text("""
            INSERT INTO markets (chain_id, contract_address, blockchain_market_id, metadata_hash, category, created_by, liquidity_parameter,
                trading_close_time, resolution_deadline, created_block, created_at, status, q_yes, q_no, collateral, yes_price, volume, trade_count)
            SELECT 31337, '0x' || lpad(to_hex(g), 40, '0'), g, '0x' || lpad(to_hex(g), 64, '0'),
                   (ARRAY['economy','weather','sports','technology'])[1 + g % 4], '0x' || repeat('1', 40), 100e18,
                   now() + (g % 30 - 10) * interval '1 day', now() + interval '60 days', g, now() - g * interval '1 hour',
                   CASE WHEN g % 10 = 0 THEN 'resolved' ELSE 'active' END, 0, 0, 0, 0.5, 0, 0
            FROM generate_series(1, :n) g"""), {"n": markets})
        c.execute(text("""
            INSERT INTO market_metadata (metadata_hash, canonical_json, created_by, created_at)
            SELECT '0x' || lpad(to_hex(g), 64, '0'), json_build_object('question', 'Synthetic benchmark market ' || g || '?')::text, '0x' || repeat('1', 40), now()
            FROM generate_series(1, :n) g"""), {"n": markets})
        c.execute(text("""
            INSERT INTO trades (market_id, chain_id, wallet_address, outcome, action, shares, token_amount, yes_price_after, transaction_hash, block_number, log_index, timestamp)
            SELECT m.id, 31337, '0x' || lpad(to_hex(t % 5000), 40, '0'), CASE WHEN t % 2 = 0 THEN 'YES' ELSE 'NO' END, 'buy',
                   (1 + t % 20) * 1e18, (1 + t % 20) * 0.5e18, 0.5, '0x' || lpad(to_hex(m.id * 100000 + t), 64, '0'), 1000 + m.id * 10 + t / 100, t,
                   now() - (t % 5000) * interval '1 minute'
            FROM markets m, generate_series(1, :n) t"""), {"n": trades_per_market})
        c.execute(text("""
            INSERT INTO price_snapshots (market_id, chain_id, transaction_hash, log_index, block_number, block_time, q_yes, q_no, yes_price)
            SELECT market_id, chain_id, transaction_hash, log_index, block_number, timestamp, 0, 0, yes_price_after FROM trades"""))
        c.execute(text("""
            INSERT INTO positions (market_id, wallet_address, yes_shares, no_shares, yes_cost, no_cost, realized_pnl, cost_basis, settled_amount, updated_at)
            SELECT market_id, wallet_address, sum(CASE WHEN outcome='YES' THEN shares ELSE 0 END), sum(CASE WHEN outcome='NO' THEN shares ELSE 0 END),
                   0, 0, 0, sum(token_amount), 0, now() FROM trades GROUP BY market_id, wallet_address"""))
        c.execute(text("""
            INSERT INTO daily_activity (chain_id, day, trades, volume)
            SELECT chain_id, (timestamp AT TIME ZONE 'UTC')::date, count(*), sum(token_amount) FROM trades GROUP BY 1, 2"""))
        c.execute(text("""
            UPDATE markets m SET volume = s.v, trade_count = s.n FROM (SELECT market_id, sum(token_amount) v, count(*) n FROM trades GROUP BY market_id) s WHERE s.market_id = m.id"""))
    with eng.connect().execution_options(isolation_level="AUTOCOMMIT") as c:
        c.execute(text("ANALYZE"))
        counts = {t: c.execute(text(f"SELECT count(*) FROM {t}")).scalar() for t in ("markets", "trades", "price_snapshots", "positions")}

    os.environ["DATABASE_URL"] = url
    from app.core.config import get_settings
    from app.database.connection import new_session, reset_engine

    get_settings.cache_clear()
    reset_engine()
    from app.services import analytics_service, market_service, portfolio_service

    db = new_session()
    wallet = "0x" + "0" * 36 + "0a2b"
    queries = {
        "list markets, newest first (limit 20)": lambda: market_service.list_markets(db, category=None, status=None, q=None, sort="created_at", order="desc", limit=20, offset=0, chain_id=31337),
        "list markets by volume": lambda: market_service.list_markets(db, category=None, status=None, q=None, sort="volume", order="desc", limit=20, offset=0, chain_id=31337),
        "list markets, status=active + category": lambda: market_service.list_markets(db, category="weather", status="active", q=None, sort="closing", order="asc", limit=20, offset=0, chain_id=31337),
        "list markets, text search": lambda: market_service.list_markets(db, category=None, status=None, q="market 17", sort="created_at", order="desc", limit=20, offset=0, chain_id=31337),
        "market trades, newest 20": lambda: market_service.market_trades(db, market_service.get_market_row(db, 7, 31337)[0], None, "", 20, 0),
        "price history, 500 points": lambda: market_service.price_history(db, market_service.get_market_row(db, 7, 31337)[0], 500, 0),
        "trades feed, one wallet": lambda: market_service.list_trades(db, "", 31337, wallet=wallet, market_id=None, limit=20, offset=0),
        "analytics overview (all trades)": lambda: analytics_service.overview(db, 31337),
        "analytics per-market (50)": lambda: analytics_service.per_market(db, 31337, 50, 0),
        "portfolio for a wallet": lambda: portfolio_service.build_portfolio(db, wallet, 31337, None),
    }
    out = {}
    for name, fn in queries.items():
        fn()
        ms = []
        for _ in range(25):
            t0 = time.perf_counter()
            fn()
            ms.append((time.perf_counter() - t0) * 1000)
        out[name] = summarize(ms)
    plans = {}
    with eng.connect() as c:
        for name, sql in {
            "trades by market (newest 20)": "SELECT * FROM trades WHERE market_id = 7 ORDER BY block_number DESC, log_index DESC LIMIT 20",
            "trades by wallet": f"SELECT * FROM trades WHERE wallet_address = '{wallet}' LIMIT 20",
            "markets by category + close time": "SELECT * FROM markets WHERE category = 'weather' ORDER BY trading_close_time LIMIT 20",
        }.items():
            plan = "\n".join(r[0] for r in c.execute(text("EXPLAIN " + sql)))
            plans[name] = {"uses_index": "Index" in plan, "seq_scan": "Seq Scan" in plan}
    db.close()
    reset_engine()
    return {"synthetic_data_rows": counts, "queries": out, "plans": plans}


# ----------------------------------------------------------------------------------------------- live stack


def bench_stack(server_uri: str) -> dict:
    admin = create_engine(server_uri.replace("postgresql://", "postgresql+psycopg://"), isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text("CREATE DATABASE pm_bench_app"))
    db_url = server_uri.replace("postgresql://", "postgresql+psycopg://").rsplit("/", 1)[0] + "/pm_bench_app"
    base_env = {**os.environ, "DATABASE_URL": db_url, "PYTHONWARNINGS": "ignore"}
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=BACKEND, env=base_env, check=True, capture_output=True)

    node_port, api_port = free_port(), free_port()
    rpc = f"http://127.0.0.1:{node_port}"
    procs.append(subprocess.Popen([NPX, "hardhat", "node", "--port", str(node_port)], cwd=CONTRACTS, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    w3 = Web3(Web3.HTTPProvider(rpc))
    for _ in range(120):
        try:
            if w3.is_connected():
                break
        except Exception:
            pass
        time.sleep(0.5)
    subprocess.run([NPX, "hardhat", "run", "scripts/deploy.ts", "--network", "localhost"], cwd=CONTRACTS, check=True, capture_output=True,
                   env={**os.environ, "RPC_URL": rpc, "DEPLOYMENT_NAME": "bench", "BONDED_WINDOW": "3600"})
    dep = json.loads((CONTRACTS / "deployments" / "bench.json").read_text())
    (CONTRACTS / "deployments" / "bench.json").unlink()

    env = {**base_env, "RPC_URL": rpc, "PUBLIC_RPC_URL": rpc, "FACTORY_ADDRESS": dep["factory"], "RESOLUTION_MANAGER_ADDRESS": dep["resolutionManager"],
           "TOKEN_ADDRESS": dep["token"], "INDEXER_CONFIRMATIONS": "0", "INDEXER_POLL_SECONDS": "0.2", "RATE_LIMIT_DEFAULT": "1000000/minute",
           "RATE_LIMIT_AUTH": "1000000/minute", "CLOCK_SOURCE": "chain"}
    procs.append(subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(api_port), "--log-level", "warning"], cwd=BACKEND, env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    procs.append(subprocess.Popen([sys.executable, "-m", "app.workers.indexer"], cwd=BACKEND, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    api = f"http://127.0.0.1:{api_port}"
    for _ in range(120):
        try:
            if httpx.get(f"{api}/health", timeout=2).status_code == 200:
                break
        except Exception:
            time.sleep(0.5)

    from app.blockchain.contract_registry import load_abi

    acct = w3.eth.accounts
    tok = w3.eth.contract(address=dep["token"], abi=load_abi("token"))
    fac = w3.eth.contract(address=dep["factory"], abi=load_abi("factory"))
    rm = w3.eth.contract(address=dep["resolutionManager"], abi=load_abi("resolution"))
    send = lambda fn, who: w3.eth.wait_for_transaction_receipt(fn.transact({"from": who}))  # noqa: E731

    def login(account) -> httpx.Client:
        c = httpx.Client(base_url=api, timeout=30)
        nonce = c.get("/auth/nonce").json()
        msg = build_message(nonce, account.address)
        assert c.post("/auth/verify", json={"message": msg, "signature": sign(account, msg)}).status_code == 200
        return c

    mnemonic = "test test test test test test test test test test test junk"  # public Hardhat development mnemonic
    Account.enable_unaudited_hdwallet_features()
    hd = lambda i: Account.from_mnemonic(mnemonic, account_path=f"m/44'/60'/0'/0/{i}")  # noqa: E731
    creator_c = login(hd(1))
    now = w3.eth.get_block("latest")["timestamp"]
    body = {
        "question": "Will Chennai receive more than 100 mm of rain between 1 and 5 October 2026?",
        "description": "Benchmark market on a throwaway local chain, not real forecasting data.", "category": "weather",
        "yes_definition": "Total rainfall above 100 mm.", "no_definition": "Total rainfall 100 mm or less.",
        "resolution_source": {"name": "Open-Meteo Historical Weather API", "url": "https://open-meteo.com/en/docs/historical-weather-api", "dataset": "daily precipitation_sum, ERA5"},
        "resolution_criteria": "Sum daily precipitation_sum for 1-5 October 2026; YES if strictly above 100 mm.",
        "resolution_spec": {"measurement": "Total of daily precipitation_sum", "unit": "mm", "observation_period": "1 to 5 October 2026",
                            "revision_policy": "First published value counts.", "missing_data_policy": "Void and refund if data is missing."},
        "trading_close_time": datetime.fromtimestamp(now + 7200, tz=timezone.utc).isoformat(),
        "resolution_deadline": datetime.fromtimestamp(now + 30 * 86400, tz=timezone.utc).isoformat(), "liquidity_parameter": "100",
    }
    t0 = time.perf_counter()
    fp = creator_c.post("/markets", json=body).json()["factory_params"]
    market_register_ms = (time.perf_counter() - t0) * 1000
    rc = send(fac.functions.createMarket((Web3.to_bytes(hexstr=fp["metadataHash"]), fp["category"], fp["tradingClose"], fp["resolutionDeadline"], int(fp["liquidityB"]))), acct[1])
    args = fac.events.MarketCreated().process_receipt(rc)[0]["args"]
    mid = args["id"]
    market = w3.eth.contract(address=args["market"], abi=load_abi("market"))
    traders = acct[3:9]
    for who in traders:
        send(tok.functions.faucet(), who)

    # --- indexing lag: tx mined -> visible through the API (includes the indexer's 0.2 s poll interval)
    lags, total = [], 0
    for i in range(20):
        send(market.functions.buy(i % 2, (1 + i % 4) * 10**18, 10**30, 2**64), traders[i % len(traders)])
        t_mined = time.perf_counter()
        total += 1
        while True:
            got = httpx.get(f"{api}/markets/{mid}/trades", params={"limit": 1}, timeout=10).json()["total"]
            if got >= total:
                break
            time.sleep(0.01)
        lags.append((time.perf_counter() - t_mined) * 1000)
    indexing = summarize(lags) | {"indexer_poll_interval_s": 0.2, "confirmations": 0}

    # --- API latency (sequential requests over loopback, real DB, real chain)
    wallet = traders[0]
    endpoints = ["/health", "/config", "/markets", f"/markets/{mid}", f"/markets/{mid}/history", f"/markets/{mid}/trades", "/trades", "/analytics/overview",
                 "/analytics/categories", "/analytics/markets", f"/portfolio/{wallet}", f"/resolutions/{mid}", "/data/sources"]
    client = httpx.Client(base_url=api, timeout=30)
    api_latency = {}
    for ep in endpoints:
        client.get(ep)
        ms = []
        for _ in range(100):
            t0 = time.perf_counter()
            r = client.get(ep)
            ms.append((time.perf_counter() - t0) * 1000)
            assert r.status_code == 200, (ep, r.status_code)
        api_latency[ep] = summarize(ms)

    # --- resolution evidence processing (prepare + hash + store), as the resolver
    w3.provider.make_request("evm_increaseTime", [3 * 3600])
    w3.provider.make_request("evm_mine", [])
    time.sleep(1.5)
    resolver_c = login(hd(2))
    ev = {"proposed_outcome": "YES", "source_name": "Open-Meteo (benchmark)", "source_url": "https://open-meteo.com/en/docs/historical-weather-api",
          "evidence_retrieved_at": datetime.now(timezone.utc).isoformat(), "observation_period": "1 to 5 October 2026", "raw_evidence_reference": "bench://x",
          "raw_evidence_hash": "0x" + "ab" * 32, "normalized_result": "112.4", "unit": "mm"}
    prep = []
    for i in range(20):
        t0 = time.perf_counter()
        r = resolver_c.post(f"/resolutions/{mid}/propose", json={**ev, "notes": f"run {i}"})
        prep.append((time.perf_counter() - t0) * 1000)
        assert r.status_code == 201, r.text
    # on-chain propose -> finalize -> visible as resolved through the API
    p = r.json()
    send(rm.functions.propose(args["market"], 0, Web3.to_bytes(hexstr=p["evidence_hash"]), p["evidence_uri"]), acct[2])
    t0 = time.perf_counter()
    send(rm.functions.finalize(args["market"]), acct[4])
    t_mined = time.perf_counter()
    while httpx.get(f"{api}/markets/{mid}", timeout=10).json()["status"] != "resolved":
        time.sleep(0.01)
    resolve_lag = (time.perf_counter() - t_mined) * 1000

    # --- live data ingestion (real network; skipped when offline)
    ingestion: dict
    try:
        os.environ.update({"DATABASE_URL": db_url})
        from datetime import date
        from decimal import Decimal

        from app.data_sources.weather import OpenMeteoSource, WeatherQuery

        src = OpenMeteoSource()
        ms, status = [], None
        for _ in range(5):
            t0 = time.perf_counter()
            rec = src.ingest(WeatherQuery("Chennai", Decimal("13.0827"), Decimal("80.2707"), date.today() - timedelta(days=60), date.today() - timedelta(days=50)))
            ms.append((time.perf_counter() - t0) * 1000)
            status = rec.validation_status
        ingestion = summarize(ms) | {"source": "live Open-Meteo archive API", "record_status": status, "note": "network-dependent"}
    except Exception as exc:  # noqa: BLE001
        ingestion = {"skipped": f"{type(exc).__name__}: {exc}"}

    return {
        "api_latency": api_latency, "indexing_lag": indexing,
        "market_definition_register_ms": round(market_register_ms, 1),
        "resolution": {"evidence_prepare_hash_store": summarize(prep), "finalize_mined_to_visible_resolved_ms": round(resolve_lag, 1)},
        "data_ingestion": ingestion, "trades_driven": total,
    }


def render(results: dict) -> str:
    g, s, d, lm = results["gas"], results["stack"], results["database"], results["lmsr"]
    L = []
    w = L.append
    w("# Benchmarks\n")
    w(f"Generated by `scripts/bench.py` on {results['environment']['date']} ({results['environment']['os']}, {results['environment']['cpu']}, Python {results['environment']['python']}, Node {results['environment']['node']}). "
      "Every number below was measured by that script on one developer machine; re-run it to reproduce. They are **local-loopback, single-user** numbers, not capacity claims.\n")
    w("## Gas (exact receipts, in-process Hardhat network)\n")
    w("| Operation | Gas |\n|---|---|")
    dep = g["deployment"]
    for k, v in dep.items():
        w(f"| Deploy {k} | {v:,} |")
    w(f"| `createMarket` (clone + subsidy + init), median | {g['createMarket']['median']:,} (min {g['createMarket']['min']:,}, max {g['createMarket']['max']:,}) |")
    w(f"| `buy`, first by a new user | {g['buy']['first_by_a_new_user']:,} |")
    r = g["buy"]["repeated"]
    w(f"| `buy`, repeated ({r['runs']} runs) | median {r['median']:,} (min {r['min']:,}, max {r['max']:,}) |")
    r = g["sell"]
    w(f"| `sell` ({r['runs']} runs) | median {r['median']:,} (min {r['min']:,}, max {r['max']:,}) |")
    w(f"| `quoteBuy` view (LMSR cost on-chain), `estimateGas` | {g['quoteBuy_view_gas_estimate']:,} |")
    w(f"| `priceYes` view, `estimateGas` | {g['priceYes_view_gas_estimate']:,} |")
    for k, v in g["resolution"].items():
        w(f"| Resolution: {k} | {v:,} |")
    for k, v in g["oracle"].items():
        w(f"| Oracle: {k} | {v:,} |")
    w(f"| Faucet claim | {g['faucet']:,} |\n")
    w("## LMSR calculation time\n")
    w("| Implementation | Cost |\n|---|---|")
    for e in lm["browser_typescript"]:
        w(f"| Browser TypeScript `{e['name']}` | {e['ns_per_call']:,} ns/call ({e['calls_per_second']:,}/s) |")
    w(f"| 50-digit `mpmath` reference `cost` | {lm['mpmath_50_digit_reference_us_per_cost']} µs/call |")
    w(f"| On-chain `quoteBuy` | {g['quoteBuy_view_gas_estimate']:,} gas |\n")
    w("## API latency (100 sequential requests per endpoint, loopback, real PostgreSQL and chain)\n")
    w("| Endpoint | p50 ms | p95 ms | max ms |\n|---|---|---|---|")
    for ep, v in s["api_latency"].items():
        w(f"| `GET {ep}` | {v['p50_ms']} | {v['p95_ms']} | {v['max_ms']} |")
    w("\n`/portfolio/*` and `/health` include live calls to the node (token balance, database check).\n")
    w("## Indexing and resolution\n")
    i = s["indexing_lag"]
    w(f"* **Event indexing lag** (transaction mined -> visible through the API), {i['runs']} trades: p50 {i['p50_ms']} ms, p95 {i['p95_ms']} ms, max {i['max_ms']} ms. The indexer polls every {i['indexer_poll_interval_s']} s with 0 confirmations, so most of this is the poll interval; on Sepolia add the confirmation depth (about 12 blocks).")
    e = s["resolution"]["evidence_prepare_hash_store"]
    w(f"* **Resolution evidence processing** (`POST /resolutions/{{id}}/propose`: validate, build, hash, store), {e['runs']} runs: p50 {e['p50_ms']} ms, p95 {e['p95_ms']} ms.")
    w(f"* **Finalize mined -> market visible as resolved** through the API: {s['resolution']['finalize_mined_to_visible_resolved_ms']} ms (single run).")
    w(f"* Registering a market definition (`POST /markets`): {s['market_definition_register_ms']} ms (single run).")
    di = s["data_ingestion"]
    if "skipped" in di:
        w(f"* **Data ingestion**: skipped ({di['skipped']}).")
    else:
        w(f"* **Data ingestion** (live Open-Meteo fetch + normalize, {di['runs']} runs): p50 {di['p50_ms']} ms, p95 {di['p95_ms']} ms, max {di['max_ms']} ms; record status `{di['record_status']}`. Dominated by network latency and the provider.\n")
    w("## Database query performance (throwaway database with SYNTHETIC rows)\n")
    c = d["synthetic_data_rows"]
    w(f"Loaded with generated rows ({c['markets']:,} markets, {c['trades']:,} trades, {c['price_snapshots']:,} price snapshots, {c['positions']:,} positions) purely to time queries; this data is never used by the application. Each query is the real service function, 25 runs after one warm-up.\n")
    w("| Query | p50 ms | p95 ms | max ms |\n|---|---|---|---|")
    for q, v in d["queries"].items():
        w(f"| {q} | {v['p50_ms']} | {v['p95_ms']} | {v['max_ms']} |")
    w("\nQuery plans for the three hottest lookups: " + "; ".join(f"{k}: {'index scan' if v['uses_index'] else 'sequential scan (the planner prefers it on a table this small)'}" for k, v in d["plans"].items()) + ".\n")
    w("## Reading these numbers honestly\n")
    w("* Single machine, loopback networking, one client, warm caches; production latency would add network and TLS.\n* Gas numbers are from the in-process network with default settings; real networks differ slightly (calldata, access lists) but not in kind.\n* The synthetic database shows how the indexes behave at roughly 200 k trades; it is not a load test of concurrent users (none was run).\n* The LMSR TypeScript numbers measure the indicative browser maths, not the on-chain pricing; the contract's accuracy is tested against the 50-digit reference in `contracts/test/`.\n")
    return "\n".join(L)


def main() -> None:
    env = {
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "os": f"{platform.system()} {platform.release()}", "cpu": platform.processor() or platform.machine(),
        "python": platform.python_version(), "node": subprocess.run(["node", "-v"], capture_output=True, text=True).stdout.strip(),
    }
    results: dict = {"environment": env}
    tmp = tempfile.mkdtemp(prefix="pm-bench-pg-")
    server = pgserver.get_server(Path(tmp) / "data", cleanup_mode="delete")
    uri = server.get_uri()
    try:
        print("gas ..."); results["gas"] = bench_gas()
        print("lmsr ..."); results["lmsr"] = bench_lmsr()
        print("database (synthetic load) ..."); results["database"] = bench_db(uri)
        print("full stack ..."); results["stack"] = bench_stack(uri)
    finally:
        kill_all()
        server.cleanup()
    out = ROOT / "docs" / "benchmarks"
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.json").write_text(json.dumps(results, indent=1))
    (ROOT / "docs" / "benchmarks.md").write_text(render(results), encoding="utf-8")
    print("wrote docs/benchmarks.md and docs/benchmarks/results.json")


if __name__ == "__main__":
    main()
