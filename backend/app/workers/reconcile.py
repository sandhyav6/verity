"""Compare the database with the contract:  python -m app.workers.reconcile   (exit 1 on drift)"""

import sys

from app.blockchain.client import ChainClient
from app.blockchain.reconcile import reconcile
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.database.connection import session_scope


def main() -> int:
    configure_logging()
    settings = get_settings()
    client = ChainClient(settings.rpc_url, settings.chain_id)
    with session_scope() as db:
        problems = reconcile(db, client, settings)
    for p in problems:
        print("DRIFT:", p)
    print("reconcile:", "OK, database matches the chain" if not problems else f"{len(problems)} discrepancies")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
