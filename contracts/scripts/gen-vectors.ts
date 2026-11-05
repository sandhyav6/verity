// Regenerates test/vectors.json: cross-language test vectors shared by the contract, backend and frontend tests.
//   npm run vectors
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { buildTree, proofFor, sampleHash } from "../test/merkle.ts";

const sha256 = (s: string | Buffer) => "0x" + createHash("sha256").update(s).digest("hex");

/** Same algorithm as frontend/src/lib/hash.ts canonicalJson: recursively sorted keys, no whitespace. */
const canonicalJson = (v: unknown): string =>
  v !== null && typeof v === "object"
    ? "{" + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson((v as Record<string, unknown>)[k])).join(",") + "}"
    : JSON.stringify(v);

const batches = [1, 2, 3, 4, 5, 7].map((n) => {
  const hashes = Array.from({ length: n }, (_, i) => sampleHash(i + n * 100));
  return { hashes, root: buildTree(hashes).root, proofs: hashes.map((_, i) => proofFor(hashes, i)) };
});

const out = {
  sha256: [
    { input_utf8: "", digest: sha256("") },
    { input_utf8: "abc", digest: sha256("abc") },
    { input_utf8: "Verity registry test document\n", digest: sha256("Verity registry test document\n") },
  ],
  // canonical metadata JSON: keys sorted recursively, no whitespace, UTF-8, string values only
  metadata: [
    { title: "Degree Certificate", issued_to: "A. Student" },
    { z: "last", a: "first", note: "caf\u00e9 \"quoted\"\n tab\t slash\\ \u2028 \u{1F600}" },
    { title: "Nested", attributes: { b: "2", a: "1" }, document_type: "audit_report" },
  ].map((value) => {
    const canonical = canonicalJson(value);
    return { value, canonical, sha256: sha256(canonical) };
  }),
  merkle: batches,
};
writeFileSync(new URL("../test/vectors.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("wrote test/vectors.json");
