# Security (Phase 6, as implemented)

TEST-ONLY system; not audited. Static analysis is not an audit, and passing tests are not proof of absence of bugs.

## 1. Static analysis: Slither 0.11.6, solc 0.8.28

Run (Windows or Linux; from `contracts/`, with `solc-select install 0.8.28 && solc-select use 0.8.28`):

```bash
for c in PredictionMarket MarketFactory ResolutionManager TestToken; do
  slither contracts/$c.sol --compile-force-framework solc \
    --solc-remaps "@openzeppelin/=node_modules/@openzeppelin/ @prb/=node_modules/@prb/" \
    --solc-args "--evm-version cancun --optimize" --filter-paths node_modules
done
```

**Result: no high- or medium-severity findings.** 102 detectors on each contract, with dependencies (OpenZeppelin, PRBMath) excluded from the report. Every finding, and what was done:

| Detector | Where | Disposition |
|---|---|---|
| `missing-zero-check` (low) | `PredictionMarket.initialize`: `creator_`, `resolutionManager_` | **Fixed.** The factory always passes valid values, but a market with a zero creator or resolution manager could never be settled, so `initialize` now reverts with `ZeroAddress` (also checks the token and `b > 0`). Covered by a test that deploys a raw clone and calls `initialize` with bad values. Re-run: finding gone. |
| `reentrancy-events` (low) | `MarketFactory.createMarket`: `MarketCreated` is emitted after calls to `token.registerMarket` and `market.initialize` | **Accepted.** Both callees are this project's own contracts (a fixed token and a freshly cloned implementation); all factory state is written before the calls, and nothing value-bearing can re-enter. The only effect is event ordering. |
| `timestamp` (info) | trading close, deadlines, faucet cooldown, challenge windows, arbiter timeout | **Accepted.** These are inherent to time-bounded markets. Miners can shift `block.timestamp` by seconds; every window here is minutes to days. |
| `incorrect-equality` (info) | `ResolutionManager._propose`: comparison of an enum state | **False positive.** The check compares a state enum, not a balance or an amount an attacker could nudge. |

The OpenZeppelin `ReentrancyGuardTransient` compile warning (EIP-1153 composability) is the documented-safe use: a guard that is always cleared at the end of the call. Requires an EVM with transient storage (Cancun, which Sepolia supports).

## 2. Contract controls and where they are tested

| Requirement | Implementation | Test |
|---|---|---|
| Checks-effects-interactions | State written before every token transfer (`buy`, `sell`, `redeem`, `refund`, `claimResidual`, bond payouts) | all trading/settlement/oracle tests; balance == accounting invariants |
| Reentrancy protection | `ReentrancyGuardTransient` on every state-changing market and oracle function | structural; token has no hooks |
| Access control | OpenZeppelin `AccessControl` roles (`CREATOR_ROLE`, `RESOLVER_ROLE`, `ARBITER_ROLE`), `onlyResolutionManager`, creator-only residual | `settlement.test.ts`, `oracle.test.ts` (outsiders, creators, arbiter conflicts) |
| Safe token interactions | `SafeERC20` throughout; restricted-transfer token | `token-factory.test.ts` |
| Deadline and slippage | `maxCost`/`minProceeds`, `deadline`, trading-window check | `trading.test.ts` |
| Duplicate settlement | positions zeroed before payout; `NothingToRedeem`; one-shot residual claim; proposal state machine | `settlement.test.ts`, `oracle.test.ts` |
| Collateral accounting | `collateral ≥ C(q) ≥ max(qYes, qNo)`; `reservedClaims`; escrow == balance | 180-op random sequences vs the 50-digit reference; Solidity invariants; oracle conservation test |
| Fixed-point safety | log-sum-exp form, bounded `b`, trade size and price divergence, rounding in the market's favour plus a margin | `lmsr.test.ts` (error ≤ margin on 64 vectors), mutation check |
| State validation | every function checks market/proposal state | revert-path tests |
| Unauthorized resolution | only the manager can call `resolve`/`invalidate`; only roles propose/arbitrate; creator can never resolve their own market | `settlement.test.ts`, `oracle.test.ts` |
| Initialization safety | implementation locks its initializer; clones initialize once, atomically with creation; zero-address checks | `token-factory.test.ts` |
| Mainnet protection | `scripts/deploy.ts` refuses any chain id except 31337 and 11155111; no mainnet network is configured | verified against a fake RPC claiming chain 1: refused after one `eth_chainId` call, nothing sent |

Verification beyond "tests pass": **mutation checks** (set the rounding margin to zero → 6 tests fail; make the arbiter always pay the proposer → 2 fail; stop reducing escrow → 3 fail).

## 3. Backend controls

| Area | Control | Evidence |
|---|---|---|
| Secrets | environment variables only; `.env` git-ignored; `.env.example` contains placeholders; the private RPC URL is never sent to browsers (`/config` exposes only `PUBLIC_RPC_URL`) | `test_public_config_exposes_addresses_but_never_the_backends_private_rpc_url`; repository scan for secrets |
| Input validation | Pydantic models with explicit bounds on every request body and query | 16 market-validation cases, pagination/filter tests |
| SQL injection | SQLAlchemy parameterization only; search text escaped | injection-string test |
| Authentication | SIWE: signature, domain, chain id, URI, timestamps, single-use unexpired nonce burned atomically; opaque server-side sessions stored hashed, `HttpOnly`, `SameSite=Lax`, revocable | 11 auth tests (replay, forgery, wrong domain/chain, expiry, tamper) |
| Authorization | admin allowlist for off-chain admin views; on-chain role checks (`RESOLVER_ROLE`, `ARBITER_ROLE`) before storing evidence; the backend never sends transactions | API tests; no signing key exists in the backend |
| Rate limiting | `slowapi`: default limit on all routes, stricter on `/auth/*`; evidence documents capped per wallet and market | auth rate-limit test; evidence flood test. *Limitation:* behind a proxy all clients share one IP unless forwarded headers are handled |
| CORS | explicit origin allowlist, GET/POST only, credentials allowed only for that list | configuration |
| Timeouts | 15 s on RPC and provider HTTP clients; bounded retries | adapter tests |
| Errors and logging | unexpected errors return a generic 500 (details only in logs); tokens, signatures and secrets are not logged | handler |
| Backups | `scripts/backup-db.sh` / `restore-db.sh` | see deployment doc; **restore was not exercised against a real database in this build** |
| Data integrity | idempotent indexer; reorg rollback and rebuild; DB-vs-chain `reconcile` | indexer and reorg tests |

## 4. Frontend controls

Wallet address validation (portfolio lookup); chain-id check with a switch-network prompt and no trading on the wrong chain; every transaction is simulated first, then needs an explicit confirm step, then the wallet's own confirmation; a ref-based guard blocks double submission; contract errors are translated for users; no private keys or seed phrases are ever requested or stored (the development stand-in wallet holds no keys and exists only in dev builds on chain 31337); `X-Frame-Options`, `nosniff` and `Referrer-Policy` headers on the static host. A strict Content-Security-Policy is **not** set because its origins depend on the deployment; add one when the production origins are known.

## 5. Threat model summary

| Asset / goal | Attacker | Main defence | Residual risk |
|---|---|---|---|
| Market collateral | trader, creator, resolver | per-market collateral, solvency invariant, access control | undiscovered contract bug (no audit) |
| Correct outcome | dishonest resolver/proposer | evidence hashes, challenge window, bonded disputes | one arbiter decides contested cases; undisputed false results are accepted |
| Fair prices | frontend/backend tampering | contract computes prices; slippage limits | none beyond the contract |
| Accounts | impersonation, replay | SIWE, single-use nonces, server-side sessions | session theft via a compromised browser |
| Availability | spam, DoS | rate limits, per-wallet caps, bounded retries | no WAF/CDN; single-instance deployment |
| Data trustworthiness | bad provider data | validation, `incomplete`/`invalid` states, append-only revisions, no silent fallback | reanalysis is a model, not observation; manual records trust the submitter |

## 6. Not covered

External audit; formal verification; load/concurrency testing; a penetration test of the API; dependency vulnerability scanning in CI (run `npm audit` / `pip-audit` yourself); a Content-Security-Policy; key management beyond environment variables; multi-signature administration (recommended for any shared deployment: administrator, resolver and arbiter should be distinct accounts).
