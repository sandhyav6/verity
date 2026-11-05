# Prediction market simulator (working title)

> **TEST-ONLY EDUCATIONAL SIMULATION.** Everything here uses *test tokens that have no monetary value*. There are no deposits, fees, prizes, payments, cash-outs or conversion to money, and nothing may be bought, sold or redeemed for money, goods or services. It has **not been legally reviewed** and must not be deployed publicly or commercially without legal review (see [docs/legal.md](docs/legal.md)). It must never be deployed to Ethereum mainnet or any production network; the deploy script refuses to.
>
> The project has no final name yet; see [docs/project-identity.md](docs/project-identity.md) for recommendations.

A hybrid blockchain application in which people trade YES/NO shares on real-world Indian events (economy, weather, sports, science and technology) priced by an on-chain **LMSR automated market maker**. Trades, positions, collateral and settlement live in Solidity contracts; a Python backend indexes the chain into PostgreSQL, fetches real external data with full provenance, and serves a React interface.

## 1. Problem and motivation

Prediction markets turn beliefs about future events into prices, but a market is only as good as its **resolution**: who decides the outcome, from what source, with what evidence, and what happens when the data is late, revised, missing or disputed. This project builds the whole chain end to end, with an emphasis on getting those parts honest: explicit resolution criteria, hashed evidence, a bonded challenge process, and documentation that states the trust assumptions instead of claiming decentralization it does not have.

## 2. What works (all tested; see section 12 for numbers)

* **Markets and trading:** create markets (creator-allowlisted), buy/sell YES/NO with quotes, slippage limits, trade-size limits and deadlines enforced by the contract. Prices come only from the contract's LMSR, never from the frontend or backend.
* **LMSR in Solidity:** fixed-point log-sum-exp implementation, rounding always in the market's favour, validated against an independent 50-digit `mpmath` reference and by fuzz/invariant tests (collateral always covers every possible payout).
* **Settlement:** resolve, redeem winning shares 1:1, losing shares worthless, voided markets refund by net cost, the creator recovers unspent liquidity; double redemption impossible.
* **Resolution:** evidence-backed proposals (resolver or **anyone with a test-token bond**), challenge window, bonded disputes, a named arbiter, bond settlement and liveness unwinds. **Not a decentralized oracle** (section 10).
* **Real data:** Open-Meteo weather (automated, with provenance, validation, freshness, revisions); RBI/MoSPI/ISRO/cricket records entered by an administrator from official documents (not crawled, labelled as manual).
* **Backend:** FastAPI, Sign-In with Ethereum, an idempotent, crash-safe, reorg-aware event indexer, read models, analytics from indexed records only.
* **Frontend:** wallet connection, dashboard, market discovery, trading panel, create market, portfolio, transactions, analytics, Data Explorer, resolution dashboard, honest empty states, responsive layout.

## 3. System architecture

```mermaid
flowchart LR
    subgraph Browser
        FE["React + wagmi/viem<br/>MetaMask"]
    end
    subgraph Chain["EVM chain (local Hardhat / Sepolia testnet)"]
        TT[TestToken]
        MF[MarketFactory]
        PM["PredictionMarket<br/>(one clone per market)"]
        RM[ResolutionManager]
    end
    subgraph Backend["Python backend (one codebase, three processes)"]
        API["FastAPI API<br/>SIWE, REST"]
        IDX["Indexer<br/>web3.py"]
        DW["Data worker<br/>APScheduler"]
    end
    DB[("PostgreSQL<br/>read model")]
    EXT[("Open-Meteo<br/>+ manual official records")]

    FE -- "signed transactions" --> Chain
    FE -- "reads, SIWE session" --> API
    FE -. "verification reads" .-> Chain
    IDX -- "poll logs, confirmations, reorg checks" --> Chain
    IDX --> DB
    API --> DB
    DW -- "HTTP, retries, rate limits" --> EXT
    DW --> DB
    MF -- deploys --> PM
    RM -- "resolve / invalidate" --> PM
    PM -- "transferFrom / transfer" --> TT
    RM -- "escrows bonds" --> TT
```

The database is a **read model**; contracts are authoritative. The backend holds no signing keys: it cannot create a trade, a market, a resolution or a payout. See [docs/architecture.md](docs/architecture.md).

## 4. Technology stack

Solidity 0.8.28 · Hardhat 3 · OpenZeppelin 5 · PRBMath 4 | Python 3.12 · FastAPI · SQLAlchemy 2 · Alembic · web3.py 7 · SIWE · APScheduler | PostgreSQL 16 | React 19 · TypeScript · Vite · Tailwind 4 · Recharts · wagmi 3 · viem | pytest · Hardhat (Mocha + Solidity fuzz/invariant) · Vitest · Slither | Docker Compose. Versions are pinned in each package's manifest.

## 5. Smart contracts

```mermaid
sequenceDiagram
    actor U as User wallet
    participant T as TestToken
    participant F as MarketFactory
    participant M as PredictionMarket
    participant R as ResolutionManager
    U->>T: faucet()
    Note over U,F: creator funds b·ln2 liquidity
    U->>F: createMarket(params, metadataHash)
    F->>M: clone + initialize (atomic)
    F->>T: transferFrom(creator → market, subsidy)
    U->>M: buy(outcome, shares, maxCost, deadline)
    M->>T: transferFrom(user → market, cost)
    Note over M: now ≥ tradingClose: trading reverts
    U->>R: proposeBonded(market, verdict, evidenceHash) [bond escrowed]
    U-->>R: dispute(...) within the window [matching bond]
    R->>M: resolve(outcome) / invalidate()
    U->>M: redeem() / refund()
```

| Contract | Role |
|---|---|
| `TestToken` | Restricted-transfer test credit with a rate-limited faucet and a hard supply cap. Tokens can only move to/from markets, the factory and the resolution manager, never between people. |
| `MarketFactory` | Creator-allowlisted; deploys and initializes each market as an EIP-1167 clone in one transaction. |
| `PredictionMarket` | Per-market LMSR trading, positions, **collateral/treasury accounting** (merged on purpose, so one market's bug cannot drain another), redemption, refunds. |
| `ResolutionManager` | Evidence-hash resolution, bonds, challenge window, disputes, arbiter, liveness unwinds. |
| `LMSRMath` | Fixed-point cost and price. |

**LMSR.** For a binary market with outstanding shares `qY`, `qN` and liquidity `b`: `C = b·ln(e^(qY/b) + e^(qN/b))`, price `P(Y) = 1/(1+e^(-(qY-qN)/b))`, maximum market-maker loss `b·ln 2`. The contract evaluates the overflow-safe form `C = max(q) + b·ln(1+e^(-|qY-qN|/b))` in 18-decimal fixed point (PRBMath), caps trades at one `b` of shares and price divergence at `20·b`, and adds a small rounding margin so the market is never short. Solvency invariant: `collateral ≥ C(q) ≥ max(qY, qN)`. Details: [docs/smart-contracts.md](docs/smart-contracts.md).

## 6. Resolution and oracle

```mermaid
stateDiagram-v2
    [*] --> Proposed: propose (resolver) / proposeBonded (anyone, escrows bond)
    Proposed --> Finalized: finalize after the window, bond returned
    Proposed --> Disputed: dispute, matching bond + evidence
    Disputed --> Finalized: arbitrate, loser's bond to the winner
    Disputed --> Cancelled: releaseBonds after 14 days
    Finalized --> [*]
```

Trust, stage by stage (full table in [docs/oracle-design.md](docs/oracle-design.md)): Stage 1 trusts a resolver; Stage 2 drafts outcomes from real data for a human to review (the worker holds no key); Stage 3 adds bonds and disputes but, when contested, trusts **one arbiter account**. An undisputed false result is accepted. I studied UMA's optimistic oracle and deliberately did not integrate it (reasons in the oracle doc).

## 7. Real-world data

| Source | Access |
|---|---|
| Open-Meteo (weather) | **Automated**, free non-commercial tier, CC BY 4.0 attribution shown in the UI. Reanalysis model data, *not* station observations; markets must say so. |
| RBI, MoSPI/data.gov.in, ISRO, BCCI/ESPNcricinfo | **Manual**: an administrator submits the official URL, the document's SHA-256, dates and the value. Not crawled (terms restrict it or are unclear); labelled "entered manually, not verified". |

Every record stores provider, exact source URL, retrieval and observation times, raw payload hash (and bytes when we fetched them), normalized value, unit, grid point, transformation, validation status and freshness; revisions never overwrite originals. [docs/data-sources.md](docs/data-sources.md).

## 8. Data flow

```mermaid
flowchart TB
    subgraph Indexing
        C[(Chain)] -->|"eth_getLogs, confirmed blocks only"| L[Indexer batch]
        L -->|"one DB transaction: raw events + derived rows + checkpoint"| P[(PostgreSQL)]
        L -. "checkpoint hash ≠ chain" .-> RB["roll back to common ancestor,<br/>rebuild derived tables by replay"]
    end
    subgraph Data["External data"]
        W[Data worker] -->|"timeouts, retries, throttling"| O[Open-Meteo]
        W --> E[("external_data<br/>append-only")]
        A[Admin submission] -->|"URL + SHA-256 + value"| E
        E --> D["Draft outcome for a human resolver<br/>(nothing sent on-chain)"]
    end
    D --> H[Resolver reviews → evidence hash → wallet signs proposal]
    H --> C
```

## 9. Database

PostgreSQL via Alembic migrations (`backend/migrations`, currently 0001-0005). Token quantities are `NUMERIC(78,0)`, never floats; events are idempotent on `(chain_id, tx_hash, log_index)`; derived tables rebuild from `chain_events`; external data is append-only. See [docs/database.md](docs/database.md).

## 10. API

OpenAPI at `/docs`. Summary table and rules in [docs/api.md](docs/api.md). Authentication is Sign-In with Ethereum with single-use nonces and server-side sessions. The write endpoints only store off-chain documents and return hashes; they cannot bypass contract authorization.

## 11. Run it

### A. Docker Compose (full stack)

```bash
cp .env.example .env            # optional: defaults work for a local test run
docker compose up --build       # first build downloads the Solidity compiler and dependencies
```

Then open http://localhost:5173 (API docs: http://localhost:8000/docs). The chain is an in-memory Hardhat node; the `deployer` service deploys the contracts and writes the addresses that the API, indexer and data worker read, so nothing is copied by hand. To use a wallet: add a network (RPC `http://localhost:8545`, chain id `31337`) and import one of Hardhat's **publicly known** development keys (see the Hardhat docs; account #1 is the market creator, #2 a resolver, #6 the arbiter). Those keys control nothing of value and must never be used on a real network.

> **Verification status:** the compose file, Dockerfiles and entrypoint were written and statically checked (every `depends_on` resolves, ports bind to loopback only, the entrypoint and deployment loader are unit-tested), but **Docker was not available on the machine where this was built, so `docker compose up` itself has not been run.** The non-Docker path below is the verified one.

### B. Without Docker (verified path)

```bash
# 1. contracts (Node.js 22+)
cd contracts && npm install && npx hardhat test            # 68 tests
npx hardhat node                                            # terminal 1: local chain on :8545
npx hardhat run scripts/deploy.ts --network localhost       # terminal 2: writes deployments/local.json

# 2. backend (Python 3.12) - from backend/
python -m venv .venv && . .venv/bin/activate                # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
python ../scripts/make_env.py local --database-url postgresql+psycopg://USER:PASS@localhost:5432/pm   # writes ../.env
python -m alembic upgrade head
uvicorn app.main:app --port 8000                            # API
python -m app.workers.indexer                               # indexer (second terminal)
python -m app.workers.data_worker                           # optional: weather refresh for open markets

# 3. frontend - from frontend/
npm install && npm run dev                                  # http://localhost:5173
```

No PostgreSQL installed? `python scripts/dev_db.py` starts an embedded one and prints a `DATABASE_URL`. A development-only stand-in wallet (open `http://localhost:5173/?devWallet=1`) lets you use the app against the local Hardhat node without a browser extension; it only exists in `npm run dev` builds.

### Tests

```bash
cd contracts && npx hardhat test                            # Solidity fuzz/invariant + Mocha
cd backend   && python -m pytest tests                      # needs Node.js; real chain + real PostgreSQL
cd frontend  && npm test && npm run build                   # component tests + typecheck + production build
cd backend   && python -m pytest -m live tests              # optional: hits the real Open-Meteo API
```

## 12. Verification, security and measurements

* Contracts: **68 tests passing** (5 Solidity fuzz/invariant + 63 Mocha), including LMSR agreement with the 50-digit reference, solvency over random trade sequences, every revert path, and mutation checks that make them fail when the safety margin or the bond accounting is broken.
* Backend: **104 tests passing** (+ 3 live tests that use the real Open-Meteo API), on a real Hardhat node and real PostgreSQL.
* Frontend: **104 tests passing**, type check clean, production build.
* **Slither** found no high or medium issues; one low-severity finding was fixed, the rest are accepted with reasons: [docs/security.md](docs/security.md).
* **Measured performance** (gas, API latency, indexing lag, query timings on a synthetic 200k-trade database, data ingestion): [docs/benchmarks.md](docs/benchmarks.md), reproducible with `scripts/bench.py`.
* The whole lifecycle was also exercised by hand in a real browser (create → trade → resolve → redeem; propose → dispute → arbitrate).

## 13. Known limitations (honest list)

* **Not a decentralized oracle:** one arbiter decides contested results; an undisputed false result is accepted; bonds are cheap in a faucet world.
* **Real MetaMask was not tested**; the browser runs used a development stand-in wallet against the local chain.
* **`docker compose up` has not been run** on the build machine (no Docker); see section 11.
* **No Sepolia deployment was made** (it needs a funded key and RPC that only you can provide); the deploy path and a mainnet refusal guard exist and are documented in [docs/deployment.md](docs/deployment.md).
* Not audited. Slither is not an audit.
* Automated data covers precipitation only; other sources are manual by design. Open-Meteo's free tier is non-commercial.
* No automated browser end-to-end suite and no automated accessibility audit; responsive layout was verified at 375 px by emulation.
* The API's "closed" status uses the server clock (or chain time with `CLOCK_SOURCE=chain`); gating actions use the contract's own clock.

## 14. Legal and test-token disclaimer

Test tokens are simulated credits with no monetary value, restricted so they cannot be transferred between people, with no purchase path and no redemption for anything of value. This design aims to avoid real-money gaming features, **but it has not been reviewed by a lawyer and is not claimed to comply with the Promotion and Regulation of Online Gaming Act, 2025 or its Rules** (references and notes in [docs/legal.md](docs/legal.md)). Do not make it public or commercial without legal review.

## 15. Future improvements

Integrate a decentralized dispute process (e.g. UMA) in place of the single arbiter; an automated watcher that alerts on bad proposals; more automated sources where terms allow (IMD, official statistics APIs); a Playwright E2E suite and automated accessibility checks; code splitting; a hosted Sepolia demo; Foundry-style invariant campaigns with larger run counts; formal review of the fixed-point library bounds.

## Repository map

```
contracts/   Solidity contracts, Hardhat tests, deploy/benchmark/ABI-export scripts, 50-digit LMSR reference
backend/     FastAPI app, indexer and data worker (one package), Alembic migrations, tests
frontend/    React app, component tests
scripts/     bench.py (benchmarks), make_env.py (.env from a deployment)
docs/        architecture, smart-contracts, oracle-design, data-sources, api, database, frontend, security,
             deployment, legal, benchmarks, project-identity, implementation-progress
docker-compose.yml   local test stack
```
