"""Document fingerprints and metadata hashes.

Fingerprint = SHA-256 of the raw file bytes, represented everywhere as "0x" + 64 lowercase hex characters
(the exact bytes32 stored in the VerityRegistry contract). Filenames, paths and encodings never take part.
"""

import hashlib
import json
import re
from collections.abc import Iterable

CHUNK_SIZE = 1024 * 1024
HASH_RE = re.compile(r"^0x[0-9a-f]{64}$")


class InvalidHash(ValueError):
    pass


def normalize_hash(value: str) -> str:
    """Return the canonical lowercase 0x-prefixed form of a 32-byte hash, or raise InvalidHash."""
    if not isinstance(value, str):
        raise InvalidHash("hash must be a string")
    v = value.strip().lower()
    if len(v) == 64:  # tolerate a missing 0x prefix on input only
        v = "0x" + v
    if not HASH_RE.match(v):
        raise InvalidHash("hash must be 32 bytes as 64 hexadecimal characters (SHA-256)")
    return v


def sha256_chunks(chunks: Iterable[bytes]) -> str:
    h = hashlib.sha256()
    for c in chunks:
        h.update(c)
    return "0x" + h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return "0x" + hashlib.sha256(data).hexdigest()


def sha256_file(path: str) -> str:
    """Streaming hash of a file on disk (constant memory)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(CHUNK_SIZE):
            h.update(chunk)
    return "0x" + h.hexdigest()


def canonical_json(value: object) -> str:
    """Deterministic JSON: sorted keys, no whitespace, UTF-8 (not \\u-escaped). Values must be strings or
    nested objects of strings so the TypeScript implementation (frontend/src/lib/hash.ts) is byte-identical."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def metadata_hash(value: object) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))
