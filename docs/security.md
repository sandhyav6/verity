# Security notes

## Threat model in one page

| Threat | Mitigation |
|---|---|
| A compromised or dishonest backend claims a document is valid | The browser reads the verdict from the contract itself; the API's answer can only decorate it, and a disagreement is surfaced. Revoked/unregistered documents cannot be made to look valid. The backend has no signing key. |
| An unauthorised party registers documents | `onlyIssuer` in the contract; the API additionally checks the on-chain role before accepting uploads. |
| A manager abuses power | Managers can only authorise/remove issuers; they cannot register or revoke. Admin changes are two-step and time-delayed. |
| A removed or compromised issuer | Removal blocks new registrations; the registration history stays visible and verification reports `issuerAuthorized: false`. The issuer can still revoke its own records. |
| Session theft / replay | SIWE with single-use nonces, domain/chain/URI/time checks, HttpOnly SameSite cookies, server-side sessions with hashed tokens, revocation on logout. |
| Malicious uploads | Size limit enforced while streaming; type detected from content; executables and scripts rejected; content-derived storage keys validated against traversal; downloads are forced attachments with `nosniff`; nothing is rendered from storage. |
| Private data exposure | Titles, details and files are visible to the public only for `public` documents; private downloads return the same 404 as missing ones; storage keys and internal ids are never in responses. |
| Merkle second-preimage / proof forgery | Leaf/node domain separation and tested rejection of inner nodes, truncated and extended proofs; the contract, not the API, validates every proof. |
| Hash mismatches between components | One specification ([hashing.md](hashing.md)) pinned by shared vectors in all three test suites. |
| Chain reorganisations | Checkpoint hash comparison, rollback to the last common block and deterministic replay. |
| Secrets in code | None committed. Hardhat's public development keys appear only in tests and local docs. `.env` is git-ignored. The frontend contains no private keys; the dev wallet only exists in `vite dev` and forwards to a local node. |
| Abuse / DoS | Rate limits on auth, upload and verification; upload size cap; pagination caps. |

## Known gaps

- No independent audit of the contract has been performed.
- Registrations are public: fingerprints, addresses and timestamps are visible to everyone. Do not register fingerprints of documents whose *existence* is confidential.
- A fingerprint of low-entropy content can be guessed. Keep such documents private and add random content (a salt) before registering if needed.
- `PUBLIC_RPC_URL` is called directly by browsers; use a provider URL restricted by origin.
- Rate limiting is per client IP as seen by the app (configure the reverse proxy to pass the real IP).
