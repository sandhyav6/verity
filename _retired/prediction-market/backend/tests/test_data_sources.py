import time
from datetime import date
from decimal import Decimal

import httpx
import pytest

from app.data_sources.base import sha256_hex
from app.data_sources.http import HttpFetcher, SourceRejected, SourceUnavailable
from app.data_sources.weather import DataNotYetAvailable, WeatherQuery
from tests.data_fixtures import ok, payload, source_returning


def query(start=date(2026, 10, 1), end=date(2026, 10, 5), **kw):
    return WeatherQuery("Chennai", Decimal("13.0827"), Decimal("80.2707"), start, end, **kw)


def test_complete_period_is_summed_exactly_with_full_provenance():
    body = payload([20.9, 0.8, 0.0, 12.25, 3.05])
    calls = []
    rec = source_returning(ok(body), calls=calls).ingest(query())
    assert rec.validation_status == "valid" and rec.normalized_value == Decimal("37.00") and rec.unit == "mm"
    assert rec.raw_payload == body and rec.raw_payload_hash == sha256_hex(body)  # raw bytes kept, hash matches
    assert (rec.latitude, rec.longitude) == (Decimal("13.0"), Decimal("80.25"))  # the grid point, not what we asked for
    assert rec.provider == "open-meteo" and rec.dataset == "era5" and "reanalysis" in rec.transformation
    assert "Open-Meteo.com" in rec.attribution and "CC BY 4.0" in rec.attribution
    assert rec.observed_at.isoformat() == "2026-10-05T18:29:59+00:00"  # end of 5 Oct in IST (+05:30), in UTC
    assert rec.ingestion_ms is not None and rec.retrieved_at.tzinfo is not None

    params = dict(calls[0].url.params)
    assert calls[0].url.host == "archive-api.open-meteo.com" and params["models"] == "era5"
    assert params["daily"] == "precipitation_sum" and params["start_date"] == "2026-10-01" and params["end_date"] == "2026-10-05"
    assert rec.source_url == str(calls[0].url)  # the exact URL is the provenance


def test_missing_days_make_the_record_incomplete_and_withhold_the_total():
    rec = source_returning(ok(payload([5.0, 1.0, None, None, None]))).ingest(query())
    assert rec.validation_status == "incomplete"
    assert rec.normalized_value is None  # a partial sum must never look like a final total
    assert any("3 of 5 days" in n or "missing days" in n for n in rec.validation_notes)
    assert any("partial sum" in n and "6.0" in n for n in rec.validation_notes)


@pytest.mark.parametrize(
    "body, fragment",
    [
        (payload([1.0, -3.0, 0.0, 0.0, 0.0]), "implausible"),  # negative rainfall
        (payload([1.0, 5000.0, 0.0, 0.0, 0.0]), "implausible"),  # absurd magnitude
        (payload([1.0] * 5, unit="inch"), "unexpected unit"),
        (payload([1.0] * 4), "different set of days"),  # a day missing from the response
        (payload([1.0] * 5, days=["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"]), "different set of days"),
        ("not json at all", "unparseable"),
        ('{"daily": {}}', "unparseable"),
        (payload(["x", 1, 1, 1, 1]), "non-numeric"),
    ],
)
def test_bad_provider_data_is_marked_invalid_not_trusted(body, fragment):
    rec = source_returning(ok(body)).ingest(query())
    assert rec.validation_status == "invalid" and rec.normalized_value is None
    assert fragment in rec.validation_notes[0]
    assert rec.raw_payload_hash == sha256_hex(body)  # even bad payloads keep their evidence


def test_query_validation_rejects_bad_requests_before_any_network_call():
    with pytest.raises(ValueError):
        query(model="gfs")
    with pytest.raises(ValueError):
        query(start=date(2026, 10, 5), end=date(2026, 10, 1))
    with pytest.raises(ValueError):
        WeatherQuery("x", Decimal(95), Decimal(0), date(2026, 1, 1), date(2026, 1, 2))
    with pytest.raises(ValueError):
        query(start=date(2024, 1, 1), end=date(2026, 1, 1))


def test_transient_server_errors_are_retried_with_backoff():
    sleeps, calls = [], []
    src = source_returning(httpx.Response(503), httpx.Response(500), ok(payload([1.0] * 5)), calls=calls, sleeps=sleeps)
    rec = src.ingest(query())
    assert rec.validation_status == "valid" and len(calls) == 3
    assert len(sleeps) >= 2 and sleeps[1] > sleeps[0] > 0  # exponential backoff


def test_rate_limit_response_honours_retry_after():
    sleeps = []
    src = source_returning(httpx.Response(429, headers={"Retry-After": "7"}), ok(payload([1.0] * 5)), sleeps=sleeps)
    assert src.ingest(query()).validation_status == "valid"
    assert 7.0 in sleeps


def test_persistent_failure_raises_and_never_substitutes_another_source():
    calls = []
    src = source_returning(httpx.ConnectTimeout("slow"), calls=calls)
    with pytest.raises(SourceUnavailable):
        src.ingest(query())
    assert len(calls) == 3  # bounded retries
    assert {c.url.host for c in calls} == {"archive-api.open-meteo.com"}  # no fallback host or provider


def test_client_errors_are_not_retried():
    calls = []
    src = source_returning(httpx.Response(400, text='{"reason":"bad request"}'), calls=calls)
    with pytest.raises(SourceRejected):
        src.ingest(query())
    assert len(calls) == 1


def out_of_range(latest: str) -> httpx.Response:  # the provider's real wording, observed 2026-11-05
    return httpx.Response(400, text=f"""{{"reason":"Parameter 'end_date' is out of allowed range from 1940-01-01 to {latest}","error":true}}""")


def test_period_running_past_the_providers_latest_date_is_fetched_up_to_it_and_marked_incomplete():
    calls = []
    src = source_returning(out_of_range("2026-10-03"), ok(payload([2.0, 3.0, 1.5])), calls=calls)
    rec = src.ingest(query())  # 1-5 Oct requested, provider has data up to 3 Oct
    assert [dict(c.url.params)["end_date"] for c in calls] == ["2026-10-05", "2026-10-03"]
    assert rec.validation_status == "incomplete" and rec.normalized_value is None  # never a total
    assert rec.period_end == date(2026, 10, 5) and rec.source_url == str(calls[1].url)  # requested period, real URL
    assert "no data after 2026-10-03" in rec.validation_notes[0] and "2 of 5" in rec.validation_notes[0]
    assert any("partial sum" in n and "6.5" in n for n in rec.validation_notes)


def test_period_entirely_after_the_providers_latest_date_is_not_yet_available():
    calls = []
    with pytest.raises(DataNotYetAvailable) as exc:
        source_returning(out_of_range("2026-09-20"), calls=calls).ingest(query())
    assert exc.value.latest == date(2026, 9, 20) and len(calls) == 1


def test_other_out_of_range_rejections_are_passed_through():
    with pytest.raises(SourceRejected):
        source_returning(out_of_range("2026-10-09")).ingest(query())  # range is not the problem: do not mask it


def test_provider_budget_exhaustion_makes_the_client_wait():
    sleeps = []
    reset = str(int(time.time()) + 20)
    src = source_returning(ok(payload([1.0] * 5), **{"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": reset}), sleeps=sleeps)
    src.ingest(query())
    assert any(10 < s <= 21 for s in sleeps)


def test_requests_are_throttled_to_the_minimum_interval():
    sleeps = []
    ticks = iter([0.0, 0.0, 0.01, 0.01, 0.02, 0.02, 0.03, 0.03])
    fetcher = HttpFetcher(
        "t", min_interval=0.5, transport=httpx.MockTransport(lambda r: httpx.Response(200, text="{}")),
        sleep=sleeps.append, clock=lambda: next(ticks),
    )
    fetcher.get("https://example.invalid/x", {})
    fetcher.get("https://example.invalid/x", {})
    assert sleeps and sleeps[0] == pytest.approx(0.49, abs=0.02)
