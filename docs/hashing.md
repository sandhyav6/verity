# Hashing and Merkle specification

This is the contract between the Solidity contract, the Python backend and the TypeScript frontend. All three must agree byte for byte. They are pinned by `contracts/test/vectors.json` (regenerate with `cd contracts && npm run vectors`), which the contract tests (`batch.test.ts`), backend tests (`test_hashing_storage.py`) and frontend tests (`lib.test.ts`) all assert.

## Document fingerprint

```
documentHash = SHA-256(file bytes)          // 32 bytes
text form    = "0x" + 64 lowercase hex      // exactly the contract's bytes32
```

- Only the bytes are hashed: not the filename, path, MIME type or timestamps.
- Large files are hashed as a stream (frontend: 4 MiB `Blob.slice` chunks with `@noble/hashes`; backend: 1 MiB chunks while writing to storage).
- Input normalisation (`normalize_hash` / `normalizeHash`) accepts upper case and a missing `0x` and returns the canonical form; anything that is not 32 bytes of hex is rejected.

## Metadata hash

```
canonical = JSON with keys sorted recursively, no whitespace, UTF-8, string values only
metadataHash = SHA-256(canonical)
```

For a document: `{"attributes": {<issuer's details>}, "document_type": "<type>", "title": "<title>"}`.
For a batch: `{"description": …, "document_count": "<n>", "title": …}`.

Python: `json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`. TypeScript: recursive sorted `JSON.stringify`. Vectors include quotes, newlines, tabs, backslashes, U+2028 and an emoji.

## Merkle tree

```
leaf   = keccak256(0x00 ‖ documentHash)
node   = keccak256(min(a,b) ‖ max(a,b))     // lexicographic == numeric for equal-length hashes
levels : pair adjacent nodes left to right; an unpaired last node moves up unchanged
root   = the single node at the top (a one-document batch: root == leaf)
proof  : for the leaf's index i at each level, the sibling at index i^1 if it exists, then i >>= 1
verify : acc = leaf; for p in proof: acc = node(acc, p); acc == root
```

Why this shape:

- **Sorted pairs** let the contract use OpenZeppelin's `MerkleProof` and mean a proof is just a list of hashes (no left/right bits to get wrong).
- **The `0x00` leaf prefix** makes leaves 33-byte preimages while inner nodes are 64-byte preimages, so a node of the tree can never be presented as a document (second-preimage defence; there is a contract test for it).
- **Order is preserved** from the issuer's upload list; duplicate fingerprints in one batch are rejected by the API and ignored (with a warning) by the UI.

Implementations: `contracts/contracts/VerityRegistry.sol` (`leafOf`, `MerkleProof.verifyCalldata`), `contracts/test/merkle.ts` (reference), `backend/app/verity/merkle.py`, `frontend/src/lib/merkle.ts`.

## Proof file

What an issuer hands to a recipient (`GET /batches/{id}/proof/{hash}` or the *Download proof* button):

```json
{ "version": 1, "batch_id": 1, "merkle_root": "0x…", "document_hash": "0x…",
  "leaf_index": 2, "proof": ["0x…", "0x…"], "chain_id": 31337, "contract_address": "0x…" }
```

It contains hashes only, no file names.
