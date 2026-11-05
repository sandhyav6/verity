"""HTTP access to external data providers: timeouts, retries with backoff, per-provider rate
limiting, and honouring the provider's own rate-limit headers. No provider is ever substituted for
another: on failure the caller gets `SourceUnavailable` and must surface it."""

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

log = logging.getLogger(__name__)
USER_AGENT = "pm-testbed-data-worker/0.3 (educational test-token simulation; non-commercial)"


class SourceUnavailable(RuntimeError):
    """The provider could not be reached or kept failing after retries."""


class SourceRejected(RuntimeError):
    """The provider answered with a client error (bad request, forbidden...). Not retried."""


@dataclass(frozen=True)
class RawFetch:
    url: str  # the exact URL requested, including its query string
    status: int
    body: str
    retrieved_at: datetime
    duration_ms: int
    rate_limit_remaining: float | None


class HttpFetcher:
    def __init__(
        self,
        provider: str,
        *,
        min_interval: float = 0.2,
        timeout: float = 15.0,
        retries: int = 3,
        backoff: float = 1.0,
        max_wait: float = 60.0,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.provider = provider
        self.min_interval, self.retries, self.backoff, self.max_wait = min_interval, retries, backoff, max_wait
        self._sleep, self._clock = sleep, clock
        self._last_request = float("-inf")
        self._client = httpx.Client(timeout=timeout, transport=transport, headers={"User-Agent": USER_AGENT})

    def _throttle(self) -> None:
        wait = self._last_request + self.min_interval - self._clock()
        if wait > 0:
            self._sleep(wait)
        self._last_request = self._clock()

    def get(self, url: str, params: dict[str, str]) -> RawFetch:
        last_error = "unknown"
        for attempt in range(1, self.retries + 1):
            self._throttle()
            started = time.monotonic()
            try:
                resp = self._client.get(url, params=params)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                log.warning("%s request failed (attempt %d/%d): %s", self.provider, attempt, self.retries, last_error)
                self._sleep(min(self.backoff * 2 ** (attempt - 1), self.max_wait))
                continue

            elapsed = int((time.monotonic() - started) * 1000)
            remaining = _float(resp.headers.get("X-RateLimit-Remaining"))
            if resp.status_code == 429 or resp.status_code >= 500:
                last_error = f"HTTP {resp.status_code}"
                retry_after = _float(resp.headers.get("Retry-After"))
                delay = retry_after if retry_after is not None else self.backoff * 2 ** (attempt - 1)
                log.warning("%s HTTP %d (attempt %d/%d), waiting %.1fs", self.provider, resp.status_code, attempt, self.retries, delay)
                self._sleep(min(delay, self.max_wait))
                continue
            if resp.status_code >= 400:
                raise SourceRejected(f"{self.provider} answered HTTP {resp.status_code}: {resp.text[:200]}")

            if remaining is not None and remaining <= 0:  # provider says we are out of budget: back off
                reset = _float(resp.headers.get("X-RateLimit-Reset"))
                wait = max(0.0, (reset - time.time())) if reset else self.max_wait
                self._sleep(min(wait, self.max_wait))
            return RawFetch(
                url=str(resp.url), status=resp.status_code, body=resp.text,
                retrieved_at=datetime.now(timezone.utc), duration_ms=elapsed, rate_limit_remaining=remaining,
            )
        raise SourceUnavailable(f"{self.provider} unavailable after {self.retries} attempts ({last_error})")

    def close(self) -> None:
        self._client.close()


def _float(value: str | None) -> float | None:
    try:
        return float(value) if value is not None else None
    except ValueError:
        return None
