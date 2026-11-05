from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import DateTime, Numeric, text
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.types import TypeDecorator

# uint256 fits in 78 decimal digits; signed P&L gets two spare digits. Never floats.
UINT = Numeric(78, 0)
SINT = Numeric(80, 0)
PRICE = Numeric(40, 18)


class UTCDateTime(TypeDecorator):
    """timestamptz that rejects naive datetimes so everything is stored and returned in UTC."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is None:
            raise ValueError("naive datetime not allowed; use timezone-aware UTC")
        return value.astimezone(timezone.utc) if value is not None else None

    def process_result_value(self, value, dialect):
        return value.astimezone(timezone.utc) if value is not None else None


class Base(DeclarativeBase):
    pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_int(value: Decimal | int | None) -> int:
    """Numeric(…,0) comes back as Decimal; convert exactly."""
    return int(value) if value is not None else 0


NOW_SQL = text("now()")
