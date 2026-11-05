# Real-world data sources (Phase 3, as implemented)

Principle: no number in the Data Explorer or in any resolution evidence is invented. Every record carries provider, exact source URL, retrieval time, observation period, raw payload (or document) hash, normalized value, unit, transformation, validation status and freshness. Records are **append-only**: a revised value is a new row linked by `supersedes_id`; the original is never changed. External data lives in its own table and endpoints (`/data/*`, every item `is_external_data: true`) and is never mixed into blockchain analytics.

## Source spike results (checked 2026-11-04)

| Source | What I found | Decision |
|---|---|---|
| **Open-Meteo** archive API | Documented endpoint, free for **non-commercial** use (<600/min, <5,000/h, <10,000/day, per IP), **CC BY 4.0 attribution required**. Serves **reanalysis** (ERA5 / ERA5-Land, ~5 day delay), not station observations. Live checks: the requested point is snapped to a 0.25-degree grid (asked 13.0827, 80.2707 -> got 13.0, 80.25); the newest ~6 days are `null`; responses carry `X-RateLimit-*` headers. | **Automated** (the only automated source) |
| **RBI** (rbi.org.in) | Publishes the policy repo rate and MPC press releases as pages/PDFs; an RSS link exists. The site states "All Rights Reserved" and its disclaimer prohibits caching/framing and linking to internal pages without permission; I found no statement permitting automated access. | **Manual submission only; not crawled** |
| **MoSPI** (mospi.gov.in) / **data.gov.in** | mospi.gov.in failed TLS certificate validation from my fetcher; data.gov.in returned HTTP 403 to automated fetching. data.gov.in is said to have a keyed API but I could not read its manual. | **Manual submission only** (not verified further) |
| **ISRO** (isro.gov.in) | Announcements are HTML pages; no feed or API; "Website Policy" page exists but its content was not readable to me. | **Manual submission only** |
| **BCCI / ESPNcricinfo** | Terms not checked; ESPNcricinfo is a commercial site. No licensed free API identified. | **Manual submission only**, no scraping, no invented results |

I read each source's terms only as far as the fetched summaries allowed; none of this is legal advice. Re-check terms before any public deployment.

## How data gets in

* **Automated (Open-Meteo):** `data_sources/weather.py` + `http.py` — 15 s timeout, 3 attempts with exponential backoff, `Retry-After` honoured, 0.25 s minimum interval, waits when the provider reports a zero budget, 4xx not retried, **no fallback to another provider or to old data** (failure raises `SourceUnavailable`). The worker (`python -m app.workers.data_worker`, every 6 h, advisory-locked) refreshes only the periods that active markets' `data_rule` need.
* **Manual (RBI, MoSPI, ISRO, BCCI, ESPNcricinfo):** an admin (`ADMIN_ADDRESSES`) calls `POST /data/submissions` with the official https URL (host allow-listed per provider), the SHA-256 of the archived document, retrieval time, period, publication date and value/text. Validation: plausible numeric ranges (e.g. repo rate 0-20 %), publication date required and not before the period it reports (a period ending does not mean it is published), no future timestamps. Stored as `manual_submitted`: **the backend did not fetch or verify the document.**

## Validation statuses

`valid` (all days present, plausible) · `incomplete` (some days null: the total is **withheld**, a partial sum appears only in the notes) · `invalid` (unparseable, wrong days/units, negative or absurd values) · `manual_submitted`.

## Weather and resolution

A weather market may carry a structured `data_rule` (location, grid-agnostic coordinates, period, model, operator, threshold). Creation is rejected if the market text promises IMD/station observations while the rule uses Open-Meteo, and the API exposes a note that such markets resolve from **reanalysis, not ground-station data**. `POST /resolutions/{id}/draft-from-data` (RESOLVER_ROLE wallets) fetches the data and returns a **draft** for a human: suggested outcome, evidence fields with the raw-payload hash and a link to the exact bytes. It stores no evidence and sends nothing on-chain. Incomplete data returns 409 until the resolution deadline, then an `INVALID` draft. A value exactly on the threshold is flagged. If the provider's numbers for the period changed since the last fetch, the draft warns about the revision, and the market's revision policy decides which version counts.

## Attribution (required by Open-Meteo's licence)

Every weather record carries: "Weather data by Open-Meteo.com (CC BY 4.0, https://open-meteo.com/en/license); contains ERA5 reanalysis data." The frontend must display it next to weather data (Phase 4). Open-Meteo's free tier is non-commercial; this project is a non-commercial educational simulation.

## Not done

No automated RBI/MoSPI/ISRO/cricket ingestion (deliberate, see above); no IMD station integration; only the `precipitation_sum` variable; the database starts empty, so the Data Explorer shows real data only after an admin triggers a refresh or a weather market exists. Nothing was pre-loaded.
