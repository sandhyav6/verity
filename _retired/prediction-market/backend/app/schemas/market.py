import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.common import WeiStr

Category = Literal["economy", "weather", "sports", "technology"]
MIN_B, MAX_B = Decimal(10), Decimal(100_000)


class ResolutionSource(BaseModel):
    name: str = Field(min_length=3, max_length=120)
    url: str = Field(pattern=r"^https?://\S+$", max_length=500)
    dataset: str = Field(min_length=3, max_length=200, description="Exact dataset/station/endpoint used")


class ResolutionSpec(BaseModel):
    """What makes a market objectively resolvable. Every field is required on purpose."""

    measurement: str = Field(min_length=5, max_length=300)
    unit: str = Field(min_length=1, max_length=40)
    observation_period: str = Field(min_length=5, max_length=200)
    revision_policy: str = Field(min_length=10, max_length=300, description="First publication or final revision?")
    missing_data_policy: str = Field(min_length=10, max_length=300)


class WeatherDataRule(BaseModel):
    """Machine-checkable resolution rule, so a data-backed DRAFT can be produced for a human resolver.

    Resolves from Open-Meteo reanalysis (a model, not station observations): the rule says so and
    the market text must not promise IMD station data."""

    provider: Literal["open-meteo"] = "open-meteo"
    model: Literal["era5", "era5_land"] = "era5"
    variable: Literal["precipitation_sum"] = "precipitation_sum"
    aggregation: Literal["sum"] = "sum"
    location: str = Field(min_length=2, max_length=80)
    latitude: Decimal = Field(ge=-90, le=90)
    longitude: Decimal = Field(ge=-180, le=180)
    start_date: date
    end_date: date
    operator: Literal[">", ">=", "<", "<="]
    threshold: Decimal = Field(ge=0, le=100_000)
    unit: Literal["mm"] = "mm"

    @model_validator(mode="after")
    def _period(self):
        if self.end_date < self.start_date or (self.end_date - self.start_date).days >= 366:
            raise ValueError("data_rule period must be 1 to 366 days with end_date >= start_date")
        return self


class MarketCreate(BaseModel):
    question: str = Field(min_length=15, max_length=300)
    description: str = Field(min_length=20, max_length=3000)
    category: Category
    yes_definition: str = Field(min_length=5, max_length=300)
    no_definition: str = Field(min_length=5, max_length=300)
    resolution_source: ResolutionSource
    resolution_criteria: str = Field(min_length=30, max_length=2000)
    resolution_spec: ResolutionSpec
    trading_close_time: datetime
    resolution_deadline: datetime
    liquidity_parameter: Decimal = Field(description="b, in whole test tokens (10 to 100,000)")
    data_rule: WeatherDataRule | None = None

    @field_validator("question")
    @classmethod
    def _is_a_question(cls, v: str) -> str:
        v = v.strip()
        if not v.endswith("?"):
            raise ValueError("question must end with '?' and be answerable YES or NO")
        return v

    @field_validator("trading_close_time", "resolution_deadline")
    @classmethod
    def _aware_utc(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            raise ValueError("timestamps must include a timezone (use UTC)")
        return v.astimezone(timezone.utc)

    @field_validator("liquidity_parameter")
    @classmethod
    def _b_range(cls, v: Decimal) -> Decimal:
        if not (MIN_B <= v <= MAX_B):
            raise ValueError(f"liquidity_parameter must be between {MIN_B} and {MAX_B} test tokens")
        if v != v.to_integral_value():
            raise ValueError("liquidity_parameter must be a whole number of tokens")
        return v

    @model_validator(mode="after")
    def _dates(self):
        now = datetime.now(timezone.utc)
        if self.trading_close_time < now + timedelta(hours=1):
            raise ValueError("trading_close_time must be at least 1 hour in the future")
        if self.resolution_deadline <= self.trading_close_time:
            raise ValueError("resolution_deadline must be after trading_close_time")
        if self.yes_definition.strip().lower() == self.no_definition.strip().lower():
            raise ValueError("YES and NO definitions must differ")
        if self.data_rule is not None:
            if self.category != "weather":
                raise ValueError("data_rule (Open-Meteo) is only valid for weather markets")
            if "open-meteo.com" not in self.resolution_source.url.lower():
                raise ValueError("resolution_source.url must be open-meteo.com when a data_rule is given")
            claimed = " ".join([self.resolution_criteria, self.resolution_source.name, self.resolution_source.dataset, self.question])
            if re.search(r"\b(IMD|India Meteorological|station)\b", claimed, re.IGNORECASE):
                raise ValueError(
                    "market text promises IMD/station observations but data_rule resolves from Open-Meteo "
                    "reanalysis; do not mix the two"
                )
        return self


class FactoryParams(BaseModel):
    """Exactly what the wallet passes to MarketFactory.createMarket(...)."""

    metadataHash: str
    category: int
    tradingClose: int
    resolutionDeadline: int
    liquidityB: WeiStr


class MarketCreateOut(BaseModel):
    metadata_hash: str
    factory_params: FactoryParams
    factory_address: str
    note: str


class MarketOut(BaseModel):
    id: int  # on-chain market id (stable across read-model rebuilds)
    contract_address: str
    question: str
    description: str | None
    category: str
    yes_definition: str | None
    no_definition: str | None
    resolution_source: dict | None
    resolution_criteria: str | None
    resolution_spec: dict | None
    data_rule: dict | None
    resolution_data_note: str | None
    metadata_verified: bool = Field(description="keccak256 of stored metadata equals the on-chain hash")
    metadata_hash: str
    status: Literal["active", "closed", "resolved", "invalid"]
    winning_outcome: str | None
    yes_price: Decimal
    no_price: Decimal
    liquidity_parameter: WeiStr
    q_yes: WeiStr
    q_no: WeiStr
    collateral: WeiStr
    volume: WeiStr
    trade_count: int
    created_by: str
    created_at: datetime
    trading_close_time: datetime
    resolution_deadline: datetime
    resolved_at: datetime | None


class SnapshotOut(BaseModel):
    block_number: int
    timestamp: datetime
    yes_price: Decimal
    q_yes: WeiStr
    q_no: WeiStr
    transaction_hash: str
