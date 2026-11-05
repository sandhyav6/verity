from datetime import datetime

from pydantic import BaseModel, Field


class NonceOut(BaseModel):
    nonce: str
    expires_at: datetime
    domain: str
    chain_id: int
    uri: str
    statement: str


class VerifyIn(BaseModel):
    message: str = Field(min_length=20, max_length=4000)
    signature: str = Field(min_length=100, max_length=200, pattern=r"^0x[0-9a-fA-F]+$")


class SessionOut(BaseModel):
    address: str
    expires_at: datetime
    # Authorisation comes from the chain (VerityRegistry), not from this database.
    is_issuer: bool
    is_manager: bool
    roles_available: bool  # false when the chain could not be queried; the flags are then not authoritative
