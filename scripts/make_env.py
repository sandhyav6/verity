#!/usr/bin/env python
"""Create a root `.env` for a local (non-Docker) run from a deployment record, so addresses are never copied by hand.

    python scripts/make_env.py [deployment-name] [--database-url URL] [--force]

Reads contracts/deployments/<name>.json (default: local), starts from .env.example, and fills in the contract
addresses, start block and chain id. Refuses to overwrite an existing .env unless --force is given.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build(example: str, dep: dict, database_url: str | None) -> str:
    values = {
        "REGISTRY_ADDRESS": dep["registry"],
        "START_BLOCK": str(dep["deployBlock"]), "CHAIN_ID": str(dep["chainId"]),
    }
    if database_url:
        values["DATABASE_URL"] = database_url
    out = []
    for line in example.splitlines():
        m = re.match(r"^([A-Z_]+)=", line)
        if m and m.group(1) in values:
            comment = re.search(r"\s+#.*$", line)
            line = f"{m.group(1)}={values.pop(m.group(1))}{comment.group(0) if comment else ''}"
        out.append(line)
    out.extend(f"{k}={v}" for k, v in values.items())  # anything not present in the example
    return "\n".join(out) + "\n"


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("--")]
    name = args[0] if args else "local"
    db = argv[argv.index("--database-url") + 1] if "--database-url" in argv else None
    if db in args:
        args.remove(db)
        name = args[0] if args else "local"
    dep_file = ROOT / "contracts" / "deployments" / f"{name}.json"
    if not dep_file.exists():
        print(f"{dep_file} not found. Deploy first: cd contracts && npx hardhat run scripts/deploy.ts --network localhost", file=sys.stderr)
        return 1
    target = ROOT / ".env"
    if target.exists() and "--force" not in argv:
        print(".env already exists; pass --force to overwrite", file=sys.stderr)
        return 1
    target.write_text(build((ROOT / ".env.example").read_text(encoding="utf-8"), json.loads(dep_file.read_text()), db), encoding="utf-8")
    print(f"wrote {target} from {dep_file.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
