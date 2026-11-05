import logging
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, HTTPException, status
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.blockchain.client import ChainClient
from app.blockchain.registry import RegistryNotConfigured, RegistryReader
from app.core.config import Settings, get_settings
from app.core.security import get_optional_user, require_user
from app.database.connection import get_db
from app.models import User
from app.storage import Storage, get_storage

log = logging.getLogger(__name__)

DbDep = Annotated[Session, Depends(get_db)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
StorageDep = Annotated[Storage, Depends(get_storage)]

_settings = get_settings()
limiter = Limiter(
    key_func=get_remote_address,
    default_limits=[_settings.rate_limit_default],
    enabled=_settings.rate_limit_enabled,
)


@lru_cache
def _client(rpc_url: str, chain_id: int) -> ChainClient:
    return ChainClient(rpc_url, chain_id)


def get_chain(settings: SettingsDep) -> ChainClient:
    """Read-only chain access for the API (verification, role checks, tx status)."""
    return _client(settings.rpc_url, settings.chain_id)


ChainDep = Annotated[ChainClient, Depends(get_chain)]


def get_registry(settings: SettingsDep, chain: ChainDep) -> RegistryReader:
    reader = RegistryReader(chain, settings)
    if not reader.configured:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "the registry contract address is not configured")
    return reader


RegistryDep = Annotated[RegistryReader, Depends(get_registry)]
OptionalUser = Annotated[User | None, Depends(get_optional_user)]
CurrentUser = Annotated[User, Depends(require_user)]


def require_issuer(user: CurrentUser, registry: RegistryDep) -> User:
    """The signed-in wallet must be an authorised issuer ON-CHAIN right now (not merely in our database)."""
    if not registry.is_authorized_issuer(user.wallet_address):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "this wallet is not an authorised issuer")
    return user


IssuerUser = Annotated[User, Depends(require_issuer)]


def roles_for(registry: RegistryReader, address: str) -> tuple[bool, bool, bool]:
    """(is_issuer, is_manager, roles_available). Chain failures are logged and reported, never hidden."""
    try:
        return registry.is_authorized_issuer(address), registry.is_issuer_manager(address), True
    except RegistryNotConfigured:
        return False, False, False
    except Exception as exc:  # ChainUnavailable and RPC errors
        log.warning("could not read roles for %s: %s", address, exc)
        return False, False, False
