# Legal and product constraints

**This is not legal advice, and nothing here claims the project is compliant with any law.** It documents the design choices made to keep the project a test-only educational and technical demonstration, and the questions a qualified lawyer must answer before any public or commercial use.

## References named in the brief

* India Code: https://www.indiacode.nic.in/indiacode/handle/123456789/22148
* Official Act PDF: https://www.meity.gov.in/static/uploads/2025/10/8a7f103cefc68ed8aaa2ebc9a2ed7c13.pdf
* PIB announcement: https://www.pib.gov.in/PressReleasePage.aspx?PRID=2241804&lang=2&reg=48
* PIB Rules information: https://www.pib.gov.in/PressNoteDetails.aspx?ModuleId=3&NoteId=158400&lang=1&reg=44

## What the Act says (read 2026-11-05) and how it relates to this design

I read the full text of the Act (Act No. 32 of 2025, the MeitY PDF linked above, 9 pages, including the corrigenda of 28.08.2025) and the PIB backgrounder of 30 April 2026 on the Rules. **I did not read the text of the Promotion and Regulation of Online Gaming Rules, 2026 themselves**, only that government summary. This section is a reading aid for a lawyer, not an opinion.

**Definitions that matter (section 2(1)), paraphrased:**

* **(f) online game:** any game played on an electronic or digital device and run as software over the internet. A prediction-market simulator plausibly falls under this very wide definition; nothing here assumes it does not.
* **(g) online money game:** an online game (skill, chance or both) where the user pays fees or deposits *money or other stakes* expecting to win *monetary and other enrichment* in return. E-sports are excluded.
* **(j) other stakes:** anything recognised as equivalent or convertible to money, *including credits, coins, tokens*, real or virtual, **which is purchased by paying money directly or indirectly**, or as part of or in relation to an online game.
* **(i) online social game:** no staking of money or other stakes, no participation with the expectation of monetary gain; may charge a subscription or one-time access fee that is not a stake; offered solely for entertainment, recreation or skill development.

**Prohibitions and penalties:** offering an online money game or service (s.5; up to 3 years and/or up to ₹1 crore, s.9(1); cognizable and non-bailable, s.10); advertising or promoting one (s.6; up to 2 years and/or ₹50 lakh); banks or anyone facilitating payments towards one (s.7). Section 8(3) requires *every* person offering any online game, money game or not, to comply with directions and codes of practice of the Government or the Online Gaming Authority, and the Authority can decide whether a particular game is a money game (s.8(2)(a)). Per the PIB note, the Rules (in force from 1 May 2026) set up that determination process (factors include payment of stakes, expectation of monetary winnings, revenue model and *monetisation of in-game assets outside the game*), optional or notified registration, and user-safety features such as age gating, time limits and grievance redressal.

**How the design lines up with those words (not a conclusion):**

| Element of "online money game" | This project |
|---|---|
| Fees, money deposited | None. There is no payment code, no fee, no deposit. |
| "Other stakes" = tokens *purchased* with money, or *convertible* to money | Test tokens come only from a free faucet; they cannot be bought, sold, transferred to another person or redeemed. That is the reason those restrictions exist. |
| Expectation of "monetary and other enrichment" | Winnings are more valueless test tokens. Whether "other enrichment" could cover anything non-monetary (leaderboards, status) is a question for a lawyer; the project has no prizes or leaderboard rewards. |
| Monetisation outside the game (Rules, per PIB) | None in-system; a public-chain deployment cannot technically stop a third party from building a market for the tokens (question 4 below). |

What this means in practice: the definitions turn on money, purchased or convertible stakes, and monetary winnings, which the design deliberately removes. But the Act is broad, the Authority decides classification case by case, s.8(3) and the Rules' safety obligations apply to online games generally, and I have not read the Rules' text. **So this document still does not say the project is compliant or outside the Act.** If it is ever offered to the public, the realistic options are a lawyer's opinion and, possibly, an application to the Authority for a determination.

## Constraint → what the design does

| Constraint | Design choice | Where |
|---|---|---|
| No real-money betting, entry fees, prizes, INR deposits, cash withdrawals, conversion or redemption of tokens | No payment code, no gateway, no purchase function, no redemption for anything of value; users get tokens only from a rate-limited faucet (the deployer can also mint, to fund market creators; that power can be renounced); tokens cannot be sold in-system | `TestToken`, absence of any payment integration |
| Tokens must not look like money | Named and documented as TEST credits; no ₹/$/currency symbol is shown next to any amount (amounts say "tokens"); disclaimers on every page, in the footer, in API responses and in contract documentation | frontend, `/health`, NatSpec |
| Prefer non-transferable credits | The token is ERC-20 *interface-compatible* but transfers are **restricted**: only to/from the factory, the resolution manager and market contracts, so no peer-to-peer transfers, no exchange listing, no sale to another person | `TestToken._update` (tested) |
| No purchase of test credits | Faucet only; supply hard-capped; minting by the deployer can be renounced | `TestToken` |
| No misleading representation | "Indicative value" is labelled as not a redemption value; the UI states test-only wherever tokens appear; resolution trust limits are stated, not hidden | portfolio, oracle docs |
| No mainnet / production network | No mainnet network is configured; `deploy.ts` refuses every chain id except local and Sepolia | `deploy.ts`, `docs/security.md` |
| Legal review before public or commercial use | Stated in the README and here | README section 14 |

## Questions for a lawyer (not answered here)

1. Is a free, non-transferable, valueless-token simulation of event-outcome forecasting an "online social game" under s.2(1)(i), and does it need registration under the 2026 Rules? Could winning test tokens count as "other enrichment" under s.2(1)(g)? Does it matter that outcomes depend on real-world events rather than a game of chance or skill?
2. Do the restrictions here (no transfer between people, no purchase, no redemption, faucet only) suffice, or is anything else required (age gating, KYC-like checks, registration, disclosures, geo-blocking, record-keeping)?
3. Is *advertising or promoting* such a simulator regulated differently from operating it?
4. How do prohibitions on facilitating real-money gaming apply if third parties later build bridges or markets for the tokens (which the design tries to make impossible but cannot prevent in a public chain deployment)?
5. If the project is shown in interviews or published, what notices are required?
6. Data licences: Open-Meteo's free tier is non-commercial and requires CC BY 4.0 attribution; the terms of RBI, MoSPI, data.gov.in, ISRO, BCCI and ESPNcricinfo were only partly readable to me (see `data-sources.md`). Does the intended use comply with each?

## Operating rules until that review happens

Local or private testnet use only; no public launch, no marketing as a betting or trading product, no integration with payments or exchanges, no mainnet deployment, no use of real personal data beyond wallet addresses.
