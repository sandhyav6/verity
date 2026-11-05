"""Pure unit tests: fingerprints, canonical metadata, Merkle trees (against the cross-language vectors),
file type detection and storage. No database or chain needed."""

import hashlib
import json
from pathlib import Path

import pytest

from app.storage import LocalStorage, StorageError
from app.verity import merkle
from app.verity.filetypes import UnsupportedFileType, detect_content_type
from app.verity.hashing import InvalidHash, canonical_json, metadata_hash, normalize_hash, sha256_bytes, sha256_chunks, sha256_file

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "contracts" / "test" / "vectors.json").read_text(encoding="utf-8"))


def test_sha256_matches_known_vectors():
    for v in VECTORS["sha256"]:
        assert sha256_bytes(v["input_utf8"].encode()) == v["digest"]


def test_hash_is_of_bytes_not_names_and_streaming_equals_one_shot(tmp_path):
    data = b"%PDF-1.7\n" + bytes(range(256)) * 20_000  # ~5 MB
    a, b = tmp_path / "report-final.pdf", tmp_path / "x"
    a.write_bytes(data)
    b.write_bytes(data)
    expected = "0x" + hashlib.sha256(data).hexdigest()
    assert sha256_file(str(a)) == sha256_file(str(b)) == expected  # filename is irrelevant
    chunks = (data[i : i + 7919] for i in range(0, len(data), 7919))
    assert sha256_chunks(chunks) == expected


def test_one_flipped_bit_changes_the_fingerprint():
    data = bytearray(b"Verity registry test document\n")
    original = sha256_bytes(bytes(data))
    data[3] ^= 0x01
    assert sha256_bytes(bytes(data)) != original


def test_normalize_hash_accepts_canonical_forms_and_rejects_the_rest():
    good = "0x" + "ab" * 32
    assert normalize_hash(good) == good
    assert normalize_hash(good.upper().replace("0X", "0x")) == good
    assert normalize_hash("ab" * 32) == good
    for bad in ["", "0x", "0x" + "ab" * 31, "0x" + "ab" * 33, "0x" + "zz" * 32, "0x" + "ab" * 31 + "a", None, 5]:
        with pytest.raises(InvalidHash):
            normalize_hash(bad)  # type: ignore[arg-type]


def test_canonical_metadata_matches_cross_language_vectors():
    for m in VECTORS["metadata"]:
        assert canonical_json(m["value"]) == m["canonical"]
        assert metadata_hash(m["value"]) == m["sha256"]


def test_merkle_matches_cross_language_vectors_for_every_leaf():
    for v in VECTORS["merkle"]:
        assert merkle.merkle_root(v["hashes"]) == v["root"]
        proofs = merkle.proofs_for_all(v["hashes"])
        assert proofs == v["proofs"]
        for h, p in zip(v["hashes"], proofs):
            assert merkle.verify_proof(p, v["root"], h)


def test_merkle_rejects_wrong_proofs_and_empty_batches():
    v = VECTORS["merkle"][-1]
    h, proofs = v["hashes"], merkle.proofs_for_all(v["hashes"])
    assert not merkle.verify_proof(proofs[1], v["root"], h[0])
    assert not merkle.verify_proof(proofs[0][:-1], v["root"], h[0])
    assert not merkle.verify_proof(proofs[0], merkle.merkle_root(h[:-1]), h[0])
    with pytest.raises(ValueError):
        merkle.merkle_root([])


def test_inner_node_is_not_a_valid_leaf():
    hashes = VECTORS["merkle"][3]["hashes"]  # 4 leaves
    levels = merkle.build_levels(hashes)
    assert not merkle.verify_proof([levels[1][1]], levels[-1][0], levels[1][0])


@pytest.mark.parametrize("head,expected", [
    (b"%PDF-1.4\n...", "application/pdf"),
    (b"\x89PNG\r\n\x1a\n" + b"x" * 20, "image/png"),
    (b"\xff\xd8\xff\xe0" + b"x" * 20, "image/jpeg"),
    (b"PK\x03\x04" + b"x" * 20, "application/zip"),
    (b"\x1f\x8b\x08" + b"x" * 20, "application/gzip"),
    ("Hello, wörld — plain text\n".encode(), "text/plain"),
    (b'{"a": 1}', "text/plain"),
])
def test_detects_content_from_bytes(head, expected):
    assert detect_content_type(head) == expected


@pytest.mark.parametrize("head", [b"", b"MZ\x90\x00" + b"\x00" * 30, b"\x7fELF\x02\x01", b"#!/bin/sh\necho hi\n", b"\x00\x01\x02\x03\xfe\xfd binary junk"])
def test_rejects_executables_scripts_empty_and_unknown_binaries(head):
    with pytest.raises(UnsupportedFileType):
        detect_content_type(head)


def test_extension_is_irrelevant_to_detection():
    # an executable renamed ".pdf" is still an executable: detection never sees the name
    with pytest.raises(UnsupportedFileType):
        detect_content_type(b"MZ" + b"\x00" * 100)


def test_local_storage_roundtrip_atomic_write_and_key_safety(tmp_path):
    s = LocalStorage(tmp_path)
    assert s.save("abc/def", [b"hello ", b"world"]) == 11
    assert b"".join(s.open("abc/def")) == b"hello world"
    assert s.exists("abc/def")

    def failing():
        yield b"partial"
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        s.save("abc/broken", failing())
    assert not s.exists("abc/broken")
    assert not [p for p in (tmp_path / "abc").iterdir() if p.name.startswith(".part-")]  # no temp debris

    s.rename("abc/def", "xyz/moved")
    assert not s.exists("abc/def") and s.exists("xyz/moved")
    s.delete("xyz/moved")
    with pytest.raises(StorageError):
        s.open("xyz/moved")
    for bad in ["../escape", "/abs", "a/../../b", "a//b", "UPPER", ".hidden", ""]:
        with pytest.raises(StorageError):
            s.save(bad, [b"x"])
