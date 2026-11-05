"""Cricket adapters (BCCI, ESPNcricinfo): manual, hash-anchored submissions only. Automated ingestion is
deferred until a source with permissive, verified terms is identified; no results are ever invented."""

from app.data_sources.manual import BCCI, ESPNCRICINFO

__all__ = ["BCCI", "ESPNCRICINFO"]
