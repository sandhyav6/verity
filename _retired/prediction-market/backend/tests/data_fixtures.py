"""TEST FIXTURES ONLY. The payload shape was copied from a real Open-Meteo archive response observed
on 2026-11-04; the numbers are made up for tests and must never appear in the running application."""

import json
from datetime import date, timedelta

import httpx

from app.data_sources.http import HttpFetcher
from app.data_sources.weather import OpenMeteoSource


def payload(values: list, start: date = date(2026, 10, 1), lat=13.0, lon=80.25, unit="mm", days: list[str] | None = None) -> str:
    days = days or [(start + timedelta(days=i)).isoformat() for i in range(len(values))]
    return json.dumps({
        "latitude": lat, "longitude": lon, "generationtime_ms": 1.6, "utc_offset_seconds": 19800,
        "timezone": "Asia/Kolkata", "timezone_abbreviation": "GMT+5:30", "elevation": 12.0,
        "daily_units": {"time": "iso8601", "precipitation_sum": unit},
        "daily": {"time": days, "precipitation_sum": values},
    })


def source_returning(*responses, calls: list | None = None, sleeps: list | None = None) -> OpenMeteoSource:
    """An OpenMeteoSource whose HTTP layer replays `responses` in order (the last one repeats)."""
    queue = list(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(request)
        item = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(item, Exception):
            raise item
        return item

    fetcher = HttpFetcher(
        "open-meteo", min_interval=0.0, backoff=0.01, transport=httpx.MockTransport(handler),
        sleep=(sleeps.append if sleeps is not None else (lambda s: None)),
    )
    return OpenMeteoSource(fetcher)


def ok(body: str, **headers) -> httpx.Response:
    return httpx.Response(200, text=body, headers=headers)
