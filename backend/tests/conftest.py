"""Test harness.

* Database: TEST_DATABASE_URL if set (e.g. Docker Postgres), else an embedded PostgreSQL via
  `pgserver`. Always real PostgreSQL. Schema comes from the Alembic migrations, so migrations are
  exercised by every run.
* Chain: a real `hardhat node` + the real `contracts/scripts/deploy.ts`. No mocked blockchain.
Tests that need a chain use the module-scoped `chain` fixture (one node + deployment per module).
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# Environment must be set before the app modules are imported (limiter reads settings at import).
os.environ.setdefault("RATE_LIMIT_ENABLED", "false")
os.environ["SIWE_DOMAIN"] = "localhost:5173"
os.environ["SIWE_URI_PREFIX"] = "http://localhost:5173"
os.environ["CHAIN_ID"] = "31337"
os.environ["STORAGE_DIR"] = tempfile.mkdtemp(prefix="verity-test-storage-")

import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402
from web3 import Web3  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]
CONTRACTS = BACKEND.parent / "contracts"
sys.path.insert(0, str(BACKEND))

ZERO32 = b"\x00" * 32


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _reload_settings(**env: str) -> None:
    os.environ.update(env)
    from app.core.config import get_settings
    from app.database.connection import reset_engine

    get_settings.cache_clear()
    reset_engine()


@pytest.fixture(scope="session")
def database_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL")
    server = None
    if not url:
        import pgserver

        tmp = tempfile.mkdtemp(prefix="verity-test-pg-")
        server = pgserver.get_server(Path(tmp) / "data", cleanup_mode="delete")
        url = server.get_uri().replace("postgresql://", "postgresql+psycopg://")
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text("DROP DATABASE IF EXISTS verity_test"))
        c.execute(text("CREATE DATABASE verity_test"))
    admin.dispose()
    test_url = url.rsplit("/", 1)[0] + "/verity_test"

    _reload_settings(DATABASE_URL=test_url)
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "migrations"))
    command.upgrade(cfg, "head")
    yield test_url
    from app.database.connection import reset_engine

    reset_engine()
    if server is not None:
        server.cleanup()


@pytest.fixture
def db_clean(database_url):
    """Empty every table before a test (schema stays)."""
    eng = create_engine(database_url)
    with eng.begin() as c:
        tables = [r[0] for r in c.execute(text("select tablename from pg_tables where schemaname='public' and tablename <> 'alembic_version'"))]
        c.execute(text("TRUNCATE " + ", ".join(f'"{t}"' for t in tables) + " RESTART IDENTITY CASCADE"))
    eng.dispose()
    yield database_url


def _npx() -> str:
    exe = shutil.which("npx") or shutil.which("npx.cmd")
    assert exe, "npx not found; install Node.js to run chain integration tests"
    return exe


class Chain:
    """A running Hardhat node with VerityRegistry deployed. Helper methods send real transactions."""

    def __init__(self, rpc_url: str, deployment: dict, w3: Web3):
        self.rpc_url, self.deployment, self.w3 = rpc_url, deployment, w3
        from app.blockchain.contract_registry import load_abi

        self.registry = w3.eth.contract(address=deployment["registry"], abi=load_abi("registry"))
        accounts = w3.eth.accounts
        # deploy.ts: #0 admin + issuer manager, #1 "Northfield University", #2 "Harbor Audit LLP"
        self.admin, self.issuer, self.issuer2, self.outsider = accounts[0], accounts[1], accounts[2], accounts[3]

    def send(self, fn, sender: str):
        tx = fn.transact({"from": sender})
        receipt = self.w3.eth.wait_for_transaction_receipt(tx)
        assert receipt["status"] == 1, "transaction reverted"
        return receipt

    def register(self, doc_hash: str, sender: str | None = None, document_id: bytes | None = None, doc_type: int = 1,
                 metadata_hash: bytes = ZERO32, expires_at: int = 0):
        h = bytes.fromhex(doc_hash[2:])
        return self.send(self.registry.functions.registerDocument(document_id or h, h, doc_type, metadata_hash, expires_at), sender or self.issuer)

    def revoke(self, doc_hash: str, sender: str | None = None, reason: bytes = ZERO32):
        return self.send(self.registry.functions.revokeDocument(bytes.fromhex(doc_hash[2:]), reason), sender or self.issuer)

    def register_batch(self, root: str, count: int, sender: str | None = None, metadata_hash: bytes = ZERO32):
        return self.send(self.registry.functions.registerBatch(bytes.fromhex(root[2:]), count, metadata_hash), sender or self.issuer)

    def mine(self, n: int = 1) -> None:
        for _ in range(n):
            self.w3.provider.make_request("evm_mine", [])

    def increase_time(self, seconds: int) -> None:
        self.w3.provider.make_request("evm_increaseTime", [seconds])
        self.mine()

    def snapshot(self) -> str:
        return self.w3.provider.make_request("evm_snapshot", [])["result"]

    def revert(self, snap: str) -> None:
        assert self.w3.provider.make_request("evm_revert", [snap])["result"] is True

    def now(self) -> int:
        return self.w3.eth.get_block("latest")["timestamp"]


@pytest.fixture(scope="module")
def chain():
    port = _free_port()
    rpc = f"http://127.0.0.1:{port}"
    node = subprocess.Popen(
        [_npx(), "hardhat", "node", "--port", str(port)], cwd=CONTRACTS,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        w3 = Web3(Web3.HTTPProvider(rpc))
        for _ in range(120):
            try:
                if w3.is_connected():
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError("hardhat node did not start")

        name = f"pytest-{port}"
        env = {**os.environ, "RPC_URL": rpc, "DEPLOYMENT_NAME": name}
        subprocess.run([_npx(), "hardhat", "run", "scripts/deploy.ts", "--network", "localhost"],
                       cwd=CONTRACTS, env=env, check=True, capture_output=True)
        dep_file = CONTRACTS / "deployments" / f"{name}.json"
        deployment = json.loads(dep_file.read_text())
        dep_file.unlink(missing_ok=True)

        _reload_settings(RPC_URL=rpc, REGISTRY_ADDRESS=deployment["registry"], START_BLOCK="0", INDEXER_CONFIRMATIONS="0", INDEXER_BATCH_SIZE="500")
        yield Chain(rpc, deployment, w3)
    finally:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(node.pid)], capture_output=True)
        else:
            node.terminate()
        _reload_settings(REGISTRY_ADDRESS="")
