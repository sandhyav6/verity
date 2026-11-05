import json
import subprocess
import sys
from pathlib import Path

from app.tools.load_deployment import lines

BACKEND = Path(__file__).resolve().parents[1]
DEPLOYMENT = {
    "factory": "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9", "resolutionManager": "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    "token": "0x5FbDB2315678afecb367f032d93F642f64180aa3", "deployBlock": 4, "chainId": 31337,
}


def write(tmp_path) -> str:
    p = tmp_path / "compose.json"
    p.write_text(json.dumps(DEPLOYMENT))
    return str(p)


def test_exports_addresses_and_start_block_from_the_deployment_file(tmp_path):
    out = lines(write(tmp_path), environ={})
    assert "export FACTORY_ADDRESS=0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" in out
    assert "export RESOLUTION_MANAGER_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" in out
    assert "export TOKEN_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3" in out
    assert "export START_BLOCK=4" in out and "export CHAIN_ID=31337" in out


def test_an_explicit_environment_always_wins(tmp_path):
    out = lines(write(tmp_path), environ={"FACTORY_ADDRESS": "0x" + "1" * 40, "START_BLOCK": "999"})
    assert not any(o.startswith("export FACTORY_ADDRESS") or o.startswith("export START_BLOCK") for o in out)
    assert any(o.startswith("export TOKEN_ADDRESS") for o in out)


def test_the_module_runs_as_the_entrypoint_uses_it(tmp_path):
    r = subprocess.run([sys.executable, "-m", "app.tools.load_deployment", write(tmp_path)], cwd=BACKEND, capture_output=True, text=True, env={"PATH": ""})
    assert r.returncode == 0 and "export FACTORY_ADDRESS=" in r.stdout
    bad = subprocess.run([sys.executable, "-m", "app.tools.load_deployment"], cwd=BACKEND, capture_output=True, text=True)
    assert bad.returncode != 0 and "usage" in bad.stderr
