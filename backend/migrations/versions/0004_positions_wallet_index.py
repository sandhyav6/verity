"""index positions by wallet (portfolio lookups and distinct-trader counts)

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-05
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index("ix_positions_wallet", "positions", ["wallet_address"])


def downgrade() -> None:
    op.drop_index("ix_positions_wallet", table_name="positions")
