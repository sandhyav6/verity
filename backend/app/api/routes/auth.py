from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy import select

from app.api.deps import ChainDep, DbDep, OptionalUser, SettingsDep, limiter, roles_for
from app.blockchain.registry import RegistryReader
from app.core.config import get_settings
from app.core.security import (
    SESSION_COOKIE,
    issue_nonce,
    revoke_session,
    session_cookie_params,
    verify_siwe_login,
)
from app.models import UserSession
from app.schemas.auth import NonceOut, SessionOut, VerifyIn

router = APIRouter(prefix="/auth", tags=["auth"])
_s = get_settings()

STATEMENT = "Sign in to Verity, the tamper-evident document registry. This signature proves wallet ownership and does not authorise any transaction."


@router.get("/nonce", response_model=NonceOut)
@limiter.limit(_s.rate_limit_auth)
def get_nonce(request: Request, db: DbDep, settings: SettingsDep) -> NonceOut:
    row = issue_nonce(db, settings)
    return NonceOut(
        nonce=row.nonce, expires_at=row.expires_at, domain=settings.siwe_domain, chain_id=settings.chain_id,
        uri=settings.siwe_uri_prefix, statement=STATEMENT,
    )


def _session_out(settings, chain, address: str, expires_at) -> SessionOut:
    issuer, manager, available = roles_for(RegistryReader(chain, settings), address)
    return SessionOut(address=address, expires_at=expires_at, is_issuer=issuer, is_manager=manager, roles_available=available)


@router.post("/verify", response_model=SessionOut)
@limiter.limit(_s.rate_limit_auth)
def verify(request: Request, body: VerifyIn, response: Response, db: DbDep, settings: SettingsDep, chain: ChainDep) -> SessionOut:
    user, token, expires_at = verify_siwe_login(db, settings, body.message, body.signature)
    response.set_cookie(value=token, **session_cookie_params(settings, expires_at))
    return _session_out(settings, chain, user.wallet_address, expires_at)


@router.get("/me", response_model=SessionOut)
def me(user: OptionalUser, settings: SettingsDep, db: DbDep, chain: ChainDep) -> SessionOut:
    if user is None:
        raise HTTPException(401, "not signed in")
    expires = db.scalar(
        select(UserSession.expires_at).where(UserSession.user_id == user.id, UserSession.revoked_at.is_(None))
        .order_by(UserSession.expires_at.desc()).limit(1)
    )
    return _session_out(settings, chain, user.wallet_address, expires)


@router.get("/session", response_model=SessionOut | None)
def session(user: OptionalUser, settings: SettingsDep, db: DbDep, chain: ChainDep) -> SessionOut | None:
    """Like /auth/me but answers 200 with null when signed out, so the browser app can ask on every page load
    without logging a failed request."""
    return me(user, settings, db, chain) if user is not None else None


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, db: DbDep) -> None:
    revoke_session(db, request)
    response.delete_cookie(SESSION_COOKIE, path="/")
