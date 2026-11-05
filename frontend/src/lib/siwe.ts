import { getAddress } from "viem";

export interface SiweFields {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: Date;
  expirationMinutes?: number;
}

const iso = (d: Date) => d.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ, as EIP-4361 expects

/** Builds the EIP-4361 (Sign-In with Ethereum) message the backend verifies. Address must be EIP-55. */
export function buildSiweMessage(f: SiweFields): string {
  const expires = new Date(f.issuedAt.getTime() + (f.expirationMinutes ?? 10) * 60_000);
  return [
    `${f.domain} wants you to sign in with your Ethereum account:`,
    getAddress(f.address),
    "",
    f.statement,
    "",
    `URI: ${f.uri}`,
    "Version: 1",
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${iso(f.issuedAt)}`,
    `Expiration Time: ${iso(expires)}`,
  ].join("\n");
}
