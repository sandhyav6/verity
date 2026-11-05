"""Print shell `export` lines from a contracts/deployments/*.json file:

    eval "$(python -m app.tools.load_deployment /deployments/compose.json)"

Only variables that are not already set are exported, so an explicit environment always wins.
"""

import json
import os
import shlex
import sys

MAPPING = {
    "REGISTRY_ADDRESS": "registry",
    "START_BLOCK": "deployBlock",
    "CHAIN_ID": "chainId",
}


def lines(path: str, environ: dict[str, str] | None = None) -> list[str]:
    environ = os.environ if environ is None else environ
    data = json.load(open(path, encoding="utf-8"))
    out = []
    for var, key in MAPPING.items():
        if key in data and not environ.get(var):
            out.append(f"export {var}={shlex.quote(str(data[key]))}")
    return out


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python -m app.tools.load_deployment <deployment.json>")
    print("\n".join(lines(sys.argv[1])))
