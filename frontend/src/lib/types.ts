// Shapes returned by the Verity API (backend/app/schemas). Hashes are 0x + 64 lowercase hex.

export interface PublicConfig {
  chain_id: number;
  chain_name: string;
  rpc_url: string;
  explorer_tx_url: string;
  registry_address: string;
  indexer_confirmations: number;
  siwe_domain: string;
  max_upload_bytes: number;
  document_types: Record<string, string>;
}

export interface NonceInfo { nonce: string; expires_at: string; domain: string; chain_id: number; uri: string; statement: string }
export interface SessionInfo { address: string; expires_at: string; is_issuer: boolean; is_manager: boolean; roles_available: boolean }

export interface Page<T> { items: T[]; total: number; limit: number; offset: number }

export interface IssuerRef { address: string; organization_name: string | null; currently_authorized: boolean | null }
export type DocStatus = "valid" | "revoked" | "expired";
export type Verdict = "verified" | "revoked" | "expired" | "not_verified";

export interface DocumentVersion {
  document_hash: string;
  document_id: string;
  version_number: number;
  is_latest: boolean;
  issuer: IssuerRef;
  document_type: string;
  status: DocStatus;
  registered_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  transaction_hash: string;
  revocation_transaction_hash: string | null;
  explorer_url: string | null;
  block_number: number;
  metadata_hash: string;
  title: string | null;
  metadata: Record<string, string> | null;
  visibility: "public" | "private" | null;
  metadata_verified: boolean | null;
  content_type: string | null;
  size_bytes: number | null;
  file_available: boolean;
}
export interface DocumentDetail { document: DocumentVersion; versions: DocumentVersion[] }

export interface UploadResult {
  document_hash: string;
  metadata_hash: string;
  canonical_metadata: string;
  title: string;
  document_type: string;
  visibility: string;
  content_type: string;
  size_bytes: number;
}

export interface Registration {
  kind: "document" | "batch";
  issuer: IssuerRef;
  registered_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  document_id: string | null;
  document_type: string | null;
  version_number: number | null;
  latest_version: number | null;
  is_latest: boolean | null;
  batch_id: number | null;
  merkle_root: string | null;
  transaction_hash: string | null;
  explorer_url: string | null;
  title: string | null;
}
export interface Verification {
  document_hash: string;
  verdict: Verdict;
  reason: string;
  checked_at: string;
  chain_id: number;
  contract_address: string;
  registration: Registration | null;
}

export interface Issuer {
  address: string;
  organization_name: string;
  authorized: boolean;
  authorized_at: string;
  removed_at: string | null;
  authorized_by: string;
  transaction_hash: string;
  document_count: number;
  batch_count: number;
  revoked_count: number;
}

export interface Batch {
  batch_id: number;
  merkle_root: string;
  issuer: IssuerRef;
  document_count: number;
  metadata_hash: string;
  registered_at: string;
  revoked_at: string | null;
  transaction_hash: string;
  explorer_url: string | null;
  documents_stored: number;
}
export interface BatchDocument { document_hash: string; leaf_index: number; filename: string; size_bytes: number; proof: string[]; revoked_at: string | null }
export interface ProofFile { version: number; batch_id: number; merkle_root: string; document_hash: string; leaf_index: number; proof: string[]; chain_id: number; contract_address: string }
export interface ProofEntry { batch_id: number; merkle_root: string; leaf_index: number; proof: string[] }

export interface AuditEntry { action: string; actor: string; resource_id: string; transaction_hash: string; block_number: number; timestamp: string; explorer_url: string | null }
export interface Stats {
  scope: "mine" | "global";
  total_documents: number;
  valid_documents: number;
  revoked_documents: number;
  expired_documents: number;
  total_batches: number;
  authorized_issuers: number;
  daily: { day: string; registrations: number; revocations: number }[];
}
export interface TransactionInfo {
  transaction_hash: string;
  status: "pending" | "success" | "failed" | "not_found";
  block_number: number | null;
  confirmations: number;
  required_confirmations: number;
  indexed: boolean;
  indexed_events: string[];
  explorer_url: string | null;
}
