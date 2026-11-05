"""Start (or attach to) a local embedded PostgreSQL for development when Docker is unavailable.

    python scripts/dev_db.py [data_dir]      -> prints a DATABASE_URL for the `verity` database

Data lives outside the repo (default: <user cache>/verity-cache/pgdata). The server keeps running
after this script exits; stop it with `python scripts/dev_db.py --stop`.
The Docker Compose setup (Phase 7) uses a regular postgres container instead.
"""

import os
import subprocess
import sys
from pathlib import Path

import pgserver


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    base = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".cache")) / "verity-cache" / "pgdata"
    data_dir = Path(args[0]) if args else base
    data_dir.mkdir(parents=True, exist_ok=True)

    if "--stop" in sys.argv:
        pg_ctl = Path(pgserver.__file__).parent / "pginstall" / "bin" / ("pg_ctl.exe" if os.name == "nt" else "pg_ctl")
        done = subprocess.run([str(pg_ctl), "-D", str(data_dir), "stop", "-m", "fast"], capture_output=True, text=True)
        print((done.stdout or done.stderr).strip().splitlines()[-1])
        return
    server = pgserver.get_server(data_dir, cleanup_mode=None)
    base = server.get_uri().replace("postgresql://", "postgresql+psycopg://")
    # SQLAlchemy rather than server.psql(): pgserver's psql helper does not quote paths containing spaces.
    from sqlalchemy import create_engine, text

    admin = create_engine(base, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        if not c.execute(text("select 1 from pg_database where datname = 'verity'")).first():
            c.execute(text("create database verity"))
    admin.dispose()
    print(base.rsplit("/", 1)[0] + "/verity")


if __name__ == "__main__":
    main()
