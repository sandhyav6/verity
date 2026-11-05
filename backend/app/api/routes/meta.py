from fastapi import APIRouter
from pydantic import BaseModel

from app.api.deps import SettingsDep
from app.models.verity import DOCUMENT_TYPES

router = APIRouter(tags=["meta"])


class PublicConfig(BaseModel):
    chain_id: int
    chain_name: str
    rpc_url: str
    explorer_tx_url: str
    registry_address: str
    indexer_confirmations: int
    siwe_domain: str
    max_upload_bytes: int
    document_types: dict[int, str]  # index == the contract's DocumentType enum


@router.get("/config", response_model=PublicConfig)
def public_config(settings: SettingsDep) -> PublicConfig:
    """Everything the frontend needs to find the contract. Contains no secrets: the backend's own
    RPC URL (which may carry a provider key) is deliberately NOT exposed, only `public_rpc_url`."""
    return PublicConfig(
        chain_id=settings.chain_id, chain_name=settings.chain_name, rpc_url=settings.public_rpc_url,
        explorer_tx_url=settings.explorer_tx_url, registry_address=settings.registry_address,
        indexer_confirmations=settings.indexer_confirmations, siwe_domain=settings.siwe_domain,
        max_upload_bytes=settings.max_upload_bytes, document_types=DOCUMENT_TYPES,
    )
