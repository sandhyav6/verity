"""mospi adapter: manual, hash-anchored submissions only (see manual.py for why nothing is crawled)."""

from app.data_sources.manual import MOSPI as SOURCE

__all__ = ["SOURCE"]
