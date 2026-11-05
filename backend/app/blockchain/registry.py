"""Read-only access to the VerityRegistry contract. This is how the API learns the authoritative state
(verification status, issuer authorisation, batch roots): the database is only a cache of events and
is never consulted for a verdict."""

from dataclasses import dataclass
from typing import Any

from eth_utils import keccak
from web3 import Web3

from app.blockchain.client import ChainClient
from app.blockchain.contract_registry import load_abi
from app.core.config import Settings
from app.models.verity import DOCUMENT_TYPES

ISSUER_MANAGER_ROLE = "0x" + keccak(text="ISSUER_MANAGER_ROLE").hex()
STATUS = {0: "not_registered", 1: "valid", 2: "revoked", 3: "expired"}
ZERO_ADDRESS = "0x" + "00" * 20


class RegistryNotConfigured(RuntimeError):
    pass


def _hex(b: bytes) -> str:
    return "0x" + bytes(b).hex()


@dataclass(frozen=True)
class OnChainVerification:
    status: str  # not_registered | valid | revoked | expired
    issuer: str
    issuer_authorized: bool
    document_id: str
    version: int
    latest_version: int
    document_type: str
    metadata_hash: str
    registered_at: int
    expires_at: int
    revoked_at: int
    revoked_by: str
    reason_hash: str


@dataclass(frozen=True)
class OnChainBatchVerification:
    included: bool
    status: str
    issuer: str
    issuer_authorized: bool
    registered_at: int
    revoked_at: int
    merkle_root: str


class RegistryReader:
    def __init__(self, client: ChainClient, settings: Settings):
        self.client = client
        self.settings = settings
        self._contract = None

    @property
    def configured(self) -> bool:
        return bool(self.settings.registry_address)

    @property
    def contract(self):
        if not self.configured:
            raise RegistryNotConfigured("REGISTRY_ADDRESS is not configured")
        if self._contract is None:
            self._contract = self.client.w3.eth.contract(
                address=Web3.to_checksum_address(self.settings.registry_address), abi=load_abi("registry")
            )
        return self._contract

    def _call(self, fn, what: str, block: int | str = "latest") -> Any:
        return self.client._call(lambda: fn.call(block_identifier=block), what)

    def verify_document(self, document_hash: str) -> OnChainVerification:
        v = self._call(self.contract.functions.verifyDocument(bytes.fromhex(document_hash[2:])), "verifyDocument")
        return OnChainVerification(
            status=STATUS[v[0]], issuer=v[1].lower(), issuer_authorized=bool(v[2]), document_id=_hex(v[3]), version=int(v[4]),
            latest_version=int(v[5]), document_type=DOCUMENT_TYPES.get(int(v[6]), "other"), metadata_hash=_hex(v[7]),
            registered_at=int(v[8]), expires_at=int(v[9]), revoked_at=int(v[10]), revoked_by=v[11].lower(), reason_hash=_hex(v[12]),
        )

    def batch_id_by_root(self, merkle_root: str) -> int:
        return int(self._call(self.contract.functions.batchIdByRoot(bytes.fromhex(merkle_root[2:])), "batchIdByRoot"))

    def get_batch(self, batch_id: int) -> dict | None:
        """Batch struct from the chain, or None if the id is unknown."""
        if batch_id <= 0:
            return None
        count = int(self._call(self.contract.functions.batchCount(), "batchCount"))
        if batch_id > count:
            return None
        b = self._call(self.contract.functions.getBatch(batch_id), "getBatch")
        return {"issuer": b[0].lower(), "registered_at": int(b[1]), "revoked_at": int(b[2]), "document_count": int(b[3]),
                "merkle_root": _hex(b[4]), "metadata_hash": _hex(b[5])}

    def verify_batch_document(self, batch_id: int, document_hash: str, proof: list[str]) -> OnChainBatchVerification:
        v = self._call(
            self.contract.functions.verifyBatchDocument(batch_id, bytes.fromhex(document_hash[2:]), [bytes.fromhex(p[2:]) for p in proof]),
            "verifyBatchDocument",
        )
        return OnChainBatchVerification(
            included=bool(v[0]), status=STATUS[v[1]], issuer=v[2].lower(), issuer_authorized=bool(v[3]),
            registered_at=int(v[4]), revoked_at=int(v[5]), merkle_root=_hex(v[6]),
        )

    def is_authorized_issuer(self, address: str) -> bool:
        return bool(self._call(self.contract.functions.isAuthorizedIssuer(Web3.to_checksum_address(address)), "isAuthorizedIssuer"))

    def is_issuer_manager(self, address: str) -> bool:
        fn = self.contract.functions.hasRole(bytes.fromhex(ISSUER_MANAGER_ROLE[2:]), Web3.to_checksum_address(address))
        return bool(self._call(fn, "hasRole"))
