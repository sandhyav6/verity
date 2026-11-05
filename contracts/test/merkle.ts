// Reference Merkle implementation for Verity (see docs/hashing.md). The backend (Python) and frontend
// (TypeScript) implement the same algorithm and are checked against test/vectors.json, which this file
// generates (`npm run vectors`).
//
//   leaf   = keccak256(0x00 || documentHash)           documentHash = 32-byte SHA-256 of the file
//   node   = keccak256(min(a, b) || max(a, b))         sorted pair: proofs carry no left/right flags
//   level  : adjacent nodes are paired; an unpaired last node is promoted unchanged
//   proof  : the sibling at every level where one exists, from the leaf upward
import { concat, getBytes, hexlify, keccak256 } from "ethers";

export const leafOf = (documentHash: string) => keccak256(concat(["0x00", documentHash]));

export const hashPair = (a: string, b: string) => (BigInt(a) <= BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

export function buildTree(documentHashes: string[]) {
  if (documentHashes.length === 0) throw new Error("empty batch");
  const levels: string[][] = [documentHashes.map(leafOf)];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  return { levels, root: levels[levels.length - 1][0] };
}

export function proofFor(documentHashes: string[], index: number): string[] {
  const { levels } = buildTree(documentHashes);
  const proof: string[] = [];
  let i = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const sibling = i ^ 1;
    if (sibling < levels[l].length) proof.push(levels[l][sibling]);
    i >>= 1;
  }
  return proof;
}

export function verifyProof(proof: string[], root: string, documentHash: string): boolean {
  let acc = leafOf(documentHash);
  for (const p of proof) acc = hashPair(acc, p);
  return acc === root;
}

export const sampleHash = (n: number) => hexlify(getBytes(keccak256(Buffer.from(`sample-${n}`))));
