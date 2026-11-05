import logging
import sys


def configure_logging(level: int = logging.INFO) -> None:
    """Plain structured-ish logging. Never log secrets, session tokens or signatures."""
    logging.basicConfig(
        level=level,
        stream=sys.stdout,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
