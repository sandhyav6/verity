# Smart contracts (Phase 1, as implemented)

TEST ONLY. All tokens are simulated and have no monetary value. Not audited; not legally reviewed.

Toolchain: Hardhat 3.21.2, Solidity 0.8.28 (evm `cancun`), OpenZeppelin 5.6.1, PRBMath 4.2.3 (`SD59x18`).

## Contracts

| File | Purpose |
|---|---|
| `contracts/TestToken.sol` | Restricted-transfer ERC-20 test credit. Faucet (1,000 per address per 24 h), 1e9 supply cap, owner `adminMint` until `renounceMinting()`. Transfers must involve the factory or a registered market. Registered markets have an implicit (infinite) allowance. |
| `contracts/MarketFactory.sol` | `CREATOR_ROLE`-gated. Validates parameters, deploys an EIP-1167 clone, registers it with the token, pulls the subsidy from the creator and initializes the clone in one transaction. Metadata hash unique per market. |
| `contracts/PredictionMarket.sol` | Per-market LMSR trading, positions, collateral accounting, redemption, refunds, creator residual. |
| `contracts/ResolutionManager.sol` | Evidence-backed resolution with an optimistic path (Phase 5): resolver proposals (no bond) or **bonded proposals by anyone**, a challenge window, bonded disputes, a named arbiter, bond settlement, and liveness unwinds. See `oracle-design.md`. |
| `contracts/lib/LMSRMath.sol` | Fixed-point cost / price. |
| `contracts/test/LMSRHarness.sol` | Test-only wrapper around the library. |

## Fixed-point and numerical safety

- 18-decimal fixed point everywhere; 1 share redeems exactly 1e18 token-wei.
- `C = max(q) + b·ln(1 + e^(-|qY-qN|/b))` (log-sum-exp form): the exponent is always ≤ 0, so `exp` cannot overflow.
- Bounds: `b ∈ [10, 100,000]` tokens; buys ≤ `b` shares per trade; buys that would make `|qY-qN| > 20·b` revert; min trade 1e12 wei; outstanding shares ≤ 1e12 whole shares.
- Rounding favours the market: every buy adds, and every sell withholds, `margin(b) = b/1e12 + 1` wei. The subsidy is `ceil(b·ln2) + margin`.
- Measured against the 50-digit `mpmath` reference (64 point vectors): worst cost error 1,283,009 wei at `b = 100,000`, versus a margin of 1.0e11 wei; worst price error 1 unit (1e-18).
- Sells are **not** subject to the 20·b divergence cap (so users can always exit). Prices stay valid (`exp` of a very negative number returns 0, giving price 1.0); this was reasoned about, and the invariant tests only assert price ∈ [0,1] and P(Y)+P(N)=1, not a divergence bound.

## Market lifecycle

`Active` (trading while `now < tradingClose`; closure is derived from time) → `Resolved` (YES/NO) or `Invalid`. Redeem pays winning shares 1:1; losing shares revert with `NothingToRedeem`. `refund()` pays positive net cost basis pro-rated by `refundScale`. `claimResidual()` returns `collateral − reservedClaims` to the creator once.

## Trust assumptions (superseded by `oracle-design.md`)

Phase 5 replaced the Stage 1-only text below: bonded proposals, disputes and an arbiter now exist; `ResolutionProposed` gained a `bond` field and `TestToken` gained `setResolutionManager` (the manager escrows bonds). The Phase 1 notes below remain true for the resolver path.

The `RESOLVER_ROLE` holder decides outcomes; `DEFAULT_ADMIN_ROLE` can cancel a pending proposal, change the challenge window (≤ 7 days) and manage roles. Evidence hashes make dishonesty auditable, not impossible. The market creator cannot resolve their own market. Nobody can move market funds except through trading, redeem, refund and the creator's one-time residual claim.

## Gas (measured by the Hardhat tests, local network)

| Operation | Gas |
|---|---|
| `createMarket` (clone + subsidy + init) | 429,959 |
| `buy` (first buy by a user) | 177,998 |
| `sell` | 94,949 |
| `finalize` → `resolve` | 95,480 |
| `redeem` | 63,791 |

Single observations from the test run, not averages; a proper benchmark script comes in Phase 6. Deployment gas has not been measured yet.

## Known limitations

- Not audited; Slither has not been run yet (Phase 6).
- Refund shortfall branch (`refundScale < 1`) is implemented as a defence but no test reaches it; an attempted analysis suggests profits extracted by sellers are bounded by the subsidy, so it may be unreachable. This is unproven.
- Implicit allowance means a market clone can pull any user's tokens. Safe only because clones are one fixed audited-by-tests implementation deployed by the factory; documented in `TestToken` NatSpec.
- Block timestamps (miner-influenced by seconds) gate closing and deadlines.
- The arbiter is a single trusted account; bonds are cheap in a faucet world; an undisputed false proposal is accepted (see `oracle-design.md` section 5).
- Sepolia deployment scripts are not written yet.
