import logging
import time
from collections.abc import Callable
from typing import Any, TypeVar

from web3 import Web3
from web3.exceptions import BlockNotFound, Web3Exception

log = logging.getLogger(__name__)
T = TypeVar("T")

RPC_ERRORS = (Web3Exception, ConnectionError, TimeoutError, OSError)


class ChainUnavailable(RuntimeError):
    """The RPC node could not be reached after retries."""


class ChainClient:
    """Thin web3.py wrapper adding timeouts and retry with backoff.

    Read-only by design: the backend has no signing key and sends no transactions.
    """

    def __init__(self, rpc_url: str, expected_chain_id: int, retries: int = 3, backoff: float = 0.5):
        self.w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 15}))
        self.expected_chain_id = expected_chain_id
        self.retries = retries
        self.backoff = backoff

    def _call(self, fn: Callable[[], T], what: str) -> T:
        last: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                return fn()
            except BlockNotFound:
                raise  # a definitive answer, not a transient failure
            except RPC_ERRORS as exc:  # transient network/RPC failure
                last = exc
                log.warning("rpc %s failed (attempt %d/%d): %s", what, attempt, self.retries, exc)
                time.sleep(self.backoff * attempt)
        raise ChainUnavailable(f"RPC call {what} failed after {self.retries} attempts: {last}")

    def chain_id(self) -> int:
        return self._call(lambda: self.w3.eth.chain_id, "eth_chainId")

    def assert_chain(self) -> None:
        actual = self.chain_id()
        if actual != self.expected_chain_id:
            raise RuntimeError(f"RPC chain id {actual} != configured {self.expected_chain_id}")

    def head(self) -> int:
        return self._call(lambda: self.w3.eth.block_number, "eth_blockNumber")

    def block(self, number: int) -> dict[str, Any]:
        return self._call(lambda: self.w3.eth.get_block(number), f"eth_getBlockByNumber({number})")

    def block_hash(self, number: int) -> str | None:
        """Hex hash of block `number`, or None if the chain no longer has that block."""
        try:
            return self.block(number)["hash"].to_0x_hex()
        except BlockNotFound:
            return None

    def logs(self, from_block: int, to_block: int, addresses: list[str]) -> list[Any]:
        if not addresses:
            return []
        params = {
            "fromBlock": from_block,
            "toBlock": to_block,
            "address": [Web3.to_checksum_address(a) for a in addresses],
        }
        return self._call(lambda: self.w3.eth.get_logs(params), f"eth_getLogs({from_block}-{to_block})")

    def receipt(self, tx_hash: str) -> Any | None:
        try:
            return self.w3.eth.get_transaction_receipt(tx_hash)
        except RPC_ERRORS as exc:
            if "not found" in str(exc).lower():
                return None
            raise ChainUnavailable(str(exc)) from exc

    def transaction(self, tx_hash: str) -> Any | None:
        try:
            return self.w3.eth.get_transaction(tx_hash)
        except RPC_ERRORS as exc:
            if "not found" in str(exc).lower():
                return None
            raise ChainUnavailable(str(exc)) from exc
