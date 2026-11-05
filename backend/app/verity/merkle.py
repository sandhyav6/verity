"""Merkle batches, byte-for-byte compatible with VerityRegistry.sol and frontend/src/lib/merkle.ts.

    leaf  = keccak256(0x00 || documentHash)             documentHash = 32-byte SHA-256 of the file
    node  = keccak256(min(a, b) || max(a, b))           sorted pair (OpenZeppelin MerkleProof): no left/right flags
    level : adjacent nodes are paired, an unpaired last node is promoted unchanged to the next level
    proof : the sibling at every level where one exists, from the leaf upward
"""

from eth_utils import keccak


def _b(h: str) -> bytes:
    return bytes.fromhex(h[2:])


def _hex(b: bytes) -> str:
    return "0x" + b.hex()


def leaf_of(document_hash: str) -> str:
    return _hex(keccak(b"\x00" + _b(document_hash)))


def hash_pair(a: str, b: str) -> str:
    x, y = _b(a), _b(b)
    return _hex(keccak(x + y if x <= y else y + x))  # equal-length byte strings compare like uint256


def build_levels(document_hashes: list[str]) -> list[list[str]]:
    if not document_hashes:
        raise ValueError("a batch needs at least one document")
    levels = [[leaf_of(h) for h in document_hashes]]
    while len(levels[-1]) > 1:
        cur = levels[-1]
        levels.append([hash_pair(cur[i], cur[i + 1]) if i + 1 < len(cur) else cur[i] for i in range(0, len(cur), 2)])
    return levels


def merkle_root(document_hashes: list[str]) -> str:
    return build_levels(document_hashes)[-1][0]


def proofs_for_all(document_hashes: list[str]) -> list[list[str]]:
    """Proofs for every leaf, computed from one tree build."""
    levels = build_levels(document_hashes)
    out = []
    for index in range(len(document_hashes)):
        proof, i = [], index
        for level in levels[:-1]:
            if (i ^ 1) < len(level):
                proof.append(level[i ^ 1])
            i >>= 1
        out.append(proof)
    return out


def verify_proof(proof: list[str], root: str, document_hash: str) -> bool:
    acc = leaf_of(document_hash)
    for p in proof:
        acc = hash_pair(acc, p)
    return acc == root
