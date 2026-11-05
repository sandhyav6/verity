# Verity — Tamper-Evident Document Registry & Verification

Verity is a blockchain-backed platform for registering and verifying document integrity. An authorised **issuer** registers the SHA-256 fingerprint of a document on a public blockchain. Anyone can later drop a file onto Verity, and the file is fingerprinted **in their own browser** and checked against the on-chain record: registered or not, by whom, when, which version, and whether it has since been revoked.

Documents never leave their owners and never go on-chain. Only fingerprints and issuance records do.

| | |
|---|---|
| **Contracts** | Solidity 0.8.28, OpenZeppelin 5 (`AccessControlDefaultAdminRules`, `MerkleProof`), Hardhat 3 |
| **Backend** | FastAPI, SQLAlchemy 2 + Alembic, PostgreSQL, web3.py, SIWE sessions |
| **Frontend** | React 19 + TypeScript, Vite, Tailwind 4, wagmi + viem, TanStack Query |
| **Tests** | 27 contract tests, 56 backend tests against a real chain and real PostgreSQL, 63 frontend tests |

> Verity is a registry, not a marketplace. It has no tokens, no payments and no speculation.

---

## 1. Problem statement

Organisations issue certificates, audit reports, agreements and software releases. Checking one today usually means contacting the issuer, searching their records, or trusting a centralised database that the issuer (or an attacker) can quietly edit.

Verity gives each issued document an independently verifiable record that no single party, including Verity's own operators, can alter or erase.

## 2. Why a blockchain is appropriate here

| Need | Why a blockchain fits |
|---|---|
| Records must not be silently edited or deleted | An append-only public ledger; nobody, including the operator, can rewrite history |
| Verification must not depend on the issuer being online or honest later | Anyone can read the contract directly |
| The verdict must not be forgeable by a server | The browser asks the contract itself; the API cannot upgrade a result |
| Authorisation must be auditable | Issuer grants/removals are public events |

It is **not** used to store documents (cost, privacy, size) or to decide whether a document is *true*.

## 3. Features

- **Register** a document: fingerprint, title, type, optional expiry, public/private visibility, extra details; wallet-signed transaction; success shown only after on-chain confirmation.
- **Verify** any file or pasted fingerprint, privately. Results: **Verified**, **Revoked**, **Expired** or **Not verified**, with the reason.
- **Versioning**: a new version is a new on-chain record; earlier versions keep verifying independently.
- **Revocation**: permanent, keeps the original record, records who/when/why-hash.
- **Merkle batches**: register thousands of documents with one transaction; each recipient verifies with a proof.
- **Issuer management** on-chain with role separation and a two-step, time-delayed admin handover.
- **Indexer** with reorg detection and rollback; audit log of every registry event.
- Dashboard with real statistics, search and filters, document management, batches, activity feed.

## 4. Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI[React app<br/>wagmi + viem]
    H[SHA-256 + Merkle<br/>computed locally]
  end
  subgraph Chain[EVM chain]
    C[(VerityRegistry<br/>contract)]
  end
  subgraph Backend
    API[FastAPI]
    IDX[Indexer worker]
    ST[(Document storage<br/>local / S3-compatible)]
    DB[(PostgreSQL<br/>read model)]
  end
  UI -- "verdict: eth_call (authoritative)" --> C
  UI -- "register / revoke / batch (wallet-signed tx)" --> C
  UI -- "upload file + metadata, SIWE, search" --> API
  API --> ST
  API --> DB
  API -- "role + verify reads" --> C
  C -- "events" --> IDX --> DB
```

**Trust boundaries.** The contract is the source of truth for registrations, revocations, issuer authorisation and batch roots. PostgreSQL is a *read model* of chain events (rebuildable from `chain_events`). The backend holds no signing key and cannot send transactions, so it cannot fabricate or alter a record; it stores files and metadata, authenticates users, indexes and searches.

### What is on-chain and what is off-chain

| On-chain (public) | Off-chain (issuer's control) |
|---|---|
| SHA-256 fingerprint of each document (`bytes32`) | The document file itself |
| `documentId`, version number, document type (enum) | Title, free-form details, visibility |
| Issuer address and organisation label | Uploaded file bytes (private storage) |
| Registration time, optional expiry | Per-document Merkle proofs and file names |
| Revocation time, revoker, reason *hash* | Revocation reason text |
| SHA-256 hash of the off-chain metadata | |
| Batch Merkle roots, counts | |

### What the blockchain does and does not guarantee

- **Guarantees:** a given address registered a given fingerprint at a given time; the record cannot be edited or removed; revocation is permanent and timestamped; who is authorised to issue is publicly auditable.
- **Does not guarantee:** that the document's content is true, that an issuer is who it claims to be (the organisation name is a label set by issuer managers), or that a file with a *different* fingerprint (a re-saved or re-exported copy) is "the same document". Verity distinguishes **integrity** (bytes match), **registration** (a record exists), **issuer identity** (which address), **issuer legitimacy** (out of band) and **validity** (not revoked or expired). The Verify page explains this to users.

## 5. Smart-contract architecture

`contracts/contracts/VerityRegistry.sol` (single contract, no proxy, no token, no payable functions).

```
DEFAULT_ADMIN_ROLE  (two-step, time-delayed transfer)  ──grants──▶  ISSUER_MANAGER_ROLE
ISSUER_MANAGER_ROLE ──authorizeIssuer / removeIssuer──▶ issuer set
Issuer              ──registerDocument / registerBatch──▶ records
Record's issuer     ──revokeDocument / revokeBatch / revokeBatchDocument──▶ revocations
Anyone              ──verifyDocument / verifyBatchDocument──▶ (view)
```

- **No single super-user.** Admins grant roles and managers authorise issuers, but neither can register or revoke documents. Only the original issuer of a record can revoke it (even after being removed, because revocation is a safety action).
- **Duplicate protection.** A fingerprint can be registered once, ever, across all issuers. A revoked fingerprint cannot be re-registered to "un-revoke" it.
- **Versioning.** `registerDocument(documentId, hash, type, metadataHash, expiresAt)`; the first call for a `documentId` is version 1, later calls by the *same issuer* append versions. Revoking one version never touches the others. `verifyDocument` reports `version` and `latestVersion`.
- **Verification** returns `Status {NotRegistered, Valid, Revoked, Expired}`, the issuer, whether that issuer is authorised *now*, times, version and reason hash. Revoked outranks expired.
- **Events:** `IssuerAuthorized`, `IssuerRemoved`, `DocumentRegistered`, `DocumentRevoked`, `BatchRegistered`, `BatchRevoked`, `BatchDocumentRevoked`. They carry hashes and addresses only.
- **Custom errors** and NatSpec throughout. Solidity 0.8.28, optimizer 200.

### Merkle batch registration

`registerBatch(merkleRoot, documentCount, metadataHash)` records only the root. Documents are proven with `verifyBatchDocument(batchId, documentHash, proof)`; single documents (`revokeBatchDocument`) or the whole batch (`revokeBatch`) can be revoked.

The exact algorithm (identical in Solidity, TypeScript and Python, and pinned by shared test vectors):

| Step | Definition |
|---|---|
| Leaf | `keccak256(0x00 ‖ documentHash)`, where `documentHash` is the 32-byte SHA-256 of the file |
| Node | `keccak256(min(a,b) ‖ max(a,b))`, sorted pair (OpenZeppelin `MerkleProof`), so proofs carry no left/right flags |
| Odd node | An unpaired last node is promoted unchanged to the next level |
| Proof | The sibling at every level that has one, from leaf upward |
| Domain separation | Leaves hash 33 bytes, inner nodes 64 bytes, so an inner node cannot be passed off as a document (tested) |

## 6. Document hashing

- Fingerprint = **SHA-256 of the raw file bytes**, written everywhere as `0x` + 64 lowercase hex = the contract's `bytes32`.
- File names, paths, MIME types and timestamps never take part: the same bytes give the same fingerprint under any name; one flipped bit gives a different one.
- Browsers use streaming SHA-256 (4 MiB slices, `@noble/hashes`) so large files do not exhaust memory. The backend hashes uploads while streaming them to storage and rejects a file whose bytes differ from the browser's fingerprint.
- Metadata hash = SHA-256 of canonical JSON (`{"attributes":{…},"document_type":…,"title":…}`, keys sorted recursively, no whitespace, UTF-8). `contracts/test/vectors.json` holds cross-language vectors asserted by the contract, backend and frontend test suites.

## 7. Workflows

**Verification** (public, no account)
1. The browser hashes the file locally.
2. The browser calls `verifyDocument(hash)` on the contract over its own RPC connection. If nothing is registered, it asks the API for Merkle-proof *hints* and has the contract check each (`verifyBatchDocument`).
3. The result card is derived from the contract answer only. The API is consulted for decoration (organisation name, transaction link, public title) and can never upgrade a verdict; if API and chain disagree the UI says so and shows the chain's answer.

**Registration**
1. Wallet connected, correct network, SIWE session, on-chain issuer role (all checked, with explicit states for each failure).
2. File hashed locally; details entered; duplicate pre-check against the contract.
3. `POST /documents/uploads` stores the file and returns the metadata hash.
4. The wallet signs `registerDocument(...)` (simulated first, so reverts show a readable reason before the wallet opens).
5. Success is shown only after a successful receipt; the indexer then picks up the event.

**Revocation:** issuer calls `revokeDocument(hash, reasonHash)`; the record is kept, marked revoked with time and revoker; verification returns **Revoked** from the next block.

**Versioning:** register the new file with the existing `documentId` (the dashboard's *New version* action); the next version number is assigned by the contract.

## 8. Database schema overview

Derived from chain events (rebuilt after a reorg): `issuers`, `documents` (logical document), `document_versions` (one row per fingerprint), `batches`, `batch_document_revocations`, `audit_logs`. Off-chain data that a rebuild never touches: `document_uploads` (file + metadata, keyed by fingerprint and uploader), `batch_documents` (leaf + proof), plus `users`, `sessions`, `auth_nonces`. Generic indexer tables: `chain_events`, `indexed_blocks`, `indexer_checkpoints`. See [docs/database.md](docs/database.md).

Migrations are in `backend/migrations`. `0006` retires the previous product's tables and keeps users, sessions and the indexer infrastructure.

## 9. API overview

Interactive docs at `http://localhost:8000/docs`. Summary in [docs/api.md](docs/api.md).

| Area | Endpoints |
|---|---|
| Auth (SIWE) | `GET /auth/nonce`, `POST /auth/verify`, `GET /auth/session`, `GET /auth/me`, `POST /auth/logout` |
| Verification (public) | `POST /verify`, `GET /verify/{hash}`, `GET /proofs/{hash}` |
| Documents | `POST /documents/uploads` (issuer), `GET /documents` (own), `GET /documents/{hash}`, `GET /documents/{hash}/file` |
| Batches | `POST /batches/documents` (issuer), `GET /batches`, `GET /batches/{id}`, `…/documents`, `…/proof/{hash}` |
| Issuers / activity | `GET /issuers`, `GET /issuers/{address}`, `GET /audit`, `GET /stats`, `GET /transactions/{hash}`, `GET /config`, `GET /health` |

Issuer authorisation has **no write endpoint on purpose**: it is changed on-chain by an issuer-manager wallet, and the API only reflects it.

## 10. Local setup

### Requirements
Node.js 22+ (24 works), Python 3.12+, and Docker. On Python 3.12 the tests and the dev script can use an embedded PostgreSQL (`pgserver`); it has no Python 3.13 build, so on 3.13 point the tests at Docker Postgres with `TEST_DATABASE_URL=postgresql+psycopg://user:pass@host:port/postgres` (an admin database; the suite creates `verity_test` itself).

### Option A: Docker Compose (everything)

```bash
docker compose up --build
```

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| API docs | http://localhost:8000/docs |
| Chain RPC | http://localhost:8545 |

If host port 8000 is already in use, run `API_PORT=8001 docker compose up --build` (PowerShell: `$env:API_PORT=8001; docker compose up --build`); the API URL and frontend build follow it.

`deployer` deploys `VerityRegistry` and authorises Hardhat accounts #1 (*Northfield University*) and #2 (*Harbor Audit LLP*) as demo issuers; account #0 is the issuer manager/admin. Import these **public development keys** into MetaMask on the *Hardhat Local* network (chain 31337) to try the app. Never use them on a real network.

### Option B: run the pieces yourself

```bash
# 1. chain + contracts
cd contracts && npm install
npx hardhat node                                           # terminal 1
npx hardhat run scripts/deploy.ts --network localhost      # terminal 2 (writes deployments/local.json)
npx hardhat run scripts/export-abi.ts                      # only after changing the contract

# 2. backend
cd ../backend
py -3.12 -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt   # Linux/macOS: .venv/bin/pip
python scripts/dev_db.py                                   # embedded PostgreSQL; prints a DATABASE_URL (or use Docker/your own)
cd .. && python scripts/make_env.py local --database-url "<that URL>"          # writes .env with the deployed addresses
cd backend
alembic upgrade head
uvicorn app.main:app --port 8000                           # API
python -m app.workers.indexer                              # indexer (separate terminal)

# 3. frontend
cd ../frontend && npm install && npm run dev               # http://localhost:5173
```

In a development build, `http://localhost:5173/?devWallet=1` connects a **built-in dev wallet** (Hardhat account #1; `0` = manager, `2` = second issuer) so you can try every flow without a browser extension. It exists only under `vite dev`, only against chain 31337, and holds no keys.

### Environment variables
All are listed and explained in [.env.example](.env.example). The important ones: `DATABASE_URL`, `RPC_URL`, `PUBLIC_RPC_URL`, `CHAIN_ID`, `REGISTRY_ADDRESS`, `START_BLOCK`, `INDEXER_CONFIRMATIONS`, `SIWE_DOMAIN`/`SIWE_URI_PREFIX` (must equal the frontend origin), `STORAGE_DIR`, `MAX_UPLOAD_BYTES`. The frontend needs only `VITE_API_URL`; chain and contract address come from `GET /config`. Development configuration (Docker defaults, Hardhat keys) is deliberately separate from production values, which must come from your secret store.

## 11. Deployment

Local/test networks are supported out of the box (`31337` and Sepolia `11155111`; `deploy.ts` refuses every other chain id before sending a transaction). For a public testnet: set `SEPOLIA_RPC_URL` and `DEPLOYER_PRIVATE_KEY` in your shell, `ADMIN_TRANSFER_DELAY` to days, `ISSUERS` as JSON, deploy, then run the backend with `INDEXER_CONFIRMATIONS≈12`, `COOKIE_SECURE=true`, HTTPS, a persistent `STORAGE_DIR` volume and your real `SIWE_DOMAIN`. See [docs/deployment.md](docs/deployment.md).

## 12. Testing

```bash
cd contracts && npx hardhat test                    # 27 tests: registry, roles, versioning, revocation, Merkle batches
cd backend  && .venv/Scripts/python -m pytest       # hashing/storage units, SIWE, indexer (reorg), full API lifecycle
cd frontend && npm test && npm run build            # vitest (63), typecheck, production build
```

- **Contracts:** registration, duplicates, invalid hashes, unauthorised callers, versions, revocation (incl. after issuer removal), issuer lifecycle, role separation, two-step admin transfer, batches of 1–13 documents, invalid/extended/truncated proofs, second-preimage attempt, cross-language vectors.
- **Backend (nothing mocked):** each module boots a real Hardhat node, deploys the real contract and uses real PostgreSQL. The lifecycle test logs in with SIWE, uploads, registers on-chain, indexes, verifies, tampers, revokes, versions and verifies a Merkle batch member through the contract. Indexer tests cover idempotent replay, resume, **reorg rollback** (EVM snapshot/revert) and drift reconciliation.
- **Frontend:** page states for Verify (verified/revoked/expired/not verified, API-lying and API-down cases), registration (every wallet and transaction state), dashboard, issuers, activity, details, plus hashing, canonical JSON and Merkle vectors.

## 13. Security considerations

- Files are hashed in the browser; verifying sends only a fingerprint. Uploaded files are accepted only from on-chain-authorised issuers, size-limited, **type-detected from content** (extensions are ignored), executables and scripts rejected, stored under content-derived keys, and served only as `application/octet-stream` attachments with `nosniff`.
- Authorisation is read from the chain at request time. The API never trusts a wallet address in a request body; sessions are SIWE (nonce, domain, chain, expiry checks, one-time nonce, server-side session, only a hash of the token stored).
- Privacy: private documents expose no title, details or file to the public; storage paths and internal IDs are never returned; uploads count only when made by the address that registered the fingerprint on-chain.
- The backend has no private key. Frontend ships no secrets. Rate limiting on auth, uploads and verification. Structured logging without secrets.
- Contract: role separation, custom errors, no external calls, no ETH handling, checks-effects, duplicate protection.

## 14. Limitations

- Verity proves byte-for-byte integrity and issuer origin, not truth or issuer legitimacy.
- A re-saved, re-exported or re-scanned file has a different fingerprint and will not verify.
- The organisation name is a manager-assigned label; verifiers must confirm issuer addresses out of band.
- Verification on the Verify page needs an RPC endpoint reachable from the browser (`PUBLIC_RPC_URL`).
- The API-side dashboard computes *expired* from wall-clock time; the contract uses block time (they diverge only on a dev chain with time travel).
- Local storage is single-node; only a `Storage` interface for S3-compatible object stores is provided, not an implementation.
- No contract upgrade path by design; a new registry means a new deployment and migration.
- Contracts have not had an independent security audit.

## 15. Future scope

S3-compatible storage; email/webhook notifications; ENS/domain-verified issuer identity; EIP-712 signed issuer attestations; selective-disclosure proofs for document attributes; batch proof download packages; internationalisation.

## Repository layout

```
contracts/   VerityRegistry.sol, deploy/export scripts, Hardhat tests, cross-language vectors
backend/     FastAPI app (api, blockchain, services, storage, verity), migrations, pytest suite
frontend/    React app (pages, components/ui design system, hooks, lib), vitest suite
docs/        hashing spec, API, database, deployment, security
scripts/     make_env.py, DB backup/restore
_retired/    the previous (prediction-market) implementation, moved aside, not deleted
```
