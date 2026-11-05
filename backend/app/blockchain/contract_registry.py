"""ABI loading and event decoding. ABIs are exported from the compiled contracts
(`contracts/scripts/export-abi.ts`) and never hand-written."""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from web3 import Web3
from web3._utils.events import get_event_data

ABI_DIR = Path(__file__).parent / "abi"

# Which events the indexer consumes. Everything else (e.g. AccessControl role events) is ignored.
INDEXED_EVENTS: dict[str, set[str]] = {
    "registry": {
        "IssuerAuthorized",
        "IssuerRemoved",
        "DocumentRegistered",
        "DocumentRevoked",
        "BatchRegistered",
        "BatchRevoked",
        "BatchDocumentRevoked",
    },
}
ABI_FILES = {"registry": "VerityRegistry"}


@dataclass(frozen=True)
class DecodedEvent:
    chain_id: int
    transaction_hash: str
    log_index: int
    block_number: int
    block_hash: str
    contract_address: str  # lowercase
    kind: str  # registry
    name: str
    args: dict[str, Any]  # JSON-safe: ints as decimal strings, bytes as 0x-hex, addresses lowercase

    @property
    def order_key(self) -> tuple[int, int]:
        return (self.block_number, self.log_index)


def load_abi(kind: str) -> list[dict[str, Any]]:
    return json.loads((ABI_DIR / f"{ABI_FILES[kind]}.json").read_text(encoding="utf-8"))


def _topic0(w3: Web3, event_abi: dict[str, Any]) -> str:
    sig = f"{event_abi['name']}({','.join(i['type'] for i in event_abi['inputs'])})"
    return w3.keccak(text=sig).to_0x_hex()


def jsonable(value: Any) -> Any:
    """Make decoded args JSON-safe without losing precision (uint256 -> decimal string)."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return str(value)
    if isinstance(value, (bytes, bytearray)):
        return "0x" + bytes(value).hex()
    if isinstance(value, str) and value.startswith("0x") and len(value) == 42:
        return value.lower()
    return value


class ContractRegistry:
    """Maps (contract kind, topic0) to an event ABI and decodes raw logs."""

    def __init__(self, w3: Web3, chain_id: int):
        self.w3 = w3
        self.chain_id = chain_id
        self._events: dict[tuple[str, str], dict[str, Any]] = {}
        for kind, wanted in INDEXED_EVENTS.items():
            for entry in load_abi(kind):
                if entry["type"] == "event" and entry["name"] in wanted:
                    self._events[(kind, _topic0(w3, entry))] = entry

    def decode(self, kind: str, log: Any) -> DecodedEvent | None:
        topic0 = log["topics"][0].to_0x_hex() if log["topics"] else None
        entry = self._events.get((kind, topic0))
        if entry is None:
            return None
        data = get_event_data(self.w3.codec, entry, log)
        args = {k: jsonable(v) for k, v in data["args"].items()}
        return DecodedEvent(
            chain_id=self.chain_id,
            transaction_hash=log["transactionHash"].to_0x_hex(),
            log_index=log["logIndex"],
            block_number=log["blockNumber"],
            block_hash=log["blockHash"].to_0x_hex(),
            contract_address=log["address"].lower(),
            kind=kind,
            name=entry["name"],
            args=args,
        )
