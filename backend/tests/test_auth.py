from datetime import datetime, timedelta, timezone

import pytest
from eth_account import Account
from fastapi.testclient import TestClient
from sqlalchemy import update

from app.database.connection import session_scope
from app.main import create_app
from app.models import AuthNonce
from tests.helpers import build_message, login, sign


@pytest.fixture
def client(db_clean):
    with TestClient(create_app()) as c:
        yield c


def test_nonce_is_unique_and_expires_soon(client):
    a, b = client.get("/auth/nonce").json(), client.get("/auth/nonce").json()
    assert a["nonce"] != b["nonce"] and len(a["nonce"]) >= 8
    assert a["domain"] == "localhost:5173" and a["chain_id"] == 31337
    assert "Verity" in a["statement"]


def test_login_creates_session_cookie_and_me(client):
    account, r = login(client)
    assert r.status_code == 200, r.text
    assert r.json()["address"] == account.address.lower()
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    me = client.get("/auth/me")
    assert me.status_code == 200 and me.json()["address"] == account.address.lower()


def test_session_endpoint_answers_200_with_null_when_signed_out(client):
    assert client.get("/auth/session").status_code == 200 and client.get("/auth/session").json() is None
    account, _ = login(client)
    assert client.get("/auth/session").json()["address"] == account.address.lower()


def test_unauthenticated_requests_are_rejected(client):
    assert client.get("/auth/me").status_code == 401
    assert client.get("/documents").status_code == 401
    assert client.get("/auth/me", headers={"Authorization": "Bearer nonsense"}).status_code == 401


def test_nonce_cannot_be_replayed(client):
    account = Account.create()
    nonce = client.get("/auth/nonce").json()
    msg = build_message(nonce, account.address)
    body = {"message": msg, "signature": sign(account, msg)}
    assert client.post("/auth/verify", json=body).status_code == 200
    replay = client.post("/auth/verify", json=body)
    assert replay.status_code == 401 and "nonce" in replay.json()["detail"]


def test_nonce_we_never_issued_is_rejected(client):
    account = Account.create()
    nonce = client.get("/auth/nonce").json()
    nonce["nonce"] = "forgedNonce123"
    msg = build_message(nonce, account.address)
    r = client.post("/auth/verify", json={"message": msg, "signature": sign(account, msg)})
    assert r.status_code == 401


def test_expired_nonce_is_rejected(client):
    account = Account.create()
    nonce = client.get("/auth/nonce").json()
    with session_scope() as s:
        s.execute(update(AuthNonce).where(AuthNonce.nonce == nonce["nonce"]).values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
    msg = build_message(nonce, account.address)
    assert client.post("/auth/verify", json={"message": msg, "signature": sign(account, msg)}).status_code == 401


def test_wrong_signer_wrong_domain_wrong_chain_expired_message(client):
    victim, attacker = Account.create(), Account.create()

    nonce = client.get("/auth/nonce").json()  # attacker signs a message claiming to be the victim
    msg = build_message(nonce, victim.address)
    assert client.post("/auth/verify", json={"message": msg, "signature": sign(attacker, msg)}).status_code == 401

    _, r = login(client, domain="evil.example")
    assert r.status_code == 401

    _, r = login(client, chain_id=1)  # mainnet id must never be accepted
    assert r.status_code == 401

    old = datetime.now(timezone.utc) - timedelta(hours=2)
    _, r = login(client, now=old)  # issued two hours ago, expires 10 minutes after that
    assert r.status_code == 401


def test_tampered_message_is_rejected(client):
    account = Account.create()
    nonce = client.get("/auth/nonce").json()
    msg = build_message(nonce, account.address)
    sig = sign(account, msg)
    tampered = msg.replace("tamper-evident", "tamper-proof")
    assert client.post("/auth/verify", json={"message": tampered, "signature": sig}).status_code == 401


def test_malformed_input_is_rejected_cleanly(client):
    assert client.post("/auth/verify", json={"message": "x" * 30, "signature": "0x" + "ab" * 65}).status_code == 400
    assert client.post("/auth/verify", json={"message": "hi", "signature": "nope"}).status_code == 422


def test_logout_revokes_the_session(client):
    _, r = login(client)
    assert client.get("/auth/me").status_code == 200
    assert client.post("/auth/logout").status_code == 204
    assert client.get("/auth/me").status_code == 401


def test_bearer_header_is_not_a_bypass_with_unknown_token(client):
    assert client.get("/auth/me", headers={"Authorization": "Bearer " + "a" * 43}).status_code == 401
