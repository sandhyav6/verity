# Frontend (Phase 4, as implemented)

TEST-ONLY. A banner states this on every page; no currency symbol is ever shown next to a token amount.

**Stack (versions pinned in `frontend/package.json`):** React 19, TypeScript 5.9, Vite 8, Tailwind 4, Recharts 3, wagmi 3 + viem 2 (MetaMask / any injected EIP-1193 wallet), TanStack Query 5, React Router 7, Vitest 5 + Testing Library.

## How it fits together

* **No hand-copied addresses.** On boot the app calls `GET /config` (chain id, public RPC URL, contract addresses). The backend's own RPC URL, which may carry a provider key, is never sent to browsers.
* **Typed contract access.** `contracts/scripts/export-abi.ts` writes `as const` ABIs to `frontend/src/blockchain/abi/` so viem calls are type-checked and cannot drift from the contracts.
* **Reads:** fast indexed data from the API (TanStack Query, polling every 8-16 s); anything that matters for money (quotes, balances, share counts, settlement amounts) is read **from the contract**. Each market page has a "Verify against the blockchain" panel that re-reads five values from the contract and compares them with the database.
* **Writes:** wallet-signed transactions only. Every transaction is first *simulated* against the node as the connected account, so a revert shows a readable message before the wallet opens. A ref blocks double submission. Failures map every contract custom error to a plain sentence (`src/lib/errors.ts`, tested for all 26 error names).
* **Sign-in:** Sign-In with Ethereum. The browser builds the EIP-4361 message (`src/lib/siwe.ts`); the Python backend verifies it (verified end to end in a real browser, see below).

## Pages

| Route | What it does |
|---|---|
| `/` Dashboard | Real statistics from indexed events, markets nearing closure / recent / resolved, category and activity charts, recent trades, data-source status. Honest empty states. |
| `/markets` | Search, category/status filters, sort, pagination; filters live in the URL. |
| `/markets/:id` | Probability chart from real trades, rules and source, evidence and resolution history, recent trades, **trading panel**, settlement panel, on-chain verification. |
| `/create` | Full creation form with client-side validation mirroring the backend, optional Open-Meteo data rule, funding estimate (b·ln 2). Registers the definition with the API, then the creator's wallet calls `MarketFactory.createMarket`. |
| `/portfolio/:address?` | Positions, balance read from the chain, indicative value (labelled *not* a redemption value), realized P&L, faucet button. Any address can be looked up. |
| `/transactions` | Transactions sent from this browser with live node status, plus confirmed trade history. |
| `/analytics` | Blockchain-only metrics; external data is deliberately elsewhere. |
| `/data` | Data Explorer: provenance, validation status, freshness, attribution, daily rainfall drawn from the stored provider response. |
| `/admin` | Resolution dashboard (resolvers propose directly; **anyone can propose with a bond**): markets awaiting a result, draft-from-data, evidence form, on-chain proposal and finalize, source status, manual record entry (admin). |

## The challenge / arbiter panel (`OraclePanel`)

Shown on a market that is closed with a pending proposal: who proposed what and with which bond, the challenge window (compared with the API's `server_time`), a dispute form (evidence -> hash -> post bond, bond read from the contract), finalize for an undisputed result after its window, both parties' evidence once disputed, an arbiter form (ruling + reasoning -> hash -> decide) visible only to `ARBITER_ROLE` wallets, and a "release bonds" action after the 14-day arbiter timeout. It repeats that this is not a decentralized oracle.

## The trading panel

Buy/sell, YES/NO, enter shares or a token budget, slippage tolerance. It shows two clearly separated quotes: an **estimate** computed in the browser (`src/lib/lmsr.ts`, the same log-sum-exp form as the contract, tested against the 64 mpmath reference vectors used by the Solidity tests) and the **contract quote** read from `quoteBuy`/`quoteSell`. The transaction carries `maxCost`/`minProceeds` derived from the contract quote and a 20-minute deadline, behind an explicit confirm step. Wrong network -> a switch button, not a trade button; no wallet -> a connect button; closed/resolved/voided markets say why they cannot be traded.

## Charts

Built to the dataviz rules: YES = blue, NO = orange (validated palette; red/green are never used for series), 2 px lines, bars <= 24 px with rounded data ends, hairline grids, surface-ringed dots, a tooltip on every chart, a legend when there are two or more series, and a **table view for every chart**. Colours are CSS tokens with separately selected dark-mode values (follows the OS setting). One trade is drawn as one point; no trades is an empty state; history is never interpolated. External-data charts are separate from blockchain charts.

## Local development against a Hardhat node

```bash
# terminal 1 (contracts/)
npx hardhat node
# terminal 2 (contracts/)
npx hardhat run scripts/deploy.ts --network localhost        # prints addresses, writes deployments/local.json
# terminal 3 (backend/): migrations, API and indexer, with the addresses from step 2 in the environment or .env
python -m alembic upgrade head
CLOCK_SOURCE=chain uvicorn app.main:app --port 8000          # chain clock only matters if you time-travel the node
python -m app.workers.indexer
# terminal 4 (frontend/)
npm install            # first time
npm run dev            # http://localhost:5173
```

**Dev wallet (development builds only):** opening `http://localhost:5173/?devWallet=1` installs a stand-in wallet that forwards requests to the local Hardhat node using its unlocked accounts (#0 admin, #1 market creator, #2 resolver, #3-#5 traders). It works only when `vite dev` is running, the node reports chain id 31337, and the URL contains the parameter; every code path is behind `import.meta.env.DEV`. It exists so the whole UI can be exercised without a browser extension. It is **not** MetaMask.

## Tests

`npm test` -> 90 tests in 4 files: indicative LMSR vs the reference vectors, error messages, SIWE message format, trading-panel rules (wallet states, wrong network, confirm step, exact call arguments, slippage, double-submit guard, failures, balance and size limits, closed markets), market browsing/filtering/pagination, empty and error states, wallet connection, mobile menu, market details, portfolio, transactions, Data Explorer provenance/labels, charts' honesty, and creation-form validation. `npm run build` runs the type check and builds production assets.

## Verified by hand in a real browser (2026-11-05)

With the full stack running (Hardhat node, deployed contracts, PostgreSQL, API, indexer, Vite) and the dev wallet: wallet connect; SIWE sign-in (browser message accepted by the Python backend); market creation through the real form (backend + wallet transaction + indexer + link back); faucet; buying YES with browser estimate = contract quote (13.2792 tokens) and the balance falling by exactly that; the probability moving 50.0% -> 56.2%; on-chain verification all "matches"; a sell; time travel; resolver role detected from the contract; evidence stored and hashed; proposal and finalize; redemption (+20.00 tokens for 20 YES shares); a NO holder shown "Nothing to redeem"; portfolio realized P&L (+9.28) equal to the balance change; a real Open-Meteo fetch shown in the Data Explorer (4.2 mm, valid) and a recent period shown as incomplete with no total; Analytics and Transactions pages; the backend-unreachable screen; and a 375 px phone viewport with no horizontal page overflow.

## Known limitations

* **Real MetaMask was not tested** (no extension in the test browser); the injected-provider path is exercised through the dev wallet and the wagmi `injected()` connector only.
* **No automated end-to-end browser test.** Wallet-dependent flows are covered by component tests with a mocked wallet layer plus the manual run above, not by a Playwright suite.
* Responsive behaviour was checked at 375 px by viewport emulation and by class assertions, not on physical devices. No automated accessibility audit has been run; labels, roles, focus rings and table views are in place.
* The production bundle is one 1.14 MB chunk (332 kB gzip); no code splitting yet.
* Dark mode follows the OS; there is no theme toggle. The status badge/"wallet not signed in" state can flash briefly while the session loads.
* The browser's clock is used for relative times ("closes in 2h"); deadline logic that gates actions uses the API's `server_time`.
* wagmi v3 types are strict; `useTx` uses two narrow casts around `simulateContract`/`mutateAsync`.
