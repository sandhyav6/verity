import { concat, keccak256 } from "viem";

/**
 * Merkle batches, compatible with VerityRegistry.sol and backend/app/verity/merkle.py:
 *   leaf  = keccak256(0x00 || documentHash)      node = keccak256(min(a,b) || max(a,b))  (sorted pair)
 *   an unpaired last node is promoted unchanged; a proof lists the sibling at every level that has one.
 */
type Hex = `0x${string}`;

export const leafOf = (documentHash: string): Hex => keccak256(concat(["0x00", documentHash as Hex]));
// equal-length lowercase hex strings order exactly like the uint256 values the contract compares
export const hashPair = (a: Hex, b: Hex): Hex => (a <= b ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

export function buildLevels(documentHashes: string[]): Hex[][] {
  if (documentHashes.length === 0) throw new Error("A batch needs at least one document.");
  const levels: Hex[][] = [documentHashes.map(leafOf)];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  return levels;
}

export const merkleRoot = (documentHashes: string[]): Hex => {
  const levels = buildLevels(documentHashes);
  return levels[levels.length - 1][0];
};

export function proofsForAll(documentHashes: string[]): Hex[][] {
  const levels = buildLevels(documentHashes);
  return documentHashes.map((_, index) => {
    const proof: Hex[] = [];
    let i = index;
    for (const level of levels.slice(0, -1)) {
      if ((i ^ 1) < level.length) proof.push(level[i ^ 1]);
      i >>= 1;
    }
    return proof;
  });
}

export function verifyProof(proof: string[], root: string, documentHash: string): boolean {
  return proof.reduce<Hex>((acc, p) => hashPair(acc, p as Hex), leafOf(documentHash)) === root;
}
