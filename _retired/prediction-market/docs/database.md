# Database (Phase 2, as implemented)

PostgreSQL 16 via SQLAlchemy 2 and Alembic (`backend/migrations/versions/0001_initial_schema.py`). The database is a **read model**: contracts are authoritative, and every derived table can be rebuilt from `chain_events`.

Conventions: all timestamps are `timestamptz` (UTC; the `UTCDateTime` type rejects naive datetimes); uint256 quantities are `NUMERIC(78,0)`, signed P&L `NUMERIC(80,0)`, prices `NUMERIC(40,18)`; no floats store balances. The API returns wei-scale values as strings.

| Table | Purpose | Rebuilt on reorg? |
|---|---|---|
| `chain_events` | Every decoded event, PK `(chain_id, transaction_hash, log_index)` (idempotency) | source for the rebuild |
| `indexed_blocks`, `indexer_checkpoints` | Block hashes seen + last indexed block/hash | pruned/rewound |
| `markets` | Read model of each PredictionMarket (status, q, collateral, price, volume) | yes |
| `trades`, `price_snapshots`, `positions` | Derived from trade/settlement events | yes |
| `resolution_proposals` | Mirror of ResolutionProposed/Disputed/DisputeResolved/BondsReleased/Cancelled/Finalized, including bond, disputer, challenger evidence hash, arbiter and rationale hash (migration 0003; one dispute per proposal, so no separate `disputes` table) | yes |
| `market_metadata` | Off-chain market definition, PK = keccak256 of its canonical JSON | no (off-chain data) |
| `resolution_evidence` | Off-chain evidence bundles (`kind`: proposal / dispute / arbitration), PK = keccak256 of canonical JSON, keyed by market address | no |
| `daily_activity` | Per-day trade count and token volume rollup, maintained by the indexer (migration 0005, backfilled from existing trades); makes the dashboard chart O(days) instead of O(trades) | yes |
| `external_data` | Real-world records with provenance (Phase 3, migration 0002). Append-only; revisions linked by `supersedes_id`; unique on (provider, metric, location, period, payload hash, supersedes_id) for duplicate detection | no (off-chain data) |
| `users`, `auth_nonces`, `sessions` | SIWE login (nonce single-use, session token stored as SHA-256) | no |

Differences from the Phase 0 ER diagram: `trades.price` is stored as `yes_price_after` (the exact price after the trade); the execution price is derived as `token_amount / shares`. `disputes` arrives with Phase 5; `external_data` arrived in Phase 3 (extra columns: `dataset`, `dataset_version`, `attribution`, `normalized_text`, `latitude/longitude` of the grid point actually used, `transformation`, `last_seen_at`, `submitted_by`, `ingestion_ms`). `positions` additionally stores `yes_cost`, `no_cost`, `realized_pnl`, `cost_basis` and `settled_amount` (moving-average cost accounting).

Public market ids are the **on-chain** ids (`blockchain_market_id`); internal serial ids change when the read model is rebuilt.

## Reorg handling

`indexer_checkpoints.last_block_hash` is compared with the chain on every run. On mismatch the indexer walks `indexed_blocks` downward to the newest block whose hash still matches, deletes later `chain_events`, wipes the derived tables and replays the remaining events (simple and provably consistent; O(events) cost, fine at this scale).
