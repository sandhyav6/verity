"""Resolution evidence: build, hash, store and serve evidence bundles.

The backend never resolves anything. It stores the evidence a resolver documents and returns its
keccak256 hash; the resolver's wallet submits that hash to ResolutionManager.propose on-chain.
"""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.clock import utcnow
from app.models import Market, ResolutionEvidence, ResolutionProposal
from app.schemas.resolution import ArbitrationCreate, EvidenceCreate, EvidenceOut, ProposalOut, ProposeOut, ResolutionOut
from app.services.market_service import canonical_json, keccak_hex, status_of
import json as _json
import operator as _op
from datetime import date as _date
from decimal import Decimal as _Decimal
from app.data_sources.weather import OpenMeteoSource, WeatherQuery
from app.models import MarketMetadata
from app.schemas.data import DraftOut
from app.services.data_ingestion_service import ingest_weather

VERDICT_CODE = {"YES": 0, "NO": 1, "INVALID": 2}


def evidence_uri(settings: Settings, market_id: int, evidence_hash: str) -> str:
    return f"{settings.public_api_url.rstrip('/')}/resolutions/{market_id}/evidence/{evidence_hash}"


def pending_proposal(db: Session, market: Market) -> ResolutionProposal | None:
    return db.scalar(
        select(ResolutionProposal)
        .where(ResolutionProposal.market_id == market.id, ResolutionProposal.state.in_(("proposed", "disputed")))
        .order_by(ResolutionProposal.block_number.desc(), ResolutionProposal.log_index.desc())
        .limit(1)
    )


MAX_EVIDENCE_DOCS = 25  # per wallet, market and kind: bonded proposals and disputes are open to any signed-in wallet


def _store(db: Session, market: Market, kind: str, outcome: str, bundle: dict, by: str) -> str:
    text = canonical_json(bundle)
    digest = keccak_hex(text)
    if db.get(ResolutionEvidence, digest) is None:
        stored = db.scalar(
            select(func.count()).select_from(ResolutionEvidence).where(
                ResolutionEvidence.market_address == market.contract_address,
                ResolutionEvidence.created_by == by,
                ResolutionEvidence.kind == kind,
            )
        )
        if stored >= MAX_EVIDENCE_DOCS:
            raise ValueError(f"too many {kind} documents stored for this market by your wallet (limit {MAX_EVIDENCE_DOCS})")
        db.add(
            ResolutionEvidence(
                evidence_hash=digest, market_address=market.contract_address, kind=kind, proposed_outcome=outcome,
                canonical_json=text, bundle=bundle, created_by=by, created_at=utcnow(),
            )
        )
        db.commit()
    return digest


BOND_NOTE = (
    "A bond in test tokens is escrowed. It is returned if you are not overruled; if an arbiter rules against you "
    "it goes to the other party. Test tokens have no monetary value."
)


def create_evidence(
    db: Session, settings: Settings, market: Market, payload: EvidenceCreate, resolver: str,
    kind: str = "proposal", bonded: bool = False,
) -> ProposeOut:
    """Build, hash and store an evidence bundle for a proposal (kind='proposal') or a dispute (kind='dispute').

    Nothing is sent on-chain: the wallet submits the returned hash itself."""
    if status_of(market) != "closed":
        raise ValueError(f"market is '{status_of(market)}'; evidence can only be prepared after trading closes and before resolution")
    pending = pending_proposal(db, market)
    if kind == "proposal" and pending is not None:
        raise ValueError(f"a proposal is already {pending.state} for this market")
    if kind == "dispute":
        if pending is None or pending.state != "proposed":
            raise ValueError("there is no open proposal to dispute (it may be already disputed, finalized or cancelled)")
        if pending.challenge_deadline <= utcnow():
            raise ValueError("the challenge window for this proposal has ended")
        if pending.resolver_address.lower() == resolver.lower():
            raise ValueError("you cannot dispute your own proposal")

    bundle = {
        "schema": "pm-resolution-evidence/1",
        "kind": kind,
        "market_id": market.blockchain_market_id,
        "market_address": market.contract_address,
        "chain_id": market.chain_id,
        "proposed_outcome": payload.proposed_outcome,
        "source_name": payload.source_name,
        "source_url": payload.source_url,
        "evidence_retrieved_at": payload.evidence_retrieved_at.isoformat(),
        "observation_period": payload.observation_period,
        "raw_evidence_reference": payload.raw_evidence_reference,
        "raw_evidence_hash": payload.raw_evidence_hash.lower(),
        "normalized_result": payload.normalized_result,
        "unit": payload.unit,
        "notes": payload.notes,
        "prepared_by": resolver,
        "prepared_at": utcnow().isoformat(),
    }
    if kind == "dispute":
        bundle["disputes_evidence_hash"] = pending.evidence_hash
    digest = _store(db, market, kind, payload.proposed_outcome, bundle, resolver)

    if kind == "dispute":
        call = "ResolutionManager.dispute(marketAddress, evidenceHash, evidenceURI)"
        note = "Evidence stored off-chain. The dispute exists only after your wallet submits this call and posts the matching bond."
    elif bonded:
        call = "ResolutionManager.proposeBonded(marketAddress, verdict, evidenceHash, evidenceURI)"
        note = "Evidence stored off-chain. Nothing is proposed until your wallet submits this call and escrows the bond."
    else:
        call = "ResolutionManager.propose(marketAddress, verdict, evidenceHash, evidenceURI)"
        note = "Evidence stored off-chain. Nothing is resolved until the resolver wallet submits this call on-chain."
    return ProposeOut(
        evidence_hash=digest, evidence_uri=evidence_uri(settings, market.blockchain_market_id, digest),
        verdict=VERDICT_CODE[payload.proposed_outcome], market_address=market.contract_address,
        resolution_manager_address=settings.resolution_manager_address, call=call, note=note,
        bonded=bonded or kind == "dispute", bond_note=BOND_NOTE if (bonded or kind == "dispute") else None,
    )


def create_arbitration_note(db: Session, settings: Settings, market: Market, body: ArbitrationCreate, arbiter: str) -> ProposeOut:
    """Store the arbiter's reasoning and return its hash for `ResolutionManager.arbitrate`."""
    pending = pending_proposal(db, market)
    if pending is None or pending.state != "disputed":
        raise ValueError("there is no disputed proposal to arbitrate")
    bundle = {
        "schema": "pm-arbitration-note/1", "kind": "arbitration", "market_id": market.blockchain_market_id,
        "market_address": market.contract_address, "chain_id": market.chain_id, "verdict": body.verdict,
        "rationale": body.rationale, "references": body.references,
        "proposal_evidence_hash": pending.evidence_hash, "dispute_evidence_hash": pending.dispute_evidence_hash,
        "proposed_outcome": pending.proposed_outcome, "arbiter": arbiter, "prepared_at": utcnow().isoformat(),
    }
    digest = _store(db, market, "arbitration", body.verdict, bundle, arbiter)
    return ProposeOut(
        evidence_hash=digest, evidence_uri=evidence_uri(settings, market.blockchain_market_id, digest),
        verdict=VERDICT_CODE[body.verdict], market_address=market.contract_address,
        resolution_manager_address=settings.resolution_manager_address,
        call="ResolutionManager.arbitrate(marketAddress, verdict, rationaleHash)",
        note="Rationale stored off-chain. Nothing is decided until the arbiter wallet submits this call; the loser's bond then goes to the winner.",
    )


def evidence_out(settings: Settings, market: Market, row: ResolutionEvidence) -> EvidenceOut:
    return EvidenceOut(
        kind=row.kind,
        evidence_hash=row.evidence_hash,
        evidence_uri=evidence_uri(settings, market.blockchain_market_id, row.evidence_hash),
        proposed_outcome=row.proposed_outcome,
        bundle=row.bundle,
        created_by=row.created_by,
        created_at=row.created_at,
        hash_verified=keccak_hex(row.canonical_json) == row.evidence_hash,
    )


def market_evidence(db: Session, settings: Settings, market: Market) -> list[EvidenceOut]:
    rows = db.scalars(
        select(ResolutionEvidence)
        .where(ResolutionEvidence.market_address == market.contract_address)
        .order_by(ResolutionEvidence.created_at)
    ).all()
    return [evidence_out(settings, market, r) for r in rows]


def resolution_view(db: Session, market: Market) -> ResolutionOut:
    props = db.scalars(
        select(ResolutionProposal)
        .where(ResolutionProposal.market_id == market.id)
        .order_by(ResolutionProposal.block_number, ResolutionProposal.log_index)
    ).all()
    known = set(
        db.scalars(select(ResolutionEvidence.evidence_hash).where(ResolutionEvidence.market_address == market.contract_address))
    )
    return ResolutionOut(
        market_id=market.blockchain_market_id,
        market_status=status_of(market),
        winning_outcome=market.winning_outcome,
        server_time=utcnow(),
        proposals=[
            ProposalOut(
                proposed_outcome=p.proposed_outcome, final_outcome=p.final_outcome, state=p.state,
                evidence_hash=p.evidence_hash, evidence_uri=p.evidence_uri, evidence_available=p.evidence_hash in known,
                resolver_address=p.resolver_address, proposal_timestamp=p.proposal_timestamp,
                challenge_deadline=p.challenge_deadline, dispute_status=p.dispute_status,
                resolution_timestamp=p.resolution_timestamp, transaction_hash=p.transaction_hash,
                bond=str(int(p.bond)), dispute_bond=str(int(p.dispute_bond)), disputer_address=p.disputer_address,
                dispute_evidence_hash=p.dispute_evidence_hash, dispute_evidence_uri=p.dispute_evidence_uri,
                dispute_evidence_available=p.dispute_evidence_hash in known, disputed_at=p.disputed_at,
                arbiter_address=p.arbiter_address, arbiter_rationale_hash=p.arbiter_rationale_hash,
                arbiter_rationale_available=p.arbiter_rationale_hash in known, arbitrated_at=p.arbitrated_at,
            )
            for p in props
        ],
    )


# ------------------------------------------------------------------ Stage 2: data-backed DRAFTS


_OPS = {">": _op.gt, ">=": _op.ge, "<": _op.lt, "<=": _op.le}


class DraftNotReady(Exception):
    """The data needed to propose an outcome is not available yet (message explains why)."""


class NoDataRule(Exception):
    """The market was created without a machine-checkable data_rule."""


def market_rule(db: Session, market: Market) -> dict:
    meta = db.get(MarketMetadata, market.metadata_hash)
    rule = (_json.loads(meta.canonical_json).get("data_rule") if meta else None)
    if not rule:
        raise NoDataRule("this market has no machine-checkable data_rule; the resolver must gather evidence manually")
    return rule


def evaluate_rule(rule: dict, total: _Decimal) -> str:
    return "YES" if _OPS[rule["operator"]](total, _Decimal(rule["threshold"])) else "NO"


def draft_from_data(db: Session, settings: Settings, market: Market, source: OpenMeteoSource, today: _date | None = None) -> DraftOut:
    """Fetch (or reuse) the weather record for the market's rule and PROPOSE an outcome to a human.

    Nothing is stored as evidence and nothing is sent on-chain: a resolver must review the draft,
    then call POST /resolutions/{id}/propose and sign the on-chain transaction themselves.
    """
    rule = market_rule(db, market)
    status = status_of(market)
    if status != "closed":
        raise DraftNotReady(f"market is '{status}'; drafts are only produced after trading closed and before resolution")

    query = WeatherQuery(
        location=rule["location"], latitude=_Decimal(rule["latitude"]), longitude=_Decimal(rule["longitude"]),
        start_date=_date.fromisoformat(rule["start_date"]), end_date=_date.fromisoformat(rule["end_date"]), model=rule["model"],
    )
    stored = ingest_weather(db, source, query)  # SourceUnavailable propagates: no silent substitution
    rec = stored.row
    today = today or utcnow().date()
    warnings = ["Open-Meteo values are reanalysis model output on a coarse grid, not station observations."]
    if stored.outcome == "revision":
        warnings.append(f"the provider's data for this period CHANGED since the earlier record #{rec.supersedes_id}; check the revision policy")

    if rec.validation_status == "invalid":
        raise DraftNotReady("provider data failed validation: " + "; ".join(rec.validation_notes))
    if rec.validation_status == "incomplete":
        if utcnow() < market.resolution_deadline:
            raise DraftNotReady(
                "data for the full period is not available yet (" + rec.validation_notes[0] + "). "
                "Wait for the provider; the market can only be voided after its resolution deadline."
            )
        outcome, result = "INVALID", "incomplete"
        warnings.append("period still incomplete after the resolution deadline: proposing INVALID per the missing-data policy")
    else:
        total = _Decimal(rec.normalized_value)
        outcome, result = evaluate_rule(rule, total), format(total.normalize(), "f")
        if total == _Decimal(rule["threshold"]):
            warnings.append("total is exactly on the threshold: check the rule operator is what the market text intends")

    evidence = {
        "proposed_outcome": outcome,
        "source_name": "Open-Meteo Historical Weather API (ERA5 reanalysis)" if rule["model"] == "era5" else "Open-Meteo Historical Weather API (ERA5-Land reanalysis)",
        "source_url": rec.source_url,
        "evidence_retrieved_at": rec.retrieved_at.isoformat(),
        "observation_period": f"{rec.period_start} to {rec.period_end} inclusive",
        "raw_evidence_reference": settings.public_api_url.rstrip("/") + rec.raw_payload_reference,
        "raw_evidence_hash": "0x" + rec.raw_payload_hash,
        "normalized_result": result,
        "unit": rec.unit,
        "notes": f"Rule: total precipitation {rule['operator']} {rule['threshold']} mm at {rule['location']} (grid {rec.latitude}, {rec.longitude}). "
                 f"Data record #{rec.id}. " + " ".join(warnings),
    }
    return DraftOut(
        external_data_id=rec.id, suggested_outcome=outcome, rule=rule, evidence=evidence, warnings=warnings,
        next_step="Review the evidence, then POST it to /resolutions/{market_id}/propose and submit the returned hash on-chain with your resolver wallet.",
    )
