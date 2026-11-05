"""Filesystem storage for development and single-node deployments."""

import os
import re
import tempfile
from collections.abc import Iterable, Iterator
from pathlib import Path

from app.storage.base import StorageError

_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_.\-]*(/[a-z0-9][a-z0-9_.\-]*)*$")
CHUNK = 1024 * 1024


class LocalStorage:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        if not _KEY_RE.match(key) or ".." in key:
            raise StorageError("invalid storage key")
        path = (self.root / key).resolve()
        if self.root not in path.parents:
            raise StorageError("storage key escapes the storage root")
        return path

    def save(self, key: str, chunks: Iterable[bytes]) -> int:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".part-")
        written = 0
        try:
            with os.fdopen(fd, "wb") as f:
                for chunk in chunks:
                    f.write(chunk)
                    written += len(chunk)
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
        return written

    def rename(self, source: str, destination: str) -> None:
        src, dst = self._path(source), self._path(destination)
        if not src.exists():
            raise StorageError("source object does not exist")
        dst.parent.mkdir(parents=True, exist_ok=True)
        os.replace(src, dst)

    def open(self, key: str) -> Iterator[bytes]:
        path = self._path(key)
        if not path.is_file():
            raise StorageError("object does not exist")

        def stream() -> Iterator[bytes]:
            with open(path, "rb") as f:
                while chunk := f.read(CHUNK):
                    yield chunk

        return stream()

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)
