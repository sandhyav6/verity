from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class EvidenceCreate(BaseModel):
    """Everything a resolver must document for one proposed outcome."""

    proposed_outcome: Literal["YES", "NO", "INVALID"]
    source_name: str = Field(min_length=3, max_length=120)
    source_url: str = Field(pattern=r"^https?://\S+$", max_length=500)
    evidence_retrieved_at: datetime
    observation_period: str = Field(min_length=5, max_length=200)
    raw_evidence_reference: str = Field(min_length=3, max_length=500, description="URL or archive id of the raw data")
    raw_evidence_hash: str = Field(pattern=r"^0x[0-9a-fA-F]{64}$", description="keccak256/sha256 of the raw payload")
    normalized_result: str = Field(min_length=1, max_length=300)
    unit: str | None = Field(default=None, max_length=40)
    notes: str | None = Field(default=None, max_length=2000)


class ArbitrationCreate(BaseModel):
    """An arbiter's reasoned decision on a disputed proposal. Stored and hashed like any evidence."""

    verdict: Literal["YES", "NO", "INVALID"]
    rationale: str = Field(min_length=30, max_length=4000, description="Why, referring to both parties' evidence")
    references: list[str] = Field(default_factory=list, max_length=20)


class EvidenceOut(BaseModel):
    kind: str = "proposal"
    evidence_hash: str
    evidence_uri: str
    proposed_outcome: str
    bundle: dict
    created_by: str
    created_at: datetime
    hash_verified: bool


class ProposeOut(BaseModel):
    evidence_hash: str
    evidence_uri: str
    verdict: int = Field(description="0 = YES, 1 = NO, 2 = INVALID (ResolutionManager.Verdict)")
    market_address: str
    resolution_manager_address: str
    call: str
    note: str
    bonded: bool = False
    bond_note: str | None = None


class ProposalOut(BaseModel):
    proposed_outcome: str
    final_outcome: str | None
    state: str
    evidence_hash: str
    evidence_uri: str
    evidence_available: bool
    resolver_address: str
    proposal_timestamp: datetime
    challenge_deadline: datetime
    dispute_status: str
    resolution_timestamp: datetime | None
    transaction_hash: str
    bond: str = "0"
    dispute_bond: str = "0"
    disputer_address: str | None = None
    dispute_evidence_hash: str | None = None
    dispute_evidence_uri: str | None = None
    dispute_evidence_available: bool = False
    disputed_at: datetime | None = None
    arbiter_address: str | None = None
    arbiter_rationale_hash: str | None = None
    arbiter_rationale_available: bool = False
    arbitrated_at: datetime | None = None


class ResolutionOut(BaseModel):
    market_id: int
    market_status: str
    winning_outcome: str | None
    server_time: datetime = Field(description="The API's current time (chain time in local dev), for deadline comparisons")
    proposals: list[ProposalOut]
    trust_model: str = (
        "A proposed outcome (by a trusted resolver, or by anyone who posts a test-token bond) becomes final "
        "after the challenge window unless someone disputes it with a matching bond. A disputed outcome is decided "
        "by a single trusted arbiter: this is NOT a decentralized oracle, and bonds do not make the final ruling trustless."
    )
