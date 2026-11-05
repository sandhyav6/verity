# API reference

Base URL `http://localhost:8000`. Interactive OpenAPI docs: `/docs`. JSON everywhere except uploads (`multipart/form-data`) and the file download. Errors are `{ "detail": "<message>" }` with conventional status codes (401 not signed in, 403 not permitted, 404 unknown, 409 state conflict, 413/415 upload limits, 422 validation, 429 rate limit, 503 chain/storage unavailable). Internal errors never leak details.

Lists use `limit` (1–100) and `offset` and return `{ items, total, limit, offset }`.

## Authentication (SIWE)

| Method & path | Notes |
|---|---|
| `GET /auth/nonce` | Single-use nonce plus the exact domain, URI, chain id and statement the message must contain. Rate limited. |
| `POST /auth/verify` | `{message, signature}`: verifies EIP-4361 signature, domain, chain, URI, timestamps; burns the nonce; sets an HttpOnly `session` cookie. Response includes on-chain roles. |
| `GET /auth/session` | 200 with the session, or `null` when signed out (used by the browser app). |
| `GET /auth/me` | 200 or 401. |
| `POST /auth/logout` | Revokes the session. |

Session roles (`is_issuer`, `is_manager`, `roles_available`) are read from the contract on each call, never from the database.

## Verification (public)

| | |
|---|---|
| `POST /verify` `{document_hash}` / `GET /verify/{hash}` | Verdict `verified \| revoked \| expired \| not_verified` with `reason` and, if registered, a `registration` (issuer, organisation name, dates, version, batch, transaction). The verdict comes from an `eth_call` to the contract, never from the database. Private titles are included only for public documents or the issuer. Rate limited (60/min). |
| `GET /proofs/{hash}` | Merkle proofs stored for a fingerprint (hints; the contract decides). Roots not registered on-chain are filtered out. |

## Documents

| | |
|---|---|
| `POST /documents/uploads` (issuer) | Form: `file`, `title`, `document_type`, `visibility` (`public\|private`), `metadata` (JSON string→string, ≤20 entries), optional `expected_hash`. Streams to storage while hashing; returns `document_hash`, `metadata_hash`, `canonical_metadata`. Does **not** register anything. 413 over the limit, 415 for executables/unknown types, 422 for a hash mismatch. |
| `GET /documents` (issuer) | The caller's own registrations. Filters: `q` (title or fingerprint prefix), `status`, `document_type`. |
| `GET /documents/{hash}` | Registration facts and version history. |
| `GET /documents/{hash}/file` | Stored bytes: public documents to anyone, private to the issuer. Always `application/octet-stream` + `attachment`. Same 404 for "missing" and "not allowed". |

## Batches

| | |
|---|---|
| `POST /batches/documents` (issuer) | `{merkle_root, documents:[{document_hash, filename, size_bytes}]}`. The server recomputes the tree and accepts only if the root equals the one registered **on-chain by this wallet** with the same document count (409 if the root is not yet on-chain). Stores leaves and proofs. |
| `GET /batches` (issuer) | Own batches. |
| `GET /batches/{id}` | Public batch facts. |
| `GET /batches/{id}/documents` (issuing wallet) | Leaf records including file names. |
| `GET /batches/{id}/proof/{hash}` | Self-contained proof file (hashes only). |

## Registry data

| | |
|---|---|
| `GET /issuers`, `GET /issuers/{address}` | Indexed issuers with document/batch/revocation counts. Filters `authorized`, `q`. There is no write endpoint: authorisation changes are on-chain transactions by an issuer manager. |
| `GET /audit` | Every indexed registry event. Filters `action`, `actor`, `resource_id`. Public: contains no titles or files. |
| `GET /stats?scope=global\|mine&days=30` | Aggregates from indexed events; `mine` needs a session. |
| `GET /transactions/{hash}` | Receipt status, confirmations, and whether the indexer has processed it. |
| `GET /config` | Chain id, public RPC URL, registry address, document types, upload limit. No secrets. |
| `GET /health` | Database and indexer checkpoint. |
