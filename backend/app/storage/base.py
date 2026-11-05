"""Storage abstraction for document bytes. Business logic depends only on this protocol, so an
S3-compatible implementation can be added without touching routes or services."""

from collections.abc import Iterable, Iterator
from typing import Protocol


class StorageError(RuntimeError):
    pass


class Storage(Protocol):
    def save(self, key: str, chunks: Iterable[bytes]) -> int:
        """Write the chunks atomically under `key` (all-or-nothing, also if `chunks` raises). Returns bytes written."""

    def rename(self, source: str, destination: str) -> None: ...

    def open(self, key: str) -> Iterator[bytes]:
        """Stream the stored bytes. Raises StorageError if the key does not exist."""

    def exists(self, key: str) -> bool: ...

    def delete(self, key: str) -> None: ...
