# Deployment

## Local (development)

See the README. In short: `docker compose up --build`, or Hardhat node + `deploy.ts` + `make_env.py` + `alembic upgrade head` + API + indexer + `npm run dev`.

`contracts/scripts/deploy.ts` writes `contracts/deployments/<DEPLOYMENT_NAME>.json` (`registry`, `deployBlock`, `chainId`, issuers). The backend container reads it through `DEPLOYMENT_FILE`; locally `scripts/make_env.py` copies it into `.env`.

## Public testnet (Sepolia)

```bash
export SEPOLIA_RPC_URL=…            # your provider URL
export DEPLOYER_PRIVATE_KEY=…       # a fresh key with test ETH only; never commit it
export ADMIN_TRANSFER_DELAY=172800  # seconds; the default admin handover waits this long
export ISSUERS='[{"address":"0x…","name":"Example Organisation"}]'
cd contracts && npx hardhat run scripts/deploy.ts --network sepolia
```

`deploy.ts` refuses any chain id other than 31337 and 11155111 before sending a transaction; there is intentionally no mainnet network in `hardhat.config.ts`. Make the deployer's admin a multisig or transfer the admin role (`beginDefaultAdminTransfer` / `acceptDefaultAdminTransfer`) before real use.

## Backend

Run `alembic upgrade head`, then the API and **one** indexer process. Recommended production settings:

| Variable | Value |
|---|---|
| `INDEXER_CONFIRMATIONS` | ~12 on a public network (reorgs are still handled by rollback) |
| `COOKIE_SECURE` | `true`, behind HTTPS |
| `SIWE_DOMAIN`, `SIWE_URI_PREFIX`, `ALLOWED_ORIGINS` | the real frontend origin |
| `STORAGE_DIR` | a persistent, backed-up volume (or implement the `Storage` protocol for object storage) |
| `RPC_URL` / `PUBLIC_RPC_URL` | private provider URL for the backend; a key-free or origin-restricted URL for browsers |
| `RATE_LIMIT_*` | tune per deployment; behind a proxy, make sure the real client IP reaches the app |

## Frontend

`VITE_API_URL=<api origin> npm run build`, then serve `frontend/dist` (the Dockerfile uses nginx with a SPA fallback and security headers). The app loads chain id, RPC URL and the registry address from `GET /config` at start-up, so one build works for any deployment.

## Backups

`scripts/backup-db.sh` / `restore-db.sh` for the compose database; back up the document storage volume as well. The chain itself is the durable record of registrations; the read model can be rebuilt from it.
