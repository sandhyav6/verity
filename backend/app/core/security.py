"""Wallet authentication (Sign-In with Ethereum, EIP-4361) and server-side sessions.

Flow: GET /auth/nonce -> wallet signs the SIWE message -> POST /auth/verify -> session cookie.
A wallet address alone is never accepted as proof of identity.
"""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated

import siwe
from eth_utils import is_address
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.database.base import utcnow
from app.database.connection import get_db
from app.models import AuthNonce, User, UserSession

SESSION_COOKIE = "session"
MAX_MESSAGE_LIFETIME = timedelta(hours=1)
CLOCK_SKEW = timedelta(minutes=5)


def normalize_address(address: str) -> str:
    if not isinstance(address, str) or not is_address(address):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid wallet address")
    return address.lower()


def issue_nonce(db: Session, settings: Settings) -> AuthNonce:
    nonce = siwe.generate_nonce()
    row = AuthNonce(nonce=nonce, created_at=utcnow(), expires_at=utcnow() + timedelta(seconds=settings.nonce_ttl_seconds))
    db.add(row)
    db.commit()
    return row


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail)


def _parse_time(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def verify_siwe_login(db: Session, settings: Settings, message_text: str, signature: str) -> tuple[User, str, datetime]:
    """Verify a signed SIWE message and create a session. Returns (user, raw_token, expires_at)."""
    try:
        message = siwe.SiweMessage.from_message(message_text)
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "malformed SIWE message") from None

    now = utcnow()
    try:
        # Checks signature (EIP-191), domain, nonce equality, not-before and expiration.
        message.verify(signature=signature, domain=settings.siwe_domain, nonce=message.nonce, timestamp=now)
    except Exception as exc:
        raise _unauthorized(f"signature verification failed: {type(exc).__name__}") from None

    if message.chain_id != settings.chain_id:
        raise _unauthorized("wrong chain id")
    if message.uri != settings.siwe_uri_prefix and not message.uri.startswith(settings.siwe_uri_prefix.rstrip("/") + "/"):
        raise _unauthorized("unexpected uri")
    issued, expires = _parse_time(message.issued_at), _parse_time(message.expiration_time)
    if issued is None or expires is None:
        raise _unauthorized("issued-at and expiration-time are required")
    if abs(now - issued) > CLOCK_SKEW or expires - issued > MAX_MESSAGE_LIFETIME:
        raise _unauthorized("message timestamps out of range")

    # Replay protection: atomically burn the nonce. A nonce we never issued, an expired one, or one
    # already used matches zero rows.
    burned = db.execute(
        update(AuthNonce)
        .where(AuthNonce.nonce == message.nonce, AuthNonce.used_at.is_(None), AuthNonce.expires_at > now)
        .values(used_at=now)
        .returning(AuthNonce.nonce)
    ).first()
    if burned is None:
        db.rollback()
        raise _unauthorized("nonce unknown, expired or already used")

    address = message.address.lower()
    user = db.scalar(select(User).where(User.wallet_address == address))
    if user is None:
        user = User(wallet_address=address, created_at=now, last_active_at=now)
        db.add(user)
        db.flush()
    user.last_active_at = now

    token = secrets.token_urlsafe(32)
    session_expires = now + timedelta(seconds=settings.session_ttl_seconds)
    db.add(UserSession(user_id=user.id, token_hash=_hash(token), created_at=now, expires_at=session_expires))
    db.commit()
    return user, token, session_expires


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _extract_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip() or None
    return request.cookies.get(SESSION_COOKIE)


def get_optional_user(request: Request, db: Annotated[Session, Depends(get_db)]) -> User | None:
    token = _extract_token(request)
    if not token:
        return None
    now = utcnow()
    row = db.scalar(
        select(UserSession).where(
            UserSession.token_hash == _hash(token), UserSession.revoked_at.is_(None), UserSession.expires_at > now
        )
    )
    if row is None:
        return None
    user = db.get(User, row.user_id)
    if user is not None and now - user.last_active_at > timedelta(minutes=1):
        user.last_active_at = now
        db.commit()
    return user


def require_user(user: Annotated[User | None, Depends(get_optional_user)]) -> User:
    if user is None:
        raise _unauthorized("authentication required")
    return user


def revoke_session(db: Session, request: Request) -> None:
    token = _extract_token(request)
    if token:
        db.execute(
            update(UserSession).where(UserSession.token_hash == _hash(token)).values(revoked_at=utcnow())
        )
        db.commit()


# kept for tests: seconds a client should treat a session as valid
def session_cookie_params(settings: Settings, expires_at: datetime) -> dict:
    return {
        "key": SESSION_COOKIE,
        "httponly": True,
        "secure": settings.cookie_secure,
        "samesite": "lax",
        "expires": expires_at.astimezone(timezone.utc),
        "path": "/",
    }
