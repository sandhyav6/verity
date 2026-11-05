from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    """Environment-based configuration. Secrets never have real defaults here."""

    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", extra="ignore")

    # database (local development credentials only; see .env.example)
    database_url: str = "postgresql+psycopg://verity:verity_dev_only@localhost:5433/verity"

    # blockchain
    rpc_url: str = "http://127.0.0.1:8545"  # backend-only; may contain a provider key, never sent to browsers
    public_rpc_url: str = "http://127.0.0.1:8545"  # key-free RPC URL the browser may use for reads
    chain_name: str = "Hardhat Local"
    chain_id: int = 31337
    registry_address: str = ""  # VerityRegistry
    start_block: int = 0
    indexer_confirmations: int = 1
    indexer_batch_size: int = 500
    indexer_poll_seconds: float = 2.0
    explorer_tx_url: str = ""  # e.g. https://sepolia.etherscan.io/tx/ ; empty for local chains

    # SIWE / sessions
    siwe_domain: str = "localhost:5173"
    siwe_uri_prefix: str = "http://localhost:5173"
    nonce_ttl_seconds: int = 300
    session_ttl_seconds: int = 8 * 3600
    cookie_secure: bool = False  # set true behind HTTPS

    # API
    allowed_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])
    public_api_url: str = "http://localhost:8000"
    rate_limit_enabled: bool = True
    rate_limit_default: str = "120/minute"
    rate_limit_auth: str = "10/minute"
    rate_limit_upload: str = "20/minute"

    # document storage (files never go on-chain; see app/storage)
    storage_backend: Literal["local"] = "local"  # an S3-compatible backend plugs in behind app.storage.base.Storage
    storage_dir: Path = REPO_ROOT / "backend" / ".storage"  # development default; mount a volume in production
    max_upload_bytes: int = 25 * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
