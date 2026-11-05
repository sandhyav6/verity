# Implementation progress

Project rule: Claude never runs `git add/commit/push`; the owner makes all commits.

## Phase 0 — Requirements and architecture

- **Status:** approved by owner with revisions (all applied in `docs/architecture.md`).
- **Files:** `docs/architecture.md`, `docs/implementation-progress.md`.

## Phase 1 — Smart contract foundation

- **Status:** implemented; all local contract tests pass. Phase 1 is *not* signed off until the owner reviews it.
- **Completed:** TestToken (restricted transfer, faucet, cap), MarketFactory (clones), PredictionMarket (LMSR buy/sell, collateral, redeem, refund, residual), ResolutionManager (Stage 1 with evidence hash and challenge window), LMSRMath (log-sum-exp, PRBMath), independent `mpmath` reference and vectors, Hardhat Mocha tests, Solidity fuzz/invariant tests.
- **Files created:**
  - `.gitignore`
  - `contracts/package.json`, `tsconfig.json`, `hardhat.config.ts`
  - `contracts/contracts/{TestToken,MarketFactory,PredictionMarket,ResolutionManager,IPredictionMarket}.sol`, `lib/LMSRMath.sol`, `test/LMSRHarness.sol`
  - `contracts/reference/lmsr_ref.py`, `contracts/reference/vectors.json` (generated, deterministic)
  - `contracts/test/{helpers,lmsr.test,token-factory.test,trading.test,settlement.test}.ts`, `contracts/test/Solvency.t.sol`
  - `docs/smart-contracts.md`
- **Files modified:** `docs/architecture.md` (resolved decisions, Hardhat 3 native fuzz replaces Foundry).
- **Commands run** (from `contracts/`): `npx hardhat compile`, `python -I reference/lmsr_ref.py`, `npx hardhat test` (runs both suites).
- **Results (actual):** `46 passing (5 solidity, 41 mocha)`, 0 failing. Solidity fuzz/invariants: 256 runs each.
  - Worst `cost()` error vs 50-digit reference: 1,283,009 wei (margin at that `b`: 1.0e11 wei). Worst price error: 1 unit of 1e-18.
  - 180 random buy/sell operations across 3 sequences (b = 10, 100, 100,000): contract collateral ≥ true LMSR cost after every step.
- **Verification beyond "tests pass":** mutation check — setting the rounding margin and subsidy margin to zero made 6 tests fail (reference comparison, subsidy, round-trip, sequence solvency, fuzz round trip). Note: `invariant_collateralCoversWorstCase` did *not* catch it; the reference-based tests do the real solvency work.
- **Bug found and fixed during the phase:** `residual()` ignored tokens already paid to winners/refund claimants (creator would be underpaid if claiming after redemptions). Fixed with `reservedClaims`; regression test added.
- **Known issues / limits:** see `docs/smart-contracts.md` (not audited, Slither not run, refund-shortfall branch untested, no Sepolia scripts, deployment gas not measured).
- **Environment notes:**
  - Docker Desktop's daemon was not running, so everything ran locally on Node v24.14.1 (Hardhat 3.21.2 worked fine) instead of the planned Node 22 container.
  - `contracts/node_modules` is a junction to a folder outside OneDrive (`%LOCALAPPDATA%\pm-cache\contracts\node_modules`). `npm install` replaces the junction with a real folder; if you run it, move the folder back. A fresh clone elsewhere needs a plain `npm install`, with no junction.
  - Solidity compiler warns about transient storage in OpenZeppelin's `ReentrancyGuardTransient` (the documented-safe use for reentrancy guards).
- **Outstanding:** Slither (Phase 6), gas benchmark script (Phase 6), deploy scripts (Phase 2/7), owner review of contract design.
- **Next step:** on approval, Phase 2 — FastAPI, PostgreSQL schema and Alembic migrations, SIWE auth, blockchain client and event indexer.

## Phase 2 — Backend, database, auth, indexer

- **Status:** implemented; all local tests pass. Not signed off until the owner reviews it.
- **Completed:** FastAPI app; PostgreSQL schema via Alembic; SQLAlchemy models; SIWE login with single-use nonces and server-side sessions; read-only web3.py client; polling event indexer (confirmations, atomic batches, idempotent, crash-safe, reorg rollback with full rebuild); reconciliation check (DB vs chain); market/portfolio/analytics/transaction/resolution API; evidence bundle hashing; contract `deploy.ts` and ABI export script.
- **Files created:**
  - `contracts/scripts/{deploy,export-abi}.ts`; `contracts/hardhat.config.ts` modified (adds a `localhost` network)
  - `backend/app/{main.py}`, `core/{config,logging,security}.py`, `database/{base,connection}.py`
  - `backend/app/models/{user,market,trade,position,chain,resolution}.py`
  - `backend/app/blockchain/{client,contract_registry,event_listener,event_processor,reconcile,transaction_service}.py` and `abi/*.json` (exported from the compiled contracts)
  - `backend/app/schemas/*`, `services/{market,portfolio,analytics,resolution}_service.py`, `api/deps.py`, `api/routes/{auth,markets,portfolio,analytics,transactions,resolutions}.py`
  - `backend/app/workers/{indexer,reconcile}.py`, `backend/scripts/dev_db.py`
  - `backend/alembic.ini`, `migrations/{env.py,script.py.mako,versions/0001_initial_schema.py}`
  - `backend/requirements.txt`, `requirements-dev.txt`, `backend/tests/{conftest,helpers,test_auth,test_markets_api,test_indexer,test_lifecycle_e2e}.py`
  - `.env.example`, `docs/api.md`, `docs/database.md`; `.gitignore` extended
- **Tests run (actual):**
  - `contracts/`: `npx hardhat test` -> 46 passing (5 solidity, 41 mocha); unchanged by Phase 2.
  - `backend/`: `python -m pytest tests` -> **43 passed** (11 auth, 23 market API incl. 16 validation cases + idempotence + rate limit, 8 indexer, 1 end-to-end lifecycle). Tests use a real Hardhat node, the real deploy script, real contracts and real PostgreSQL 16 (embedded `pgserver`), with the schema built from the Alembic migration on every run.
- **What the tests prove:** SIWE rejects replayed/forged/expired nonces, wrong signer, wrong domain, wrong chain id, expired and tampered messages; the indexer is idempotent, resumes after a mid-batch crash with nothing half-applied, stores only events from known contracts, matches the contract's price after every trade, indexes resolved and voided markets, and recovers from a real chain reorganisation (Hardhat `evm_snapshot`/`evm_revert`) with `reconcile` reporting no drift; the lifecycle test walks login -> create -> trade -> index -> close -> evidence -> resolve -> redeem -> portfolio/analytics and checks on-chain balances to the wei.
- **Bugs found during the phase:** (1) `siwe 4.4.0` crashes against `abnf >= 2.9.0` -> pinned `abnf==2.8.3`; (2) analytics `GROUP BY` on a parameterised `CASE` failed in Postgres -> group by label; (3) my replay test had wrongly triggered the reorg path (test fixed, indexer correct).
- **Environment notes:** Docker Desktop's CLI disappeared mid-phase (its installer was running), so tests use embedded Postgres instead; set `TEST_DATABASE_URL` to use any Postgres/Docker instance. A `pm-postgres` container I started earlier may still exist in Docker (port 5433); stop/remove it with `docker rm -f pm-postgres` if you don't want it. Python 3.12 venv lives outside OneDrive (`%LOCALAPPDATA%\pm-cache\backend-venv`); Python 3.14 was not tried.
- **Known limitations:**
  - No Docker image/compose yet (Phase 7); no database backup procedure yet (Phase 7).
  - Rate limiting is verified only on `/auth/*`; the default limit applies elsewhere but is untested.
  - The API derives `closed` from the server clock; `reconcile` is a manual CLI, not scheduled.
  - Faucet/token events are not indexed (balances are read live from the chain).
  - Reorg handling rebuilds all derived tables (correct but O(events)).
  - The backend never signs transactions, so market creation and resolution depend on the user's wallet (by design).
  - Tests use the public Hardhat dev private keys for accounts #1/#2 (local chain only).
  - `GET /data/*` endpoints, an in-backend LMSR quote service (`pricing_service`) and admin-dashboard endpoints are not built (Phases 3-5).
- **Next step:** on approval, Phase 3 — real-world data adapters (Open-Meteo weather first), provenance records, freshness, evidence creation from real data.

## Phase 3 — Real-world data integration

- **Status:** implemented; tests pass; not signed off until the owner reviews it. Contracts were not touched.
- **Source spike first (details in `docs/data-sources.md`):** only **Open-Meteo** is automated (documented API, CC BY 4.0, non-commercial free tier). RBI (rights reserved, caching/framing prohibited), MoSPI (TLS cert error from my fetcher), data.gov.in (HTTP 403), ISRO (no feed, terms unreadable) and cricket (terms unchecked) are **manual, hash-anchored submissions by an admin; the backend never crawls them.** This deviates from the Phase 0 plan of "adapters fetch RBI/MoSPI/ISRO documents" and I think it is the safer reading of "do not scrape in violation of terms".
- **Findings from the live API:** requested points are snapped to a 0.25-degree grid (recorded per record); the newest ~6 days are `null` (handled as `incomplete`, total withheld); rate-limit headers are honoured.
- **Completed:** `external_data` table (migration 0002); adapters (`weather.py`, shared `manual.py` plus thin `rbi/mospi/isro/cricket.py`); HTTP layer with timeouts, retry/backoff, `Retry-After`, throttling, provider-budget wait, no fallback; append-only store with duplicate/revision detection; freshness; `/data/*` API (listing per category, sources status, record + revisions, raw bytes by hash, admin submissions and refresh); data worker (APScheduler, advisory lock, only periods that active markets need); optional structured `data_rule` on weather markets with a guard against promising IMD/station data; Stage 2 **draft-from-data** endpoint (human review required, stores no evidence, sends nothing on-chain).
- **Files created:** `backend/app/data_sources/{http,base,weather,manual,rbi,mospi,isro,cricket}.py`, `models/external_data.py`, `schemas/data.py`, `services/data_ingestion_service.py`, `api/routes/data.py`, `workers/data_worker.py`, `migrations/versions/0002_external_data.py`, `backend/pytest.ini`, `tests/{data_fixtures,test_data_sources,test_data_store_api,test_resolution_draft,test_live_open_meteo}.py`, `docs/data-sources.md`.
- **Files modified:** `schemas/market.py` (data_rule), `services/market_service.py`, `services/resolution_service.py` (drafts), `api/routes/resolutions.py`, `api/deps.py`, `main.py`, `models/__init__.py`, `requirements.txt` (httpx, apscheduler), `docs/{api,database}.md`.
- **Tests run (actual):** `python -m pytest tests` -> **88 passed, 2 deselected** (17 adapter/HTTP unit tests, 27 storage/API/worker tests, 1 Stage 2 integration test on a real chain, plus the 43 from Phase 2). Weather API responses are mocked in unit tests (labelled fixtures; shape copied from a real response). `python -m pytest -m live` -> **2 passed** against the real Open-Meteo API: a settled Chennai period came back `valid` (4.2 mm for 5-15 Sep 2026, grid 13.0/80.25, 656 ms) and the most recent days came back `incomplete`.
- **What the tests prove:** exact decimal sums; incomplete/invalid data is stored but labelled and never turned into a total; retries, `Retry-After`, throttling and bounded failure with no fallback host; duplicate vs revision vs revert (A->B->A) with originals preserved and a revision-chain endpoint; manual submissions reject wrong/lookalike hosts, http, bad hashes, future dates, implausible values, publication before the reported period; admin-only writes; external data never leaks into blockchain analytics; worker refreshes only what markets need, survives provider failure, skips when another instance holds the lock; drafts require the resolver role and a closed market, tie on threshold -> NO with a warning, incomplete -> wait, then INVALID after the deadline, provider outage -> 503, garbage -> 409, and a reviewed draft goes all the way to an on-chain YES resolution with the evidence hash re-computable from the stored bytes.
- **Bugs found:** the same decimal serialised differently fresh vs read back (now quantized); a mis-set publication-date rule for match results (match results are dated by the match). My first shell heredoc for the test files broke on quoting (switched to file writes).
- **Known limitations:** only precipitation (no temperature yet); no IMD station data; the Data Explorer is empty until an admin triggers a refresh, a weather market exists or a record is submitted, and I deliberately pre-loaded nothing (the RBI homepage showed a 5.50 % repo rate when I fetched it, but a model-summarised page is not a record to enter on anyone's behalf); manual records rely on the submitter's honesty (the document hash proves what was archived, not that the value was transcribed correctly); free-tier Open-Meteo is non-commercial only; terms for several sources were read only through fetched summaries, not the full legal text.
- **Next step:** Phase 4 — React frontend (wallet connection, markets, trading with on-chain quotes, create market, portfolio, transactions, analytics, Data Explorer showing attribution/freshness/validation, admin resolution dashboard).

## Phase 4 — Frontend

- **Status:** implemented, tested and exercised end to end in a real browser; not signed off until the owner reviews it. Contracts unchanged (the ABI export script gained a TypeScript output).
- **Completed:** React/TypeScript/Vite/Tailwind/Recharts/wagmi/viem app with all ten required areas: dashboard, explore (search, filters, sort, pagination), market details with probability chart, **trading panel** (browser estimate and contract quote shown separately, slippage, confirm step, wrong-network and wallet states, double-submit guard, readable failures), create market, portfolio (with redeem/refund/claim in the settlement panel), transaction history with live status, analytics, Data Explorer (provenance, freshness, validation, attribution, daily rainfall chart from stored raw data), and the admin/resolution dashboard (draft from data, evidence, on-chain propose and finalize, manual record entry). Wallet sign-in via SIWE. Persistent test-token disclaimer; no currency symbols.
- **Backend additions needed by the UI:** `GET /config` (no secrets; the private RPC URL is never exposed), `GET /trades`, `server_time` on resolutions, opt-in `CLOCK_SOURCE=chain` for local time-travel testing, `PUBLIC_RPC_URL`/`CHAIN_NAME` settings.
- **Files created:** everything under `frontend/` (config, `src/{lib,blockchain,hooks,components,charts,pages,dev,test}`, `.env.example`, `package-lock.json`), `contracts/scripts/export-abi.ts` extended, `backend/app/{core/clock.py,api/routes/{meta,trades}.py}`, `docs/frontend.md`. **Modified:** `backend/app/{main.py,core/config.py,schemas/resolution.py,services/{market,resolution}_service.py}`, `backend/tests/{test_markets_api,test_lifecycle_e2e}.py`, `.env.example`, `docs/api.md`.
- **Tests run (actual):**
  - `frontend/`: `npm test` -> **90 passed** (4 files); `npx tsc --noEmit` -> clean; `npx vite build` -> built (1.14 MB main chunk, 332 kB gzip).
  - `backend/`: `python -m pytest tests` -> **91 passed, 2 deselected** (live tests).
  - The frontend's indicative LMSR agrees with the 50-digit mpmath vectors (cost to 1e-9 relative, price to 1e-12).
- **Verified by hand in the in-app browser (not automated):** the full lifecycle through the UI with the dev wallet against a local chain, backend and indexer: connect, SIWE sign-in, create a market via the form, faucet, buy YES (estimate = contract quote = 13.2792 tokens; balance fell by exactly that), probability 50.0% -> 56.2%, on-chain verification all matching, resolver role detection, evidence + proposal + finalize, redeem (+20.00 for 20 YES shares), loser sees "Nothing to redeem", portfolio P&L equal to the balance change, real Open-Meteo record and an incomplete one in the Data Explorer, backend-down screen, and a 375 px viewport without horizontal overflow. Details in `docs/frontend.md`.
- **Bugs found and fixed:** (1) my first `useTx` swallowed simulation errors, defeating pre-wallet revert messages (caught in review); (2) the API's "closed" came from the wall clock while the dev chain's clock had been advanced, so the UI said "Trading open" for a market the contract had closed (found in the browser; fixed with `CLOCK_SOURCE=chain`); (3) the Finalize button compared the challenge deadline with the browser's clock (fixed: uses the API's `server_time`); (4) faucet transactions showed "indexing…" forever because token events are intentionally not indexed (labels now say "confirmed" and add "indexed" only when true); (5) price-chart x-axis showed identical dates for minute-scale histories (now clock times); (6) wagmi v3 renamed `useAccount` -> `useConnection` and `writeContractAsync` -> `mutateAsync` (checked in the installed package before use). Test-side: a timezone-dependent date fixture, ambiguous selectors, a nested router.
- **Known limitations:** real MetaMask not tested; no automated browser E2E (Playwright) suite; no automated accessibility audit; responsive check is emulation at 375 px only; one 1.14 MB bundle (no code splitting); dark mode follows the OS only; the dev wallet is development-only and not a substitute for a real wallet; `docker compose` deployment of the frontend is Phase 7.
- **Environment notes:** `frontend/node_modules` is a junction to `%LOCALAPPDATA%\pm-cache\frontend\node_modules` (outside OneDrive); `npm install` inside `frontend/` replaces it with a real folder, so move it back or install in the cache folder and re-link. Hardhat node, API, indexer, Vite and the dev database that I started for the browser run have all been stopped.
- **Next step:** on approval, Phase 5 — oracle and settlement: automated data-backed proposals are drafted already (Stage 2), so the work is the challenge period, dispute mechanism and the optimistic-oracle decision (including the UMA documentation review the brief asks for) with matching contract, backend and UI changes.

## Phase 5 — Oracle and settlement

- **Status:** implemented, tested and exercised end to end in a real browser; not signed off until the owner reviews it.
- **UMA review first (as the brief requires):** read docs.uma.xyz as far as the pages allowed. Decision: **no UMA integration**; an in-house, UMA-inspired bonded mechanism with a **named arbiter** instead of a token-holder vote. Reasons, what I could not verify, and how to swap UMA in later are in `docs/oracle-design.md`.
- **Completed (contracts):** `ResolutionManager` rewritten with bonded proposals by anyone (`proposeBonded`), a challenge window, bonded `dispute`, `arbitrate` (loser's bond to the winner; arbiter may not be a party or the market creator), `releaseBonds` (14-day arbiter timeout, or market settled elsewhere), parameter bounds and snapshotted dispute bonds, escrow accounting invariant. The Stage 1 resolver path is unchanged. `TestToken.setResolutionManager` lets the manager escrow bonds. `ResolutionProposed` gained a `bond` field. Deploy script grants `ARBITER_ROLE` (local default: account #6).
- **Completed (backend):** indexer handles `ResolutionDisputed`, `DisputeResolved`, `BondsReleased`; migration 0003; evidence `kind`; `POST /resolutions/{id}/propose?bonded=true`, **`POST /resolutions/{id}/dispute`**, `POST /resolutions/{id}/arbitration-note`; resolution view carries bonds, disputes, arbiter. **Completed (frontend):** `OraclePanel` (challenge, finalize, arbiter, release), bonded proposing on the dashboard, richer resolution history.
- **Files created:** `contracts/test/oracle.test.ts`, `backend/migrations/versions/0003_oracle_bonds_and_disputes.py`, `backend/tests/test_oracle_flow.py`, `frontend/src/components/{OraclePanel,EvidenceForm}.tsx` (+ `OraclePanel.test.tsx`), `docs/oracle-design.md`. **Modified:** `contracts/contracts/{ResolutionManager,TestToken}.sol`, `contracts/scripts/deploy.ts`, `contracts/test/{helpers.ts,settlement.test.ts,Solvency.t.sol}`, backend `models/resolution.py`, `blockchain/{contract_registry,event_processor,transaction_service}.py`, `schemas/resolution.py`, `services/resolution_service.py`, `api/routes/resolutions.py`, `tests/{conftest,test_lifecycle_e2e}.py`, frontend `pages/{Admin,MarketDetail}.tsx`, `lib/types.ts`, `lib/types`, docs (`api`, `database`, `frontend`, `smart-contracts`).
- **Tests run (actual):** contracts `npx hardhat test` -> **67 passing** (5 solidity + 62 mocha, of which 21 are new oracle tests); backend `python -m pytest tests` -> **99 passed, 2 deselected**; frontend `npm test` -> **104 passed**, `tsc --noEmit` clean, `vite build` OK. Gas (single runs): `proposeBonded` 233,343; `dispute` 109,361; `arbitrate` 125,095; bonded `finalize` 113,795.
- **Mutation check:** making the arbiter always pay the proposer made 2 oracle tests fail; not reducing the escrow counter made 3 fail; both were reverted.
- **Verified by hand in the in-app browser (not automated):** with a fresh local chain: wallet #7 (not a resolver) proposed YES with a 100-token bond; wallet #5 disputed with its own evidence (also 100); the arbiter (#6) saw both sides and ruled NO with written reasoning. On-chain afterwards: proposer 1,000 -> 900, challenger 1,000 -> 1,100, escrow 0, market resolved NO, proposal `finalized / overturned`, every evidence hash verified; the market page showed the whole history.
- **Bugs found:** a test expectation that mis-ordered two correct refusals (`MarketNotResolvable` precedes `ProposalExists` on a resolved market); my test helper built market times from the wall clock while earlier tests had advanced the chain (`InvalidTimes`); a shell heredoc quoting failure (patches moved to script files).
- **Known limitations:** single trusted arbiter and no appeals; an undisputed false result is accepted and no watcher/alerting exists; bonds are cheap because the faucet is open (a demonstration, not a deterrent); resolver proposals with window 0 cannot be disputed (dev mode); no game-theoretic analysis of the incentives; not audited (Slither is Phase 6); the arbiter UI was exercised through the dev wallet, not MetaMask; the dev database kept Phase 4 evidence because evidence is keyed by market address and the fresh chain reused the same deterministic address (harmless, by design). The brief's `disputes` table was folded into `resolution_proposals` (one dispute per proposal by contract design).
- **Next step:** on approval, Phase 6 — integration and security: Slither on the contracts, a reproducible gas/latency benchmark script with recorded results, the full lifecycle and indexer-restart scenarios, and fixing whatever the analysis finds.

## Phase 6 — Integration and security

- **Slither** (0.11.6, solc 0.8.28) on all four contracts: **no high/medium findings**. One low finding fixed (`PredictionMarket.initialize` zero-address checks, with a test); the rest accepted with reasons in `docs/security.md`.
- **Benchmarks:** `scripts/bench.py` (reproducible; starts its own throwaway stack) and `contracts/scripts/benchmark-gas.ts`; results in `docs/benchmarks.md` and `docs/benchmarks/results.json`. The benchmark **found real problems**: `analytics per-market` took 1,272 ms and `analytics overview` 346-681 ms at 200k synthetic trades (full-table aggregates). Fixed: per-market 1,272 -> 22 ms (trader counts from `positions`, only for the page); overview now reads totals from per-market counters and the daily chart from a new `daily_activity` rollup maintained by the indexer (migration 0005, backfilled; rebuilt on reorg; a test proves the rollup equals the real trades, including after a reorg). Also added `positions(wallet_address)` index (0004).
- **Live real-data lifecycle test** (`tests/test_live_lifecycle.py`, marked `live`): real Open-Meteo data -> draft -> evidence -> on-chain proposal -> resolution -> redemption, on a real chain and database. This closes the brief's "retrieve real-world data" lifecycle step (the default lifecycle test uses a labelled fixture).
- **Other findings fixed:** evidence documents could be flooded by any signed-in wallet (now capped per wallet/market/kind, tested); `mpmath`/Slither were missing from `requirements-dev.txt`; the deploy script now refuses every chain except local and Sepolia (tested against a fake RPC claiming chain 1).
- **Unexplained:** indexing lag measured 765-1,003 ms with a 0.2 s poll interval, although a profiled indexer cycle takes about 155 ms (18 ms idle) and RPC calls take 4-11 ms. I suspect single-machine contention (five processes at once) but did not prove it; it is reported as measured.

## Phase 7 — Docker and deployment

- **Written:** `backend/Dockerfile` (+ entrypoint that loads contract addresses from the deployment file and applies migrations), `contracts/Dockerfile` (chain + deployer), `frontend/Dockerfile` + `nginx.conf`, `docker-compose.yml` (postgres, hardhat-node, deployer, api, indexer, data-worker, frontend; healthchecks, ordered `depends_on`, volumes, loopback-only ports, restart policies), `.dockerignore` files, `scripts/{backup-db,restore-db}.sh`, `scripts/make_env.py`, `docs/deployment.md`.
- **Verification actually done:** compose YAML structure checked programmatically; entrypoint logic run in `sh`; deployment loader unit-tested; deployed-check script and mainnet guard exercised; everything else verified from a **clean copy** of the repository (see below).
- **NOT done, stated plainly:** Docker was not installed on the build machine, so **`docker compose up` was never run**: image builds, in-container healthchecks, runtime start order and nginx were not tested, and the restore script was not run against a database. No Sepolia deployment, hosted frontend/backend or managed PostgreSQL (they need your accounts and a funded key); the steps are in `docs/deployment.md`.

## Phase 8 — Final review and project identity

Reviewed as a senior interviewer would:

| Concern | Status |
|---|---|
| Single arbiter, undisputed false results accepted, cheap bonds | inherent to the design; documented prominently (README, UI, `oracle-design.md`); the largest remaining weakness |
| Docker path unverified | stated everywhere it matters; first real run may need small fixes |
| Real MetaMask / automated browser E2E / accessibility audit not done | stated; component tests plus manual browser runs only |
| No Content-Security-Policy; rate limiting behind a proxy needs forwarded-header handling | documented in `security.md` |
| One 1.14 MB frontend bundle | documented; code splitting is future work |
| Indexing lag higher than the profile explains | reported, not hidden |
| Unnecessary complexity | none removed wholesale; the rollup table and the oracle panel exist because measurement or requirements demanded them; late imports and a stray debug read were cleaned up earlier |
| Documentation accuracy | README/security/deployment/benchmarks written from measured facts; the Phase 0 doc now carries an "as built" notice; test counts in the README were re-verified on a clean copy |

**Name recommendation:** *Andaaza* (everyday Hindi/Urdu for "estimate"; uncommon Sanskrit names were ruled out on request), with alternatives and cautions in `docs/project-identity.md`. The code and UI remain unnamed until you decide; trademark/domain availability was not checked.

### Final verification (clean copy of the repository, installed from manifests only)

Run on 2026-11-05 from a copy of tracked + untracked-not-ignored files, with `npm ci` / `pip install -r requirements-dev.txt` only:

| Stage | Result |
|---|---|
| Contracts `hardhat test` | 68 passing (5 Solidity + 63 Mocha) |
| Frontend `tsc --noEmit`, `vitest`, `vite build` | type check clean; 104 passed; build ok |
| Backend `pytest` (default, real Hardhat node + real PostgreSQL) | 104 passed, 3 live tests deselected |
| Backend `pytest -m live` (real Open-Meteo) | first run: 2 passed, 1 failed; the failure was a test bug (it asked for an `end_date` of today, which the provider rejects with HTTP 400 when its latest date is yesterday). Test fixed to end yesterday; re-run in the working tree: 3 passed. The clean copy was not repeated after that one-line test change. |

Not verified: `docker compose up` (Docker is not installed on this machine; compose, Dockerfiles and the entrypoint were validated statically and the loader/entrypoint logic was unit-tested), a Sepolia deployment, a real MetaMask session. Known behaviour: asking the data API for a period that ends after the provider's latest date returns a 502 (provider rejection) rather than an `incomplete` record.

## How to run Phase 2 (from `backend/`, Python 3.12)

```bash
python -m venv .venv && .venv/Scripts/activate        # Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
python -W ignore -m pytest tests                       # needs Node.js for the Hardhat node; ~2-3 minutes
# manual run against a local node:
#   (contracts/) npx hardhat node          then   npx hardhat run scripts/deploy.ts --network localhost
#   copy addresses from contracts/deployments/local.json into .env (see .env.example)
#   python -m alembic upgrade head
#   python -m app.workers.indexer          # indexer
#   uvicorn app.main:app --reload          # API on :8000
#   python -m app.workers.reconcile        # DB vs chain check
```

## How to run the Phase 1 tests (from `contracts/`)

```bash
npm install          # first time only, in a fresh clone
npx hardhat test     # expect: 5 solidity + 41 mocha passing
python -I reference/lmsr_ref.py   # optional: regenerate vectors (needs mpmath)
```
