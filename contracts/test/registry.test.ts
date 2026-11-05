import { expect } from "chai";
import { DAY, DocType, ethers, deployRegistry, docId, hashOf, networkHelpers, Status, ZERO32 } from "./helpers.js";

const META = ethers.id("metadata-1");
const REASON = ethers.id("reason: issued in error");

async function register(f: Awaited<ReturnType<typeof deployRegistry>>, n: number, opts: { id?: string; expiresAt?: number; who?: any } = {}) {
  const id = opts.id ?? docId(`d${n}`);
  const hash = hashOf(n);
  const tx = await f.registry.connect(opts.who ?? f.issuer).registerDocument(id, hash, DocType.AcademicCertificate, META, opts.expiresAt ?? 0);
  return { id, hash, tx };
}

describe("VerityRegistry: issuers and roles", () => {
  it("deploys with the admin as default admin and issuer manager, and the seeded issuers authorised", async () => {
    const f = await deployRegistry();
    expect(await f.registry.defaultAdmin()).to.equal(f.admin.address);
    expect(await f.registry.hasRole(await f.registry.ISSUER_MANAGER_ROLE(), f.admin.address)).to.equal(true);
    expect(await f.registry.isAuthorizedIssuer(f.issuer.address)).to.equal(true);
    expect(await f.registry.isAuthorizedIssuer(f.outsider.address)).to.equal(false);
    const i = await f.registry.getIssuer(f.issuer.address);
    expect(i.name).to.equal("Northfield University");
    expect(i.authorizedAt).to.be.gt(0n);
  });

  it("lets a manager authorise and remove issuers, emitting events", async () => {
    const f = await deployRegistry();
    await expect(f.registry.authorizeIssuer(f.outsider.address, "New Org"))
      .to.emit(f.registry, "IssuerAuthorized").withArgs(f.outsider.address, f.admin.address, "New Org");
    expect(await f.registry.isAuthorizedIssuer(f.outsider.address)).to.equal(true);
    await expect(f.registry.removeIssuer(f.outsider.address))
      .to.emit(f.registry, "IssuerRemoved").withArgs(f.outsider.address, f.admin.address);
    expect(await f.registry.isAuthorizedIssuer(f.outsider.address)).to.equal(false);
    expect((await f.registry.getIssuer(f.outsider.address)).removedAt).to.be.gt(0n);
    // re-authorisation after removal is allowed and clears removedAt
    await f.registry.authorizeIssuer(f.outsider.address, "New Org v2");
    const again = await f.registry.getIssuer(f.outsider.address);
    expect(again.authorized).to.equal(true);
    expect(again.removedAt).to.equal(0n);
    expect(again.name).to.equal("New Org v2");
  });

  it("validates issuer management inputs", async () => {
    const f = await deployRegistry();
    await expect(f.registry.authorizeIssuer(ethers.ZeroAddress, "x")).to.be.revertedWithCustomError(f.registry, "InvalidAddress");
    await expect(f.registry.authorizeIssuer(f.outsider.address, "")).to.be.revertedWithCustomError(f.registry, "InvalidName");
    await expect(f.registry.authorizeIssuer(f.outsider.address, "x".repeat(101))).to.be.revertedWithCustomError(f.registry, "InvalidName");
    await expect(f.registry.authorizeIssuer(f.issuer.address, "again")).to.be.revertedWithCustomError(f.registry, "IssuerAlreadyAuthorized");
    await expect(f.registry.removeIssuer(f.outsider.address)).to.be.revertedWithCustomError(f.registry, "IssuerNotAuthorized");
  });

  it("restricts issuer management to ISSUER_MANAGER_ROLE", async () => {
    const f = await deployRegistry();
    await expect(f.registry.connect(f.outsider).authorizeIssuer(f.outsider.address, "self")).to.be.revertedWithCustomError(f.registry, "AccessControlUnauthorizedAccount");
    await expect(f.registry.connect(f.issuer).removeIssuer(f.issuer2.address)).to.be.revertedWithCustomError(f.registry, "AccessControlUnauthorizedAccount");
  });

  it("splits power: managers cannot register/revoke documents, admin can delegate manager role", async () => {
    const f = await deployRegistry();
    // the admin is a manager but not an issuer, so cannot register
    await expect(f.registry.registerDocument(docId("x"), hashOf(1), 0, META, 0)).to.be.revertedWithCustomError(f.registry, "NotAuthorizedIssuer");
    const { hash } = await register(f, 1);
    await expect(f.registry.revokeDocument(hash, REASON)).to.be.revertedWithCustomError(f.registry, "NotRecordIssuer");
    // delegation
    await f.registry.grantRole(await f.registry.ISSUER_MANAGER_ROLE(), f.manager2.address);
    await f.registry.connect(f.manager2).authorizeIssuer(f.outsider.address, "Delegated Org");
    expect(await f.registry.isAuthorizedIssuer(f.outsider.address)).to.equal(true);
    // a manager cannot grant roles (only the default admin can)
    await expect(f.registry.connect(f.manager2).grantRole(await f.registry.ISSUER_MANAGER_ROLE(), f.outsider.address)).to.be.revertedWithCustomError(f.registry, "AccessControlUnauthorizedAccount");
  });

  it("transfers the default admin in two steps", async () => {
    const f = await deployRegistry(0);
    await f.registry.beginDefaultAdminTransfer(f.manager2.address);
    await networkHelpers.mine(2);
    await f.registry.connect(f.manager2).acceptDefaultAdminTransfer();
    expect(await f.registry.defaultAdmin()).to.equal(f.manager2.address);
  });
});

describe("VerityRegistry: registration and verification", () => {
  it("registers a document and exposes everything needed to verify it", async () => {
    const f = await deployRegistry();
    const { id, hash, tx } = await register(f, 1);
    await expect(tx).to.emit(f.registry, "DocumentRegistered").withArgs(hash, id, f.issuer.address, 1, DocType.AcademicCertificate, META, 0);
    const v = await f.registry.verifyDocument(hash);
    expect(v.status).to.equal(Status.Valid);
    expect(v.issuer).to.equal(f.issuer.address);
    expect(v.issuerAuthorized).to.equal(true);
    expect(v.documentId).to.equal(id);
    expect(v.version).to.equal(1n);
    expect(v.latestVersion).to.equal(1n);
    expect(v.docType).to.equal(BigInt(DocType.AcademicCertificate));
    expect(v.metadataHash).to.equal(META);
    expect(v.registeredAt).to.equal(BigInt((await ethers.provider.getBlock("latest"))!.timestamp));
    expect(v.revokedAt).to.equal(0n);
  });

  it("reports NotRegistered for an unknown fingerprint (and a one-bit-different one)", async () => {
    const f = await deployRegistry();
    const { hash } = await register(f, 1);
    expect((await f.registry.verifyDocument(hashOf(999))).status).to.equal(Status.NotRegistered);
    const flipped = "0x" + (BigInt(hash) ^ 1n).toString(16).padStart(64, "0");
    const v = await f.registry.verifyDocument(flipped);
    expect(v.status).to.equal(Status.NotRegistered);
    expect(v.issuer).to.equal(ethers.ZeroAddress);
  });

  it("rejects unauthorised registrars, including removed issuers", async () => {
    const f = await deployRegistry();
    await expect(register(f, 1, { who: f.outsider })).to.be.revertedWithCustomError(f.registry, "NotAuthorizedIssuer");
    await f.registry.removeIssuer(f.issuer.address);
    await expect(register(f, 2)).to.be.revertedWithCustomError(f.registry, "NotAuthorizedIssuer");
  });

  it("validates inputs and blocks duplicates, even across issuers", async () => {
    const f = await deployRegistry();
    await expect(f.registry.connect(f.issuer).registerDocument(ZERO32, hashOf(1), 0, META, 0)).to.be.revertedWithCustomError(f.registry, "InvalidDocumentId");
    await expect(f.registry.connect(f.issuer).registerDocument(docId("a"), ZERO32, 0, META, 0)).to.be.revertedWithCustomError(f.registry, "InvalidHash");
    await expect(f.registry.connect(f.issuer).registerDocument(docId("a"), hashOf(1), 99, META, 0)).to.be.rejected; // enum out of range (ABI decoder panic)
    const past = (await networkHelpers.time.latest()) - 1;
    await expect(register(f, 1, { expiresAt: past })).to.be.revertedWithCustomError(f.registry, "InvalidExpiry");
    await register(f, 1);
    await expect(register(f, 1, { id: docId("other") })).to.be.revertedWithCustomError(f.registry, "AlreadyRegistered");
    await expect(register(f, 1, { id: docId("other2"), who: f.issuer2 })).to.be.revertedWithCustomError(f.registry, "AlreadyRegistered");
  });

  it("accepts an empty metadata hash", async () => {
    const f = await deployRegistry();
    await f.registry.connect(f.issuer).registerDocument(docId("m"), hashOf(5), DocType.Other, ZERO32, 0);
    expect((await f.registry.verifyDocument(hashOf(5))).metadataHash).to.equal(ZERO32);
  });

  it("reports Expired after the expiry time, deterministically", async () => {
    const f = await deployRegistry();
    const exp = (await networkHelpers.time.latest()) + DAY;
    const { hash } = await register(f, 1, { expiresAt: exp });
    expect((await f.registry.verifyDocument(hash)).status).to.equal(Status.Valid);
    await networkHelpers.time.increaseTo(exp);
    expect((await f.registry.verifyDocument(hash)).status).to.equal(Status.Expired);
  });
});

describe("VerityRegistry: revocation", () => {
  it("revokes permanently, keeping the registration record", async () => {
    const f = await deployRegistry();
    const { id, hash } = await register(f, 1);
    const before = await f.registry.verifyDocument(hash);
    await expect(f.registry.connect(f.issuer).revokeDocument(hash, REASON))
      .to.emit(f.registry, "DocumentRevoked").withArgs(hash, id, f.issuer.address, REASON);
    const v = await f.registry.verifyDocument(hash);
    expect(v.status).to.equal(Status.Revoked);
    expect(v.revokedBy).to.equal(f.issuer.address);
    expect(v.reasonHash).to.equal(REASON);
    expect(v.revokedAt).to.be.gt(0n);
    expect(v.registeredAt).to.equal(before.registeredAt);
    expect(v.issuer).to.equal(before.issuer);
    await expect(f.registry.connect(f.issuer).revokeDocument(hash, REASON)).to.be.revertedWithCustomError(f.registry, "AlreadyRevoked");
    // the fingerprint can never be re-registered to "un-revoke" it
    await expect(register(f, 1, { id: docId("again") })).to.be.revertedWithCustomError(f.registry, "AlreadyRegistered");
  });

  it("is limited to the issuer of the record", async () => {
    const f = await deployRegistry();
    const { hash } = await register(f, 1);
    await expect(f.registry.connect(f.issuer2).revokeDocument(hash, REASON)).to.be.revertedWithCustomError(f.registry, "NotRecordIssuer");
    await expect(f.registry.connect(f.outsider).revokeDocument(hash, REASON)).to.be.revertedWithCustomError(f.registry, "NotRecordIssuer");
    await expect(f.registry.connect(f.admin).revokeDocument(hash, REASON)).to.be.revertedWithCustomError(f.registry, "NotRecordIssuer");
    await expect(f.registry.connect(f.issuer).revokeDocument(hashOf(77), REASON)).to.be.revertedWithCustomError(f.registry, "NotRegistered");
  });

  it("revoked wins over expired", async () => {
    const f = await deployRegistry();
    const exp = (await networkHelpers.time.latest()) + DAY;
    const { hash } = await register(f, 1, { expiresAt: exp });
    await f.registry.connect(f.issuer).revokeDocument(hash, REASON);
    await networkHelpers.time.increaseTo(exp + 1);
    expect((await f.registry.verifyDocument(hash)).status).to.equal(Status.Revoked);
  });

  it("lets a removed issuer revoke their old records, and registration stays on record", async () => {
    const f = await deployRegistry();
    const { hash } = await register(f, 1);
    await f.registry.removeIssuer(f.issuer.address);
    const v = await f.registry.verifyDocument(hash);
    expect(v.status).to.equal(Status.Valid); // removal does not rewrite history
    expect(v.issuerAuthorized).to.equal(false); // ...but verifiers can see the issuer is no longer authorised
    await f.registry.connect(f.issuer).revokeDocument(hash, REASON);
    expect((await f.registry.verifyDocument(hash)).status).to.equal(Status.Revoked);
  });
});

describe("VerityRegistry: versioning", () => {
  it("creates independent records per version and keeps old versions verifiable", async () => {
    const f = await deployRegistry();
    const id = docId("policy");
    const v1 = await register(f, 1, { id });
    const v2 = await register(f, 2, { id });
    await expect(v2.tx).to.emit(f.registry, "DocumentRegistered").withArgs(v2.hash, id, f.issuer.address, 2, DocType.AcademicCertificate, META, 0);
    expect(await f.registry.latestVersion(id)).to.equal(2n);
    expect(await f.registry.versionHash(id, 1)).to.equal(v1.hash);
    expect(await f.registry.versionHash(id, 2)).to.equal(v2.hash);
    const old = await f.registry.verifyDocument(v1.hash);
    expect(old.status).to.equal(Status.Valid);
    expect(old.version).to.equal(1n);
    expect(old.latestVersion).to.equal(2n); // verifiers can tell v1 is superseded
    expect((await f.registry.verifyDocument(v2.hash)).latestVersion).to.equal(2n);
  });

  it("revoking one version does not revoke the others", async () => {
    const f = await deployRegistry();
    const id = docId("policy");
    const v1 = await register(f, 1, { id });
    const v2 = await register(f, 2, { id });
    await f.registry.connect(f.issuer).revokeDocument(v1.hash, REASON);
    expect((await f.registry.verifyDocument(v1.hash)).status).to.equal(Status.Revoked);
    expect((await f.registry.verifyDocument(v2.hash)).status).to.equal(Status.Valid);
  });

  it("only the owning issuer can add versions to a documentId", async () => {
    const f = await deployRegistry();
    const id = docId("policy");
    await register(f, 1, { id });
    expect(await f.registry.documentOwner(id)).to.equal(f.issuer.address);
    await expect(register(f, 2, { id, who: f.issuer2 })).to.be.revertedWithCustomError(f.registry, "NotDocumentOwner");
  });
});
