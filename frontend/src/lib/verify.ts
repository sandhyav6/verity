import { verityRegistryAbi } from "../blockchain/abi/verityRegistryAbi";
import type { ProofEntry, Verdict } from "./types";

type Addr = `0x${string}`;
const STATUS = ["not_registered", "valid", "revoked", "expired"] as const;
export const DOC_TYPE_NAMES = ["other", "academic_certificate", "internship_certificate", "research_publication", "compliance_document", "audit_report", "legal_agreement", "software_release", "official_report"];

/** The slice of a viem PublicClient we need; a plain object can stand in for it in tests. */
export interface ReadClient {
  readContract(args: { address: Addr; abi: typeof verityRegistryAbi; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

export interface ChainVerdict {
  verdict: Verdict;
  kind: "document" | "batch" | null;
  issuer: string | null;
  issuerAuthorized: boolean | null;
  registeredAt: number | null; // unix seconds
  expiresAt: number | null;
  revokedAt: number | null;
  documentId: string | null;
  documentType: string | null;
  version: number | null;
  latestVersion: number | null;
  batchId: number | null;
  merkleRoot: string | null;
}

const EMPTY: ChainVerdict = { verdict: "not_verified", kind: null, issuer: null, issuerAuthorized: null, registeredAt: null, expiresAt: null, revokedAt: null, documentId: null, documentType: null, version: null, latestVersion: null, batchId: null, merkleRoot: null };
const nz = (n: bigint | number) => (Number(n) === 0 ? null : Number(n));
const toVerdict = (s: (typeof STATUS)[number]): Verdict => (s === "valid" ? "verified" : s === "not_registered" ? "not_verified" : s);

/**
 * Ask the CONTRACT whether a fingerprint is registered, directly from the browser (not through our API), so a
 * dishonest or broken backend cannot change the verdict. If the fingerprint is not registered individually,
 * Merkle proofs offered by the backend (`fetchProofs`) are only hints: each one is checked by the contract.
 */
export async function verifyOnChain(client: ReadClient, registry: string, documentHash: string, fetchProofs?: () => Promise<ProofEntry[]>): Promise<ChainVerdict> {
  const address = registry as Addr;
  const v = (await client.readContract({ address, abi: verityRegistryAbi, functionName: "verifyDocument", args: [documentHash as Addr] })) as {
    status: number; issuer: string; issuerAuthorized: boolean; documentId: string; version: number; latestVersion: number; docType: number;
    registeredAt: bigint; expiresAt: bigint; revokedAt: bigint;
  };
  const status = STATUS[v.status];
  if (status !== "not_registered") {
    return {
      verdict: toVerdict(status), kind: "document", issuer: v.issuer.toLowerCase(), issuerAuthorized: v.issuerAuthorized,
      registeredAt: Number(v.registeredAt), expiresAt: nz(v.expiresAt), revokedAt: nz(v.revokedAt), documentId: v.documentId,
      documentType: DOC_TYPE_NAMES[v.docType] ?? "other", version: v.version, latestVersion: v.latestVersion, batchId: null, merkleRoot: null,
    };
  }
  for (const p of (await fetchProofs?.()) ?? []) {
    const b = (await client.readContract({
      address, abi: verityRegistryAbi, functionName: "verifyBatchDocument", args: [BigInt(p.batch_id), documentHash as Addr, p.proof as Addr[]],
    })) as { included: boolean; status: number; issuer: string; issuerAuthorized: boolean; registeredAt: bigint; revokedAt: bigint; merkleRoot: string };
    if (b.included) {
      return { ...EMPTY, verdict: toVerdict(STATUS[b.status]), kind: "batch", issuer: b.issuer.toLowerCase(), issuerAuthorized: b.issuerAuthorized,
        registeredAt: Number(b.registeredAt), revokedAt: nz(b.revokedAt), batchId: p.batch_id, merkleRoot: b.merkleRoot };
    }
  }
  return EMPTY;
}
