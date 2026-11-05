"""Content-based file type detection. A filename extension is never trusted: the first bytes decide.

Documents can be archived formats and text, but never executables (a registry should not become a malware
host). Unknown binary formats are rejected rather than guessed.
"""

import codecs

EXECUTABLE_MAGIC: list[tuple[bytes, str]] = [
    (b"MZ", "Windows executable"),
    (b"\x7fELF", "Linux executable"),
    (b"\xfe\xed\xfa\xce", "macOS executable"),
    (b"\xfe\xed\xfa\xcf", "macOS executable"),
    (b"\xce\xfa\xed\xfe", "macOS executable"),
    (b"\xcf\xfa\xed\xfe", "macOS executable"),
    (b"\xca\xfe\xba\xbe", "Java class / universal binary"),
]

BINARY_MAGIC: list[tuple[bytes, str]] = [
    (b"%PDF-", "application/pdf"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"PK\x03\x04", "application/zip"),  # also .docx/.xlsx/.pptx/.jar
    (b"\x1f\x8b", "application/gzip"),
    (b"BZh", "application/x-bzip2"),
    (b"\xfd7zXZ\x00", "application/x-xz"),
    (b"7z\xbc\xaf\x27\x1c", "application/x-7z-compressed"),
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "application/x-ole-storage"),  # legacy .doc/.xls/.ppt
]


class UnsupportedFileType(ValueError):
    pass


def _looks_like_text(head: bytes) -> bool:
    if b"\x00" in head:
        return False
    try:
        codecs.getincrementaldecoder("utf-8")().decode(head.removeprefix(codecs.BOM_UTF8), final=False)
    except UnicodeDecodeError:
        return False
    return True


def detect_content_type(head: bytes) -> str:
    """Content type from the leading bytes (use ~8 KiB). Raises UnsupportedFileType for executables and unknowns."""
    if not head:
        raise UnsupportedFileType("the file is empty")
    for magic, label in EXECUTABLE_MAGIC:
        if head.startswith(magic):
            raise UnsupportedFileType(f"executable files are not accepted ({label})")
    for magic, content_type in BINARY_MAGIC:
        if head.startswith(magic):
            return content_type
    if head[257:262] == b"ustar":
        return "application/x-tar"
    if head[8:12] == b"WEBP" and head.startswith(b"RIFF"):
        return "image/webp"
    if head.lstrip().startswith(b"#!"):
        raise UnsupportedFileType("scripts are not accepted")
    if _looks_like_text(head):
        return "text/plain"
    raise UnsupportedFileType("unrecognised file type")
