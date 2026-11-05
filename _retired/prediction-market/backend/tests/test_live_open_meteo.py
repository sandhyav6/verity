"""Talks to the REAL Open-Meteo API. Excluded from the default run (`-m "not live"`) because it needs
the network and the provider's data changes; run it with:  python -m pytest -m live

It asserts structure and invariants only, never specific rainfall values."""

from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.data_sources.weather import OpenMeteoSource, WeatherQuery

pytestmark = pytest.mark.live


def chennai(start: date, end: date) -> WeatherQuery:
    return WeatherQuery("Chennai", Decimal("13.0827"), Decimal("80.2707"), start, end)


def test_settled_period_is_complete_and_snapped_to_the_model_grid():
    today = date.today()
    rec = OpenMeteoSource().ingest(chennai(today - timedelta(days=60), today - timedelta(days=50)))
    assert rec.validation_status == "valid", rec.validation_notes
    assert rec.normalized_value is not None and rec.normalized_value >= 0 and rec.unit == "mm"
    assert (rec.latitude, rec.longitude) != (Decimal("13.0827"), Decimal("80.2707"))  # snapped to the 0.25 degree grid
    assert abs(rec.latitude - Decimal("13.0827")) <= Decimal("0.25")
    assert rec.source_url.startswith("https://archive-api.open-meteo.com/v1/archive")


def test_the_most_recent_days_are_not_available_yet():
    # The provider rejects (HTTP 400) an end_date later than its own latest date, which can be a day behind our
    # local date, so ask for the last days it will accept.
    yesterday = date.today() - timedelta(days=1)
    rec = OpenMeteoSource().ingest(chennai(yesterday - timedelta(days=2), yesterday))
    assert rec.validation_status == "incomplete" and rec.normalized_value is None  # reanalysis lags several days


def test_a_period_ending_after_the_providers_latest_date_is_incomplete_not_an_error():
    # Open-Meteo rejects end dates past its latest day with HTTP 400; the adapter fetches up to that day instead.
    today = date.today()
    rec = OpenMeteoSource().ingest(chennai(today - timedelta(days=10), today + timedelta(days=3)))
    assert rec.validation_status == "incomplete" and rec.normalized_value is None
    assert rec.period_end == today + timedelta(days=3)
    assert "no data after" in rec.validation_notes[0]
