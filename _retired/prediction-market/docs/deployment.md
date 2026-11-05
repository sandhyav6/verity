# Deployment (Phase 7)

TEST-ONLY. Never a production network. `contracts/scripts/deploy.ts` refuses every chain id except 31337 (local) and 11155111 (Sepolia), before sending any transaction.

## What was verified and what was not

| Path | Status |
|---|---|
| Local, no Docker (Hardhat node + PostgreSQL + API + indexer + Vite) | **Verified** repeatedly: automated tests and manual browser runs |
| `docker compose up` | **Written and statically checked, not run.** Docker was not installed on the machine this was built on. Checks done: compose YAML structure (every `depends_on` resolves, volumes declared, all published ports bind to `127.0.0.1`), the entrypoint script (sourcing a deployment file, not overriding preset variables, failing loudly if the file is missing), the deployment loader (unit tests), and the deployed-check script. Not checked: image builds, healthchecks, service start order at runtime, the nginx config. Expect to fix small things on the first real run. |
| Sepolia deployment, hosted frontend/backend, managed PostgreSQL | **Not done.** They need accounts, a funded key and an RPC provider that only you can supply. Steps are below. |

## 1. Docker Compose (local test stack)

```bash
cp .env.example .env      # optional
docker compose up --build
```

| Service | Role |
|---|---|
| `postgres` | PostgreSQL 16, named volume `pgdata`, healthcheck `pg_isready` |
| `hardhat-node` | in-memory local chain (resets on restart) |
| `deployer` | one-shot: skips if the recorded deployment is still live (`scripts/check-deployed.mjs`), otherwise deploys and writes `compose.json` to the shared `deployments` volume |
| `api` | applies migrations (`RUN_MIGRATIONS=1`), serves FastAPI; healthcheck on `/health` |
| `indexer`, `data-worker` | start only after the API is healthy (so the schema exists); read contract addresses and the start block from the deployment file |
| `frontend` | static build served by nginx on :5173 |

Start order is enforced with `depends_on` conditions: `postgres` healthy and `deployer` completed successfully before `api`; `api` healthy before the workers and the frontend. All long-running services use `restart: unless-stopped`; the deployer does not restart.

Resetting: `docker compose down -v` removes the database and the deployment record. Restarting only `hardhat-node` resets the chain; the deployer then redeploys and the indexer detects the missing checkpoint block and rebuilds its read model from the new chain.

## 2. Environment variables

The full commented list is [`.env.example`](../.env.example). The important ones:

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | SQLAlchemy URL (`postgresql+psycopg://…`) |
| `RPC_URL` / `PUBLIC_RPC_URL` | the backend's node URL / the key-free URL browsers use. Never put a provider key in `PUBLIC_RPC_URL` |
| `CHAIN_ID`, `CHAIN_NAME`, `EXPLORER_TX_URL` | network identity (explorer link for testnets) |
| `FACTORY_ADDRESS`, `RESOLUTION_MANAGER_ADDRESS`, `TOKEN_ADDRESS`, `START_BLOCK` | from the deployment record (`scripts/make_env.py` or the container entrypoint fills them) |
| `INDEXER_CONFIRMATIONS` | 1 locally; about 12 on Sepolia |
| `SIWE_DOMAIN`, `SIWE_URI_PREFIX` | must equal the frontend's host and origin exactly, or logins fail |
| `COOKIE_SECURE`, `ALLOWED_ORIGINS`, `PUBLIC_API_URL` | set for the real hosts; `COOKIE_SECURE=true` behind HTTPS |
| `ADMIN_ADDRESSES` | wallets allowed to open off-chain admin tools (manual data entry) |
| `RATE_LIMIT_*` | request limits |
| `CLOCK_SOURCE` | `wall` (default) or `chain` (local time-travel testing only) |
| `VITE_API_URL` (frontend build) | the API address **as the browser reaches it** |

## 3. Optional public demo on Sepolia (you must do this part)

Nothing below has been executed. Use a throwaway deployer key that holds only test ETH, kept in your shell or a secret store, never in git.

1. Get a Sepolia RPC URL and test ETH for a new deployer account.
2. Decide role accounts: admin (deployer), market creator(s), resolver, arbiter. Use **distinct** accounts; for anything shared, make admin and arbiter multisigs.
3. Deploy (from `contracts/`):
   ```bash
   export SEPOLIA_RPC_URL=...  DEPLOYER_PRIVATE_KEY=0x...     # PowerShell: $env:SEPOLIA_RPC_URL = "..."
   export CREATOR=0x...  RESOLVER=0x...  ARBITER=0x...          # role accounts
   export BONDED_WINDOW=3600  BOND_TOKENS=100  DEPLOYMENT_NAME=sepolia
   npx hardhat run scripts/deploy.ts --network sepolia
   ```
   The script prints and records the addresses in `deployments/sepolia.json`, and mints the creator's funding tokens. (It also assumes the deployer is the `TestToken` owner, which can then `renounceMinting()` once creators are funded.)
4. Backend: `python scripts/make_env.py sepolia`, then set `CHAIN_ID=11155111`, `CHAIN_NAME=Sepolia`, `RPC_URL`, `PUBLIC_RPC_URL`, `INDEXER_CONFIRMATIONS=12`, `EXPLORER_TX_URL=https://sepolia.etherscan.io/tx/`, `SIWE_DOMAIN`/`SIWE_URI_PREFIX` for the frontend host, `COOKIE_SECURE=true`, `ALLOWED_ORIGINS`, `ADMIN_ADDRESSES`.
5. Host the backend (any container host) with a managed PostgreSQL, run `alembic upgrade head`, start the API, the indexer and the data worker.
6. Build and host the frontend (`VITE_API_URL` = the public API URL) behind HTTPS.
7. Put a reverse proxy in front of the API and make sure client IPs reach the rate limiter correctly.

## 4. Backup and restore

```bash
scripts/backup-db.sh                         # compose stack: writes backups/pm-<timestamp>.sql.gz
scripts/restore-db.sh backups/pm-XXXX.sql.gz # restores into the compose database (stops writers first)
```

Because the database is a read model of the chain, the worst case after losing it is a re-index from the start block (`indexer` rebuilds everything from events); only **off-chain data cannot be re-derived**: market metadata, resolution evidence documents, external data records, users and sessions. Those are what a backup protects.

## 5. Operations

* `python -m app.workers.reconcile` compares the database with the chain at the indexer's checkpoint and exits non-zero on drift.
* Upgrades: new migrations are applied by the API container on start (`RUN_MIGRATIONS=1`). Contracts are not upgradeable: a contract change means a new deployment and a new indexer database.
* Monitor `/health` (database and indexer checkpoint), indexer logs for `reorg detected`, and data-worker logs for provider failures.
