"""daily activity rollup (dashboard chart) with backfill from existing trades

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "daily_activity",
        sa.Column("chain_id", sa.Integer(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("trades", sa.Integer(), nullable=False),
        sa.Column("volume", sa.Numeric(precision=78, scale=0), nullable=False),
        sa.PrimaryKeyConstraint("chain_id", "day"),
    )
    # databases that already hold trades get the rollup filled in
    op.execute(
        "INSERT INTO daily_activity (chain_id, day, trades, volume) "
        "SELECT chain_id, (timestamp AT TIME ZONE 'UTC')::date, count(*), sum(token_amount) FROM trades GROUP BY 1, 2"
    )


def downgrade() -> None:
    op.drop_table("daily_activity")
