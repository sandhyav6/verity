import { network } from "hardhat";
import { sampleHash } from "./merkle.ts";

export const connection = await network.getOrCreate();
export const { ethers, networkHelpers } = connection;

export const HOUR = 3600;
export const DAY = 86400;
export const Status = { NotRegistered: 0n, Valid: 1n, Revoked: 2n, Expired: 3n } as const;
export const DocType = { Other: 0, AcademicCertificate: 1, InternshipCertificate: 2, ResearchPublication: 3, ComplianceDocument: 4, AuditReport: 5, LegalAgreement: 6, SoftwareRelease: 7, OfficialReport: 8 } as const;

export const ZERO32 = "0x" + "00".repeat(32);
export const docId = (name: string) => ethers.id(`doc:${name}`);
export const hashOf = sampleHash;

/** Deploys VerityRegistry: #0 admin (+issuer manager), #1 and #2 authorised issuers, #3 outsider, #4 second manager. */
export async function deployRegistry(adminDelay = 0) {
  const [admin, issuer, issuer2, outsider, manager2, verifier] = await ethers.getSigners();
  const registry = await ethers.deployContract("VerityRegistry", [admin.address, adminDelay]);
  await registry.connect(admin).authorizeIssuer(issuer.address, "Northfield University");
  await registry.connect(admin).authorizeIssuer(issuer2.address, "Harbor Audit LLP");
  return { admin, issuer, issuer2, outsider, manager2, verifier, registry };
}

export type Fixture = Awaited<ReturnType<typeof deployRegistry>>;
