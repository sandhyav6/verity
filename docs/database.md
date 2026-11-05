# Database

PostgreSQL, managed with Alembic (`backend/migrations`). The database is an **indexed read model**: everything derived from the chain can be dropped and rebuilt from `chain_events`; the contract is authoritative.

## Derived from chain events (rebuilt on reorg)

| Table | Purpose |
|---|---|
| `issuers` (`chain_id`, `address`) | Organisation label, authorised flag, authorised/removed times, who authorised, tx |
| `documents` (`chain_id`, `document_id`) | A logical document: issuer, latest type and version |
| `document_versions` (`chain_id`, `document_hash`) | One row per registered fingerprint: version, issuer, type, metadata hash, registered/expiry/revoked times, revoker, reason hash, registration and revocation tx, block |
| `batches` (`chain_id`, `batch_id`) | Merkle root (unique), issuer, document count, metadata hash, times, tx |
| `batch_document_revocations` | Per-document revocations inside a batch |
| `audit_logs` (`chain_id`, tx, log index) | One row per event: action, actor, resource, block, time |

Expiry is not stored as a status: `valid` rows with a past `expires_at` are reported as `expired` at read time. The contract uses block time; the API uses wall-clock time for dashboards.

## Off-chain data (never touched by a rebuild)

| Table | Purpose |
|---|---|
| `document_uploads` (`document_hash`, `uploader_address`) | Title, type, visibility, details JSON, metadata hash, **private** storage key, content type, size. Only trusted for a registration when `uploader_address` equals the on-chain issuer; `metadata_verified` compares its hash to the on-chain `metadataHash`. |
| `batch_documents` (`chain_id`, `merkle_root`, `document_hash`) | Leaf index, file name, size, Merkle proof. Ignored by verification unless the root is registered on-chain. |
| `users`, `sessions`, `auth_nonces` | SIWE accounts, server-side sessions (token hashes only), single-use nonces |

## Indexer bookkeeping

`chain_events` (every decoded event, primary key `chain_id, tx hash, log index`, which makes replay idempotent), `indexed_blocks` (hashes for ancestor search), `indexer_checkpoints`.

### Reorg handling

Each run compares the checkpoint block hash with the chain. On mismatch the indexer finds the newest stored block still on the canonical chain, deletes later `chain_events`/`indexed_blocks`, wipes every derived table for the chain and replays the remaining events in order, all in one transaction. `python -m app.workers.reconcile` compares the read model with the contract at the checkpoint block and exits 1 on drift.

## Migrations

`0001`–`0005` belong to the previous product and are kept so existing databases upgrade cleanly. `0006` drops its tables, clears the indexer tables (events from other contracts cannot be interpreted) and creates the Verity schema. It is intentionally one-way: take a backup first (`scripts/backup-db.sh`). Users, sessions and nonces survive.
