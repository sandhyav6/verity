from datetime import datetime, timedelta, timezone

import siwe
from eth_account import Account
from eth_account.messages import encode_defunct


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def build_message(nonce_resp: dict, address: str, **overrides) -> str:
    now = overrides.pop("now", datetime.now(timezone.utc))
    fields = dict(
        domain=nonce_resp["domain"], address=address, uri=nonce_resp["uri"], version="1",
        chain_id=nonce_resp["chain_id"], nonce=nonce_resp["nonce"], statement=nonce_resp["statement"],
        issued_at=iso(now), expiration_time=iso(now + timedelta(minutes=10)),
    )
    fields.update(overrides)
    return siwe.SiweMessage(**fields).prepare_message()


def sign(account, message: str) -> str:
    return account.sign_message(encode_defunct(text=message)).signature.to_0x_hex()


def login(client, account=None, **overrides):
    """Full SIWE login through the API. Returns (account, response)."""
    account = account or Account.create()
    nonce = client.get("/auth/nonce").json()
    msg = build_message(nonce, account.address, **overrides)
    return account, client.post("/auth/verify", json={"message": msg, "signature": sign(account, msg)})


# Hardhat's PUBLIC development accounts (the well-known test mnemonic). Never fund these on a real network.
DEV_KEYS = {
    "admin": "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",  # #0 manager
    "issuer": "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",  # #1 Northfield University
    "issuer2": "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",  # #2 Harbor Audit LLP
    "outsider": "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",  # #3 nobody
}
