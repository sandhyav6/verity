from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from sqlalchemy import select

from app.api.deps import ChainDep, DbDep, SettingsDep, WeatherDep
from app.blockchain.client import ChainUnavailable
from app.blockchain.transaction_service import has_role
from app.core.security import require_user
from app.data_sources.http import SourceRejected, SourceUnavailable
from app.data_sources.weather import DataNotYetAvailable
from app.models import ResolutionEvidence, User
from app.schemas.data import DraftOut
from app.schemas.resolution import ArbitrationCreate, EvidenceCreate, ProposeOut, ResolutionOut
from app.services import market_service, resolution_service

router = APIRouter(prefix="/resolutions", tags=["resolutions"])


def _require_role(chain, settings, role: str, user: User, what: str) -> None:
    try:
        allowed = has_role(chain, settings, role, user.wallet_address)
    except ChainUnavailable as exc:
        raise HTTPException(503, f"cannot verify {what} role: node unavailable ({exc})") from exc
    if not allowed:
        raise HTTPException(403, f"wallet does not hold {role} on the ResolutionManager contract")


@router.get("/{market_id}", response_model=ResolutionOut)
def get_resolution(market_id: int, db: DbDep, settings: SettingsDep) -> ResolutionOut:
    market, _ = market_service.get_market_row(db, market_id, settings.chain_id)
    return resolution_service.resolution_view(db, market)


@router.get("/{market_id}/evidence/{evidence_hash}", response_class=PlainTextResponse)
def get_evidence_document(market_id: int, evidence_hash: str, db: DbDep, settings: SettingsDep) -> str:
    """The exact canonical JSON whose keccak256 is `evidence_hash`, so anyone can re-hash it."""
    market, _ = market_service.get_market_row(db, market_id, settings.chain_id)
    row = db.scalar(
        select(ResolutionEvidence).where(
            ResolutionEvidence.evidence_hash == evidence_hash.lower(),
            ResolutionEvidence.market_address == market.contract_address,
        )
    )
    if row is None:
        raise HTTPException(404, "evidence not found")
    return row.canonical_json


def _prepare(db, settings, market_id, payload, user, kind, bonded) -> ProposeOut:
    market, _ = market_service.get_market_row(db, market_id, settings.chain_id)
    try:
        return resolution_service.create_evidence(db, settings, market, payload, user.wallet_address, kind=kind, bonded=bonded)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/{market_id}/propose", response_model=ProposeOut, status_code=201)
def prepare_proposal(
    market_id: int,
    payload: EvidenceCreate,
    db: DbDep,
    settings: SettingsDep,
    chain: ChainDep,
    user: Annotated[User, Depends(require_user)],
    bonded: Annotated[bool, Query(description="Propose as anyone by escrowing a test-token bond (no RESOLVER_ROLE needed)")] = False,
) -> ProposeOut:
    """Stores the evidence bundle and returns its hash. Does NOT resolve the market.

    Default: only RESOLVER_ROLE wallets (no bond). With `bonded=true`: any signed-in wallet, which must
    then escrow the bond in the on-chain `proposeBonded` call. The contract re-checks everything."""
    if not bonded:
        _require_role(chain, settings, "RESOLVER_ROLE", user, "resolver")
    return _prepare(db, settings, market_id, payload, user, "proposal", bonded)


@router.post("/{market_id}/dispute", response_model=ProposeOut, status_code=201)
def prepare_dispute(
    market_id: int, payload: EvidenceCreate, db: DbDep, settings: SettingsDep, user: Annotated[User, Depends(require_user)]
) -> ProposeOut:
    """Stores YOUR evidence against an open proposal and returns its hash. Does NOT dispute anything:
    the dispute (and its bond) exists only once your wallet calls `ResolutionManager.dispute`.

    `proposed_outcome` is the outcome you assert is correct. Anyone signed in may prepare a dispute while the
    challenge window is open; the contract enforces the window, the bond and the no-self-dispute rule."""
    return _prepare(db, settings, market_id, payload, user, "dispute", True)


@router.post("/{market_id}/arbitration-note", response_model=ProposeOut, status_code=201)
def prepare_arbitration(
    market_id: int,
    body: ArbitrationCreate,
    db: DbDep,
    settings: SettingsDep,
    chain: ChainDep,
    user: Annotated[User, Depends(require_user)],
) -> ProposeOut:
    """ARBITER_ROLE wallets only: stores the reasoning and returns the hash for `ResolutionManager.arbitrate`."""
    _require_role(chain, settings, "ARBITER_ROLE", user, "arbiter")
    market, _ = market_service.get_market_row(db, market_id, settings.chain_id)
    try:
        return resolution_service.create_arbitration_note(db, settings, market, body, user.wallet_address)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/{market_id}/draft-from-data", response_model=DraftOut)
def draft_from_data(
    market_id: int,
    db: DbDep,
    settings: SettingsDep,
    chain: ChainDep,
    weather: WeatherDep,
    user: Annotated[User, Depends(require_user)],
) -> DraftOut:
    """Stage 2: fetch the market's source data and PROPOSE an outcome for a human resolver.

    Stores the data record (with provenance) but creates no evidence and sends nothing on-chain.
    """
    _require_role(chain, settings, "RESOLVER_ROLE", user, "resolver")
    market, _ = market_service.get_market_row(db, market_id, settings.chain_id)
    try:
        return resolution_service.draft_from_data(db, settings, market, weather)
    except resolution_service.NoDataRule as exc:
        raise HTTPException(422, str(exc)) from exc
    except (resolution_service.DraftNotReady, DataNotYetAvailable) as exc:
        raise HTTPException(409, str(exc)) from exc
    except SourceUnavailable as exc:
        raise HTTPException(503, f"data provider unavailable: {exc}") from exc
    except SourceRejected as exc:
        raise HTTPException(502, f"data provider rejected the request: {exc}") from exc
