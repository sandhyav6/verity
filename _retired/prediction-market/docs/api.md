# API (Phase 2, as implemented)

FastAPI; interactive docs at `/docs` and `/openapi.json` when the server runs. TEST tokens only. Every list endpoint returns `{items, total, limit, offset}`; wei-scale quantities are strings; errors are `{"detail": "..."}`.

Auth is Sign-In with Ethereum: `GET /auth/nonce` -> sign the EIP-4361 message in the wallet -> `POST /auth/verify` -> `HttpOnly` session cookie (a `Bearer` header also works). Checks: signature, domain, chain id, URI, issued-at/expiry, single-use unexpired nonce (burned atomically).

| Method + path | Auth | Notes |
|---|---|---|
| `GET /auth/nonce`, `POST /auth/verify`, `GET /auth/me`, `POST /auth/logout` | - | rate limited (10/min) |
| `GET /markets` | - | filters `category`, `status` (active/closed/resolved/invalid), `q` (question search); `sort` (created_at, volume, trade_count, closing) + `order`; `limit` 1-100, `offset` |
| `POST /markets` | session | validates + stores the market definition, returns `metadata_hash` and the exact `factory_params` for `MarketFactory.createMarket`. **Does not create the market**; the creator's wallet does |
| `GET /markets/{id}` | - | `id` is the on-chain id; `metadata_verified` says whether stored metadata hashes to the on-chain hash and matches on-chain times/b/category |
| `GET /markets/{id}/history` | - | one point per actual trade (limit up to 1000) |
| `GET /markets/{id}/trades`, `GET /markets/{id}/evidence` | - | |
| `GET /portfolio/{address}`, `.../history` | - | positions from the index; `token_balance` read live from the chain (null if the node is down) |
| `GET /analytics/overview`, `/categories`, `/markets` | - | aggregates over indexed records only; totals come from per-market counters, the daily series from the `daily_activity` rollup (last 90 days) |
| `GET /transactions/{hash}` | - | node status + confirmations + whether the indexer processed it |
| `GET /resolutions/{market_id}` | - | proposals (mirrored from chain) and the Stage 1 trust-model note |
| `POST /resolutions/{market_id}/propose[?bonded=true]` | session; `RESOLVER_ROLE` on-chain unless `bonded=true` | stores the evidence bundle and returns its keccak hash/URI; **does not propose**; the wallet submits `propose` (resolver) or `proposeBonded` (anyone, escrows the bond) |
| `POST /resolutions/{market_id}/dispute` | session | stores *your* evidence against an open proposal (409 if there is none, the window ended, it is already disputed, or it is your own) and returns its hash; the dispute and its bond exist only once your wallet calls `ResolutionManager.dispute` |
| `POST /resolutions/{market_id}/arbitration-note` | session + `ARBITER_ROLE` on-chain | stores the arbiter's reasoning (verdict, rationale >= 30 chars) for a disputed proposal and returns the hash for `ResolutionManager.arbitrate` |
| `GET /resolutions/{market_id}/evidence/{hash}` | - | exact canonical JSON; `keccak256(body) == hash` |
| `GET /health` | - | database + indexer checkpoint |
| `GET /config` | - | chain id, public RPC URL, contract addresses (no secrets; the backend's private RPC URL is never exposed) |
| `GET /trades` | - | indexed trades newest first; filters `wallet`, `market_id`; paginated |

External data (Phase 3; see `data-sources.md`): `GET /data/{economic,weather,sports,technology}` (filters `provider`, `metric`, `location`, `validation_status`, `latest_only`), `GET /data/sources` (how each provider is accessed + real status), `GET /data/records/{id}` and `/revisions`, `GET /data/raw/{sha256}` (the exact bytes received), admin-only `POST /data/submissions` (manual sources) and `POST /data/weather/refresh`. `POST /resolutions/{market_id}/draft-from-data` (RESOLVER_ROLE) returns a **draft** outcome with evidence fields for a human to review.

Proposals in `GET /resolutions/{id}` now carry bond, dispute and arbitration fields (`state`: proposed / disputed / finalized / cancelled; `dispute_status`: none / disputed / upheld / overturned / released). Evidence documents have a `kind` (proposal / dispute / arbitration).

The API derives `closed` from its clock: the server clock by default (within seconds of block time on a real network), or the latest block's timestamp with `CLOCK_SOURCE=chain` for local development where the node's clock is advanced artificially. `GET /resolutions/{id}` returns `server_time` so clients compare deadlines against the same clock.
