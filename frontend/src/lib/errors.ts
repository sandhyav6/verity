import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";

/** Plain-language messages for every custom error VerityRegistry can throw. */
export const CONTRACT_MESSAGES: Record<string, string> = {
  NotAuthorizedIssuer: "This wallet is not an authorised issuer, so it cannot register documents.",
  AlreadyRegistered: "This exact file has already been registered. Each fingerprint can only be registered once.",
  NotRegistered: "That fingerprint is not registered.",
  NotDocumentOwner: "Only the issuer that created this document can add new versions to it.",
  NotRecordIssuer: "Only the issuer that registered this record can revoke it.",
  AlreadyRevoked: "This record has already been revoked.",
  InvalidHash: "The document fingerprint is invalid.",
  InvalidDocumentId: "The document identifier is invalid.",
  InvalidExpiry: "The expiry date must be in the future.",
  InvalidBatch: "A batch needs a Merkle root and at least one document.",
  BatchRootAlreadyRegistered: "A batch with this exact set of documents has already been registered.",
  BatchNotFound: "That batch does not exist.",
  InvalidProof: "The Merkle proof does not match this batch.",
  IssuerAlreadyAuthorized: "That address is already an authorised issuer.",
  IssuerNotAuthorized: "That address is not currently an authorised issuer.",
  InvalidAddress: "Enter a valid wallet address.",
  InvalidName: "The organisation name must be 1 to 100 characters.",
  AccessControlUnauthorizedAccount: "This wallet does not have the required role (issuer manager) for that action.",
};

export function revertName(err: unknown): string | undefined {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) return reverted.data.errorName;
  }
  const text = String((err as { message?: string } | null)?.message ?? "");
  return Object.keys(CONTRACT_MESSAGES).find((n) => new RegExp(`\\b${n}\\b`).test(text));
}

export function isUserRejection(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof UserRejectedRequestError)) return true;
  const e = err as { code?: number; message?: string } | null;
  return e?.code === 4001 || /user (rejected|denied)/i.test(e?.message ?? "");
}

/** Turns any wallet/RPC/contract failure into one sentence a user can act on. */
export function humanizeError(err: unknown): string {
  if (isUserRejection(err)) return "You rejected the request in your wallet. Nothing was sent.";
  const name = revertName(err);
  if (name && CONTRACT_MESSAGES[name]) return CONTRACT_MESSAGES[name];
  const text = String((err as { shortMessage?: string; message?: string } | null)?.shortMessage ?? (err as { message?: string } | null)?.message ?? "");
  if (/chain.*(does not match|mismatch)/i.test(text)) return "Your wallet is on a different network. Switch network and try again.";
  if (/insufficient funds/i.test(text)) return "This wallet has no native coin to pay network fees.";
  if (/(failed to fetch|network error|timeout|timed out|ECONNREFUSED|HTTP request failed)/i.test(text)) return "Could not reach the network. Check your connection and try again.";
  if (/gas/i.test(text) && /(estimat|exceed)/i.test(text)) return "The network could not estimate the transaction. It would probably fail; check your inputs and try again.";
  return text ? `Transaction failed: ${text.slice(0, 200)}` : "Something went wrong. Nothing was sent.";
}
