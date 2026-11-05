"""Indexer process:  python -m app.workers.indexer [--once]"""

import logging
import sys

from app.blockchain.client import ChainClient
from app.blockchain.contract_registry import ContractRegistry
from app.blockchain.event_listener import Indexer
from app.core.config import get_settings
from app.core.logging import configure_logging


def build_indexer() -> Indexer:
    settings = get_settings()
    client = ChainClient(settings.rpc_url, settings.chain_id)
    return Indexer(client, ContractRegistry(client.w3, settings.chain_id), settings)


def main() -> None:
    configure_logging()
    indexer = build_indexer()
    if "--once" in sys.argv:
        result = indexer.catch_up()
        logging.getLogger(__name__).info("caught up: %s", result)
        return
    indexer.run_forever()


if __name__ == "__main__":
    main()
