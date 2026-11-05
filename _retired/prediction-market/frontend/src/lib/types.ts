// Mirrors the backend response schemas (docs/api.md). Wei-scale quantities are decimal strings.
export type Wei = string;
export type MarketStatus = "active" | "closed" | "resolved" | "invalid";
export type Category = "economy" | "weather" | "sports" | "technology";

export interface Page<T> { items: T[]; total: number; limit: number; offset: number }

export interface PublicConfig {
  chain_id: number; chain_name: string; rpc_url: string; explorer_tx_url: string;
  factory_address: string; token_address: string; resolution_manager_address: string;
  indexer_confirmations: number; siwe_domain: string; notice: string;
}

export interface DataRule {
  provider: string; model: string; variable: string; aggregation: string; location: string;
  latitude: string; longitude: string; start_date: string; end_date: string;
  operator: ">" | ">=" | "<" | "<="; threshold: string; unit: string;
}

export interface Market {
  id: number; contract_address: string; question: string; description: string | null; category: Category;
  yes_definition: string | null; no_definition: string | null;
  resolution_source: { name: string; url: string; dataset: string } | null;
  resolution_criteria: string | null;
  resolution_spec: { measurement: string; unit: string; observation_period: string; revision_policy: string; missing_data_policy: string } | null;
  data_rule: DataRule | null; resolution_data_note: string | null;
  metadata_verified: boolean; metadata_hash: string; status: MarketStatus; winning_outcome: "YES" | "NO" | null;
  yes_price: string; no_price: string; liquidity_parameter: Wei; q_yes: Wei; q_no: Wei; collateral: Wei;
  volume: Wei; trade_count: number; created_by: string; created_at: string;
  trading_close_time: string; resolution_deadline: string; resolved_at: string | null;
}

export interface Snapshot { block_number: number; timestamp: string; yes_price: string; q_yes: Wei; q_no: Wei; transaction_hash: string }

export interface Trade {
  market_id: number; market_question: string | null; wallet_address: string; outcome: "YES" | "NO"; action: "buy" | "sell";
  shares: Wei; token_amount: Wei; execution_price: string; yes_price_after: string; transaction_hash: string;
  block_number: number; log_index: number; timestamp: string; explorer_url: string | null;
}

export interface Position {
  market_id: number; question: string; market_status: string; yes_shares: Wei; no_shares: Wei;
  avg_entry_price_yes: string | null; avg_entry_price_no: string | null; indicative_value: Wei;
  realized_pnl: string; redeemable_amount: Wei; refundable: boolean;
}
export interface Portfolio {
  address: string; token_balance: Wei | null; balance_source: string; positions: Position[];
  total_indicative_value: Wei; total_realized_pnl: string; notice: string;
}

export interface Overview {
  source: string; markets_total: number; markets_by_status: Record<MarketStatus, number>; trades_total: number;
  unique_traders: number; total_volume: Wei; last_indexed_block: number | null; indexed_at: string | null;
  activity: { day: string; trades: number; volume: Wei }[];
}
export interface CategoryStat { category: Category; markets: number; trades: number; volume: Wei }
export interface MarketStat { id: number; question: string; category: Category; status: MarketStatus; yes_price: string; trades: number; unique_traders: number; volume: Wei }

export interface ExternalRecord {
  is_external_data: true; id: number; category: Category; provider: string; dataset: string | null; dataset_version: string | null;
  metric: string; value: string | null; text: string | null; unit: string | null; location: string | null;
  grid_latitude: string | null; grid_longitude: string | null; period_start: string | null; period_end: string | null;
  observed_at: string; retrieved_at: string; last_seen_at: string; source_url: string; raw_payload_reference: string;
  raw_payload_hash: string; transformation: string; validation_status: "valid" | "incomplete" | "invalid" | "manual_submitted";
  validation_notes: string[]; attribution: string | null; freshness: { state: "fresh" | "stale" | "manual"; age_seconds: number; note: string };
  supersedes_id: number | null; is_latest: boolean; entered_manually: boolean; submitted_by: string | null;
}
export interface SourceStatus {
  provider: string; category: Category; mode: "automated" | "manual submission"; terms_note: string; records: number;
  last_retrieved_at: string | null; last_seen_at: string | null; freshness: "fresh" | "stale" | "manual" | "no data";
}

export interface Evidence { kind: "proposal" | "dispute" | "arbitration"; evidence_hash: string; evidence_uri: string; proposed_outcome: string; bundle: Record<string, unknown>; created_by: string; created_at: string; hash_verified: boolean }
export interface Proposal {
  proposed_outcome: string; final_outcome: string | null; state: "proposed" | "disputed" | "finalized" | "cancelled"; evidence_hash: string; evidence_uri: string; evidence_available: boolean;
  resolver_address: string; proposal_timestamp: string; challenge_deadline: string; dispute_status: "none" | "disputed" | "upheld" | "overturned" | "released"; resolution_timestamp: string | null; transaction_hash: string;
  bond: Wei; dispute_bond: Wei; disputer_address: string | null; dispute_evidence_hash: string | null; dispute_evidence_uri: string | null; dispute_evidence_available: boolean; disputed_at: string | null;
  arbiter_address: string | null; arbiter_rationale_hash: string | null; arbiter_rationale_available: boolean; arbitrated_at: string | null;
}
export interface Resolution { market_id: number; market_status: string; winning_outcome: string | null; server_time: string; proposals: Proposal[]; trust_model: string }
export interface Draft { requires_human_review: boolean; external_data_id: number; suggested_outcome: "YES" | "NO" | "INVALID"; rule: DataRule; evidence: Record<string, unknown>; warnings: string[]; next_step: string }
export interface ProposePrepared { evidence_hash: string; evidence_uri: string; verdict: number; market_address: string; resolution_manager_address: string; call: string; note: string; bonded: boolean; bond_note: string | null }

export interface CreatePrepared {
  metadata_hash: string; note: string; factory_address: string;
  factory_params: { metadataHash: string; category: number; tradingClose: number; resolutionDeadline: number; liquidityB: string };
}
export interface SessionInfo { address: string; expires_at: string; is_admin: boolean }
export interface NonceInfo { nonce: string; expires_at: string; domain: string; chain_id: number; uri: string; statement: string }
export interface TxStatus { transaction_hash: string; status: "pending" | "success" | "failed" | "not_found"; block_number: number | null; confirmations: number; required_confirmations: number; indexed: boolean; indexed_events: string[]; explorer_url: string | null }
