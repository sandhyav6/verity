import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** Fingerprint = SHA-256 of the exact file bytes, as 0x + 64 lowercase hex (the contract's bytes32). */
export const HASH_RE = /^0x[0-9a-f]{64}$/;
const CHUNK = 4 * 1024 * 1024;

export function normalizeHash(value: string): string | null {
  let v = value.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(v)) v = "0x" + v;
  return HASH_RE.test(v) ? v : null;
}

/**
 * Streaming SHA-256 of a File: reads 4 MiB slices so memory stays flat for large files. Only the bytes are
 * hashed; the filename, type and modification time never take part. Hashing happens locally in the browser.
 */
export async function sha256File(file: Blob, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<string> {
  const h = sha256.create();
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    if (signal?.aborted) throw new DOMException("Hashing cancelled", "AbortError");
    h.update(new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer()));
    onProgress?.(Math.min(1, (offset + CHUNK) / file.size));
  }
  onProgress?.(1);
  return "0x" + bytesToHex(h.digest());
}

export function sha256Bytes(data: Uint8Array): string {
  return "0x" + bytesToHex(sha256(data));
}

export function sha256Text(text: string): string {
  return sha256Bytes(new TextEncoder().encode(text));
}

/** Deterministic JSON: recursively sorted keys, no whitespace. Byte-identical to backend `canonical_json`. */
export function canonicalJson(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function randomBytes32(): `0x${string}` {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${bytesToHex(b)}`;
}
