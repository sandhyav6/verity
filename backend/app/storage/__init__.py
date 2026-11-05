from functools import lru_cache

from app.core.config import get_settings
from app.storage.base import Storage, StorageError
from app.storage.local import LocalStorage

__all__ = ["Storage", "StorageError", "LocalStorage", "get_storage"]


@lru_cache
def _build(backend: str, directory: str) -> Storage:
    if backend == "local":
        return LocalStorage(directory)  # type: ignore[return-value]
    raise ValueError(f"unknown storage backend {backend!r}")


def get_storage() -> Storage:
    """FastAPI dependency; tests override it (or change STORAGE_DIR and clear get_settings)."""
    s = get_settings()
    return _build(s.storage_backend, str(s.storage_dir))
