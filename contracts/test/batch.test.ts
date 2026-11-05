import { expect } from "chai";
import { readFileSync } from "node:fs";
import { deployRegistry, ethers, hashOf, Status, ZERO32 } from "./helpers.js";
import { buildTree, leafOf, proofFor, verifyProof } from "./merkle.js";

const META = ethers.id("batch-meta");
const REASON = ethers.id("batch reason");
const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));

const hashes = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => hashOf(offset + i));

async function batch(f: Awaited<ReturnType<typeof deployRegistry>>, docs: string[]) {
  const root = buildTree(docs).root;
  const tx = await f.registry.connect(f.issuer).registerBatch(root, docs.length, META);
  return { root, tx, id: await f.registry.batchIdByRoot(root) };
}

describe("VerityRegistry: Merkle batches", () => {
  it("matches the cross-language vectors (TypeScript reference == Solidity leafOf/verify)", async () => {
    const f = await deployRegistry();
    for (const v of vectors.merkle) {
      expect(buildTree(v.hashes).root).to.equal(v.root);
      const { id } = await batch(f, v.hashes);
      for (let i = 0; i < v.hashes.length; i++) {
        expect(proofFor(v.hashes, i)).to.deep.equal(v.proofs[i]);
        const r = await f.registry.verifyBatchDocument(id, v.hashes[i], v.proofs[i]);
        expect(r.included, `batch of ${v.hashes.length}, leaf ${i}`).to.equal(true);
      }
    }
    expect(await f.registry.leafOf(vectors.merkle[0].hashes[0])).to.equal(leafOf(vectors.merkle[0].hashes[0]));
  });

  it("registers a batch root and records issuer, count and metadata", async () => {
    const f = await deployRegistry();
    const docs = hashes(5);
    const { root, tx, id } = await batch(f, docs);
    await expect(tx).to.emit(f.registry, "BatchRegistered").withArgs(1n, root, f.issuer.address, 5, META);
    expect(id).to.equal(1n);
    expect(await f.registry.batchCount()).to.equal(1n);
    const b = await f.registry.getBatch(1);
    expect(b.merkleRoot).to.equal(root);
    expect(b.issuer).to.equal(f.issuer.address);
    expect(b.documentCount).to.equal(5n);
    expect(b.metadataHash).to.equal(META);
    expect(b.revokedAt).to.equal(0n);
  });

  it("verifies every member of batches of many sizes, including odd ones and a single leaf", async () => {
    const f = await deployRegistry();
    let offset = 1000;
    for (const n of [1, 2, 3, 4, 6, 7, 8, 13]) {
      const docs = hashes(n, (offset += 100));
      const { id } = await batch(f, docs);
      for (let i = 0; i < n; i++) {
        const proof = proofFor(docs, i);
        expect(verifyProof(proof, buildTree(docs).root, docs[i])).to.equal(true);
        const r = await f.registry.verifyBatchDocument(id, docs[i], proof);
        expect(r.included).to.equal(true);
        expect(r.status).to.equal(Status.Valid);
        expect(r.issuer).to.equal(f.issuer.address);
      }
    }
  });

  it("rejects invalid proofs, wrong documents and wrong batches", async () => {
    const f = await deployRegistry();
    const docs = hashes(6);
    const { id } = await batch(f, docs);
    const other = await batch(f, hashes(3, 500));
    const proof = proofFor(docs, 2);
    expect((await f.registry.verifyBatchDocument(id, hashOf(9999), proof)).included).to.equal(false);
    expect((await f.registry.verifyBatchDocument(id, docs[3], proof)).included).to.equal(false); // proof for a different leaf
    expect((await f.registry.verifyBatchDocument(id, docs[2], [...proof.slice(0, -1)])).included).to.equal(false); // truncated
    expect((await f.registry.verifyBatchDocument(id, docs[2], [...proof, ZERO32])).included).to.equal(false); // extended
    expect((await f.registry.verifyBatchDocument(other.id, docs[2], proof)).included).to.equal(false); // other batch
    expect((await f.registry.verifyBatchDocument(404, docs[2], proof)).status).to.equal(Status.NotRegistered); // unknown batch
  });

  it("is not fooled by an inner node presented as a document (leaf/node domain separation)", async () => {
    const f = await deployRegistry();
    const docs = hashes(4);
    const { id } = await batch(f, docs);
    const { levels } = buildTree(docs);
    // second-preimage attempt: claim the inner node (levels[1][0]) is a "document hash" with the sibling as proof
    expect((await f.registry.verifyBatchDocument(id, levels[1][0], [levels[1][1]])).included).to.equal(false);
    // a raw leaf hash is not a document hash either
    expect((await f.registry.verifyBatchDocument(id, levels[0][0], proofFor(docs, 0))).included).to.equal(false);
  });

  it("validates registration and restricts it to authorised issuers", async () => {
    const f = await deployRegistry();
    const root = buildTree(hashes(2)).root;
    await expect(f.registry.connect(f.outsider).registerBatch(root, 2, META)).to.be.revertedWithCustomError(f.registry, "NotAuthorizedIssuer");
    await expect(f.registry.connect(f.issuer).registerBatch(ZERO32, 2, META)).to.be.revertedWithCustomError(f.registry, "InvalidBatch");
    await expect(f.registry.connect(f.issuer).registerBatch(root, 0, META)).to.be.revertedWithCustomError(f.registry, "InvalidBatch");
    await f.registry.connect(f.issuer).registerBatch(root, 2, META);
    await expect(f.registry.connect(f.issuer2).registerBatch(root, 2, META)).to.be.revertedWithCustomError(f.registry, "BatchRootAlreadyRegistered");
  });

  it("revokes a whole batch, only by its issuer", async () => {
    const f = await deployRegistry();
    const docs = hashes(3);
    const { id } = await batch(f, docs);
    await expect(f.registry.connect(f.issuer2).revokeBatch(id, REASON)).to.be.revertedWithCustomError(f.registry, "NotRecordIssuer");
    await expect(f.registry.connect(f.issuer).revokeBatch(id, REASON)).to.emit(f.registry, "BatchRevoked").withArgs(id, f.issuer.address, REASON);
    const r = await f.registry.verifyBatchDocument(id, docs[1], proofFor(docs, 1));
    expect(r.included).to.equal(true);
    expect(r.status).to.equal(Status.Revoked);
    expect(r.revokedAt).to.be.gt(0n);
    await expect(f.registry.connect(f.issuer).revokeBatch(id, REASON)).to.be.revertedWithCustomError(f.registry, "AlreadyRevoked");
    await expect(f.registry.connect(f.issuer).revokeBatch(77, REASON)).to.be.revertedWithCustomError(f.registry, "BatchNotFound");
  });

  it("revokes a single document of a batch with a proof, leaving the rest valid", async () => {
    const f = await deployRegistry();
    const docs = hashes(5);
    const { id } = await batch(f, docs);
    await expect(f.registry.connect(f.issuer).revokeBatchDocument(id, docs[2], proofFor(docs, 1), REASON)).to.be.revertedWithCustomError(f.registry, "InvalidProof");
    await expect(f.registry.connect(f.issuer2).revokeBatchDocument(id, docs[2], proofFor(docs, 2), REASON)).to.be.revertedWithCustomError(f.registry, "NotRecordIssuer");
    await expect(f.registry.connect(f.issuer).revokeBatchDocument(id, docs[2], proofFor(docs, 2), REASON))
      .to.emit(f.registry, "BatchDocumentRevoked").withArgs(id, docs[2], f.issuer.address, REASON);
    expect((await f.registry.verifyBatchDocument(id, docs[2], proofFor(docs, 2))).status).to.equal(Status.Revoked);
    expect((await f.registry.verifyBatchDocument(id, docs[3], proofFor(docs, 3))).status).to.equal(Status.Valid);
    await expect(f.registry.connect(f.issuer).revokeBatchDocument(id, docs[2], proofFor(docs, 2), REASON)).to.be.revertedWithCustomError(f.registry, "AlreadyRevoked");
  });
});

describe("VerityRegistry: Merkle property tests", () => {
  // Deterministic pseudo-random generator so failures are reproducible.
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  it("accepts every member and rejects non-members, tampered proofs and wrong batches for 25 random batches", async () => {
    const f = await deployRegistry();
    const rand = rng(42);
    let previous: { id: bigint; docs: string[] } | null = null;
    for (let round = 0; round < 25; round++) {
      const n = 1 + Math.floor(rand() * 40);
      const docs = Array.from({ length: n }, (_, i) => hashOf(50_000 + round * 100 + i));
      const { id } = await batch(f, docs);
      const root = buildTree(docs).root;
      for (let k = 0; k < Math.min(n, 4); k++) {
        const i = Math.floor(rand() * n);
        const proof = proofFor(docs, i);
        expect(verifyProof(proof, root, docs[i])).to.equal(true);
        expect((await f.registry.verifyBatchDocument(id, docs[i], proof)).included).to.equal(true);
        expect((await f.registry.verifyBatchDocument(id, hashOf(900_000 + round * 10 + k), proof)).included).to.equal(false);
        if (proof.length) {
          const bad = proof.slice();
          bad[Math.floor(rand() * bad.length)] = hashOf(777_000 + round);
          expect((await f.registry.verifyBatchDocument(id, docs[i], bad)).included).to.equal(false);
        }
        if (previous) expect((await f.registry.verifyBatchDocument(previous.id, docs[i], proof)).included).to.equal(false);
      }
      previous = { id, docs };
    }
  });
});
