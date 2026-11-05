"""End-to-end API tests with a real chain, real PostgreSQL and real contracts (nothing mocked):
SIWE login -> upload -> on-chain registration -> indexing -> verification -> revocation -> versions -> Merkle batch."""

import hashlib
import json

import pytest
from eth_account import Account
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import create_app
from app.verity.hashing import metadata_hash
from app.verity.merkle import merkle_root, proofs_for_all
from app.workers.indexer import build_indexer
from tests.helpers import DEV_KEYS, login


def sha(data: bytes) -> str:
    return "0x" + hashlib.sha256(data).hexdigest()


def pdf(label: str) -> bytes:
    return b"%PDF-1.4\n% " + label.encode() + b"\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n"


@pytest.fixture
def app_client(db_clean, chain):
    with TestClient(create_app()) as c:
        yield c


def signed_in(who: str) -> TestClient:
    c = TestClient(create_app())
    _, r = login(c, Account.from_key(DEV_KEYS[who]))
    assert r.status_code == 200, r.text
    return c


@pytest.fixture
def issuer(db_clean, chain):
    with signed_in("issuer") as c:
        yield c


def upload(client, data: bytes, title="Degree Certificate", dtype="academic_certificate", visibility="private", metadata=None, filename="file.pdf", **form):
    return client.post("/documents/uploads", files={"file": (filename, data, "application/pdf")},
                       data={"title": title, "document_type": dtype, "visibility": visibility, "metadata": json.dumps(metadata or {}), **form})


def register_uploaded(chain, up: dict, document_id: bytes | None = None, sender=None, **kw):
    h = bytes.fromhex(up["document_hash"][2:])
    return chain.send(chain.registry.functions.registerDocument(document_id or h, h, 1, bytes.fromhex(up["metadata_hash"][2:]), kw.get("expires_at", 0)),
                      sender or chain.issuer)


def index():
    return build_indexer().catch_up()


# ------------------------------------------------------------------------------------------------ roles & auth


def test_session_roles_come_from_the_chain(chain, db_clean):
    with signed_in("issuer") as c:
        me = c.get("/auth/me").json()
        assert (me["is_issuer"], me["is_manager"], me["roles_available"]) == (True, False, True)
    with signed_in("admin") as c:
        me = c.get("/auth/me").json()
        assert (me["is_issuer"], me["is_manager"]) == (False, True)
    with signed_in("outsider") as c:
        me = c.get("/auth/me").json()
        assert (me["is_issuer"], me["is_manager"]) == (False, False)


def test_public_config_has_no_secrets(app_client, chain):
    cfg = app_client.get("/config").json()
    assert cfg["registry_address"].lower() == chain.deployment["registry"].lower()
    assert cfg["document_types"]["1"] == "academic_certificate"
    assert cfg["rpc_url"] == get_settings().public_rpc_url
    assert not {"database_url", "storage_dir", "siwe_secret"} & set(cfg)


# ------------------------------------------------------------------------------------------------ upload


def test_upload_requires_an_authorised_issuer(chain, db_clean, app_client):
    assert upload(app_client, pdf("anon")).status_code == 401
    with signed_in("outsider") as c:
        r = upload(c, pdf("outsider"))
        assert r.status_code == 403 and "authorised issuer" in r.json()["detail"]


def test_upload_returns_the_sha256_of_the_bytes_regardless_of_filename(issuer):
    data = pdf("same-bytes")
    a = upload(issuer, data, filename="contract-final.pdf")
    b = upload(issuer, data, filename="totally-different-name.docx")
    assert a.status_code == b.status_code == 201
    assert a.json()["document_hash"] == b.json()["document_hash"] == sha(data)
    assert a.json()["content_type"] == "application/pdf" and a.json()["size_bytes"] == len(data)
    changed = upload(issuer, data + b" ")
    assert changed.json()["document_hash"] != a.json()["document_hash"]


def test_upload_metadata_hash_matches_the_canonical_definition(issuer):
    r = upload(issuer, pdf("meta"), title="  Audit 2026 ", dtype="audit_report", metadata={"fiscal_year": "2026", "client": "ACME"}).json()
    expected = metadata_hash({"title": "Audit 2026", "document_type": "audit_report", "attributes": {"fiscal_year": "2026", "client": "ACME"}})
    assert r["metadata_hash"] == expected
    assert json.loads(r["canonical_metadata"])["attributes"]["client"] == "ACME"


def test_upload_validation(issuer, monkeypatch):
    assert upload(issuer, pdf("v"), dtype="betting_slip").status_code == 422
    assert upload(issuer, pdf("v"), title="").status_code == 422
    assert upload(issuer, pdf("v"), metadata={"k": 5}).status_code == 422
    assert upload(issuer, pdf("v"), metadata={f"k{i}": "v" for i in range(21)}).status_code == 422
    assert upload(issuer, pdf("v"), visibility="friends").status_code == 422
    assert upload(issuer, pdf("v"), expected_hash="0x1234").status_code == 422
    assert upload(issuer, pdf("v"), expected_hash=sha(b"something else")).status_code == 422  # corrupted in transit
    ok = upload(issuer, pdf("v"), expected_hash=sha(pdf("v")))
    assert ok.status_code == 201


def test_upload_rejects_executables_empty_and_oversized_files(issuer, monkeypatch):
    exe = issuer.post("/documents/uploads", files={"file": ("report.pdf", b"MZ" + b"\x00" * 200, "application/pdf")},
                      data={"title": "t", "document_type": "other"})
    assert exe.status_code == 415 and "executable" in exe.json()["detail"]  # extension and declared type are irrelevant
    empty = issuer.post("/documents/uploads", files={"file": ("e.pdf", b"", "application/pdf")}, data={"title": "t", "document_type": "other"})
    assert empty.status_code in (415, 422)
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "1000")
    get_settings.cache_clear()
    try:
        big = upload(issuer, b"%PDF-1.4\n" + b"a" * 5000)
        assert big.status_code == 413
    finally:
        monkeypatch.delenv("MAX_UPLOAD_BYTES")
        get_settings.cache_clear()


# ------------------------------------------------------------------------------------------------ full lifecycle


def test_full_document_lifecycle(chain, issuer, app_client):
    # 1. upload, 2. register on-chain
    up = upload(issuer, pdf("lifecycle-v1"), title="BSc Certificate", visibility="private", metadata={"holder": "A. Student"}).json()
    h1 = up["document_hash"]
    v = app_client.post("/verify", json={"document_hash": h1}).json()
    assert v["verdict"] == "not_verified" and v["registration"] is None, "an upload alone is not a registration"

    receipt = register_uploaded(chain, up)
    # not verified by the API until the chain says so; once mined the CONTRACT answers, even before indexing
    v = app_client.post("/verify", json={"document_hash": h1}).json()
    assert v["verdict"] == "verified"
    assert v["registration"]["issuer"]["address"] == chain.issuer.lower()
    assert v["registration"]["transaction_hash"] is None  # not indexed yet: honest about it
    assert v["registration"]["title"] is None

    # 3. index
    index()
    v = app_client.post("/verify", json={"document_hash": h1}).json()
    reg = v["registration"]
    assert v["verdict"] == "verified"
    assert reg["transaction_hash"] == receipt["transactionHash"].to_0x_hex()
    assert reg["issuer"]["organization_name"] == "Northfield University" and reg["issuer"]["currently_authorized"] is True
    assert reg["version_number"] == 1 and reg["is_latest"] is True and reg["document_type"] == "academic_certificate"
    assert reg["title"] is None, "private titles are not shown to the public"

    # privacy: details for the public hide title/metadata/file; the issuer sees them with a verified metadata hash
    pub = app_client.get(f"/documents/{h1}").json()["document"]
    assert pub["title"] is None and pub["metadata"] is None and pub["file_available"] is False
    assert "storage" not in json.dumps(pub).lower()
    mine = issuer.get(f"/documents/{h1}").json()["document"]
    assert mine["title"] == "BSc Certificate" and mine["metadata"] == {"holder": "A. Student"}
    assert mine["metadata_verified"] is True and mine["file_available"] is True
    assert app_client.get(f"/documents/{h1}/file").status_code == 404
    dl = issuer.get(f"/documents/{h1}/file")
    assert dl.status_code == 200 and dl.content == pdf("lifecycle-v1")
    assert dl.headers["content-type"] == "application/octet-stream" and "attachment" in dl.headers["content-disposition"]

    # 4. one changed byte -> not verified
    tampered = sha(pdf("lifecycle-v1") + b"\n")
    assert app_client.post("/verify", json={"document_hash": tampered}).json()["verdict"] == "not_verified"
    assert app_client.get(f"/verify/{h1.upper().replace('0X', '0x')}").json()["verdict"] == "verified"  # hex case is normalised
    assert app_client.post("/verify", json={"document_hash": "0x1234"}).status_code == 422

    # 5. dashboard list + stats come from the indexed data
    lst = issuer.get("/documents").json()
    assert lst["total"] == 1 and lst["items"][0]["title"] == "BSc Certificate"
    assert issuer.get("/documents", params={"q": "bsc"}).json()["total"] == 1
    assert issuer.get("/documents", params={"q": "nothing-like-this"}).json()["total"] == 0
    assert issuer.get("/documents", params={"status": "revoked"}).json()["total"] == 0
    st = issuer.get("/stats", params={"scope": "mine"}).json()
    assert (st["total_documents"], st["valid_documents"], st["revoked_documents"]) == (1, 1, 0)
    assert st["daily"][-1]["registrations"] == 1

    # 6. revoke on-chain
    chain.revoke(h1, reason=bytes.fromhex(metadata_hash({"reason": "issued in error"})[2:]))
    v = app_client.post("/verify", json={"document_hash": h1}).json()
    assert v["verdict"] == "revoked", "revocation is visible from the chain immediately"
    index()
    reg = app_client.post("/verify", json={"document_hash": h1}).json()["registration"]
    assert reg["revoked_at"] is not None and reg["revoked_by"] == chain.issuer.lower()
    assert issuer.get("/documents", params={"status": "revoked"}).json()["total"] == 1
    st = issuer.get("/stats", params={"scope": "mine"}).json()
    assert (st["valid_documents"], st["revoked_documents"]) == (0, 1)

    # 7. a new version is a new record; v1 stays independently verifiable (and revoked)
    up2 = upload(issuer, pdf("lifecycle-v2"), title="BSc Certificate (corrected)", visibility="public").json()
    register_uploaded(chain, up2, document_id=bytes.fromhex(h1[2:]))
    index()
    h2 = up2["document_hash"]
    v2 = app_client.post("/verify", json={"document_hash": h2}).json()
    assert v2["verdict"] == "verified" and v2["registration"]["version_number"] == 2
    assert v2["registration"]["title"] == "BSc Certificate (corrected)", "public documents show their title"
    assert app_client.post("/verify", json={"document_hash": h1}).json()["verdict"] == "revoked"
    detail = app_client.get(f"/documents/{h2}").json()
    assert [x["version_number"] for x in detail["versions"]] == [2, 1]
    assert [x["status"] for x in detail["versions"]] == ["valid", "revoked"]
    assert detail["versions"][1]["is_latest"] is False and detail["versions"][0]["is_latest"] is True
    assert detail["versions"][1]["title"] is None and detail["versions"][0]["title"] == "BSc Certificate (corrected)"
    assert app_client.get(f"/documents/{h2}/file").content == pdf("lifecycle-v2"), "public file is downloadable by anyone"

    # 8. audit log: public, filterable, paginated
    audit = app_client.get("/audit").json()
    actions = [a["action"] for a in audit["items"]]
    assert {"document.registered", "document.revoked", "issuer.authorized"} <= set(actions)
    assert audit["items"][0]["block_number"] >= audit["items"][-1]["block_number"]
    only = app_client.get("/audit", params={"action": "document.revoked"}).json()
    assert only["total"] == 1 and only["items"][0]["resource_id"] == h1
    page = app_client.get("/audit", params={"limit": 2, "offset": 1}).json()
    assert len(page["items"]) == 2 and page["limit"] == 2 and page["offset"] == 1 and page["total"] == audit["total"]
    assert app_client.get("/audit", params={"action": "bogus"}).status_code == 422
    by_actor = app_client.get("/audit", params={"actor": chain.issuer.upper().replace("0X", "0x")}).json()
    assert by_actor["total"] >= 3


def test_expired_registration_reports_expired(chain, issuer, app_client):
    up = upload(issuer, pdf("expiring")).json()
    register_uploaded(chain, up, expires_at=chain.now() + 3600)
    index()
    assert app_client.post("/verify", json={"document_hash": up["document_hash"]}).json()["verdict"] == "verified"
    chain.increase_time(7200)
    v = app_client.post("/verify", json={"document_hash": up["document_hash"]}).json()
    assert v["verdict"] == "expired" and v["registration"]["expires_at"]
    # The dashboard computes expiry from the database against the wall clock (the chain clock was just advanced
    # artificially), so move the indexed expiry into the real past to exercise that path too.
    from datetime import timedelta
    from app.database.base import utcnow
    from app.database.connection import session_scope
    from app.models import DocumentVersion
    with session_scope() as s:
        s.get(DocumentVersion, (31337, up["document_hash"])).expires_at = utcnow() - timedelta(hours=1)
    # (the module's chain also holds registrations from earlier tests, which are re-indexed here, so assert on this document)
    expired = {d["document_hash"] for d in issuer.get("/documents", params={"status": "expired", "limit": 100}).json()["items"]}
    valid = {d["document_hash"] for d in issuer.get("/documents", params={"status": "valid", "limit": 100}).json()["items"]}
    assert up["document_hash"] in expired and up["document_hash"] not in valid
    assert issuer.get("/stats", params={"scope": "mine"}).json()["expired_documents"] == 1


def test_documents_endpoints_are_scoped_to_the_signed_in_issuer(chain, issuer, app_client):
    up = upload(issuer, pdf("scoped")).json()
    register_uploaded(chain, up)
    index()
    assert app_client.get("/documents").status_code == 401
    with signed_in("issuer2") as other:
        assert other.get("/documents").json()["total"] == 0
        assert other.get(f"/documents/{up['document_hash']}").json()["document"]["title"] is None
        assert other.get(f"/documents/{up['document_hash']}/file").status_code == 404
    with signed_in("outsider") as nobody:
        assert nobody.get("/documents").status_code == 403


def test_an_uploader_other_than_the_onchain_issuer_cannot_attach_metadata(chain, issuer, app_client):
    # issuer2 uploads bytes claiming a title; issuer registers the same fingerprint. Only the registering issuer's upload counts.
    data = pdf("hijack")
    with signed_in("issuer2") as other:
        up_other = upload(other, data, title="FAKE TITLE", visibility="public").json()
    up = upload(issuer, data, title="Real title", visibility="public").json()
    assert up["document_hash"] == up_other["document_hash"]
    register_uploaded(chain, up)
    index()
    assert app_client.get(f"/documents/{up['document_hash']}").json()["document"]["title"] == "Real title"


def test_issuer_removal_blocks_new_uploads_but_keeps_history(chain, db_clean, app_client):
    c = signed_in("issuer2")
    up = upload(c, pdf("removal")).json()
    register_uploaded(chain, up, sender=chain.issuer2)
    chain.send(chain.registry.functions.removeIssuer(chain.issuer2), chain.admin)
    index()
    try:
        assert upload(c, pdf("after-removal")).status_code == 403
        v = app_client.post("/verify", json={"document_hash": up["document_hash"]}).json()
        assert v["verdict"] == "verified" and v["registration"]["issuer"]["currently_authorized"] is False
        assert "no longer authorised" in v["reason"]
        row = next(i for i in app_client.get("/issuers").json()["items"] if i["address"] == chain.issuer2.lower())
        assert row["authorized"] is False and row["document_count"] == 1
        assert app_client.get("/issuers", params={"authorized": "true"}).json()["total"] >= 1
    finally:
        chain.send(chain.registry.functions.authorizeIssuer(chain.issuer2, "Harbor Audit LLP"), chain.admin)
        c.close()


def test_issuer_endpoints(chain, app_client):
    index()
    items = app_client.get("/issuers", params={"q": "northfield"}).json()["items"]
    assert [i["organization_name"] for i in items] == ["Northfield University"]
    one = app_client.get(f"/issuers/{chain.issuer.upper().replace('0X', '0x')}").json()
    assert one["authorized"] is True
    assert app_client.get("/issuers/not-an-address").status_code == 422
    assert app_client.get(f"/issuers/{chain.outsider}").status_code == 404
    assert app_client.post("/issuers", json={}).status_code == 405, "issuer changes are on-chain only"


# ------------------------------------------------------------------------------------------------ batches


def batch_docs(label: str, n: int):
    files = [pdf(f"{label}-{i}") for i in range(n)]
    return files, [sha(f) for f in files]


def test_merkle_batch_registration_and_verification(chain, issuer, app_client):
    files, hashes = batch_docs("batch-a", 5)
    root = merkle_root(hashes)
    body = {"merkle_root": root, "documents": [{"document_hash": h, "filename": f"cert-{i}.pdf", "size_bytes": len(files[i])} for i, h in enumerate(hashes)]}

    # leaves cannot be attached before the root is on-chain
    assert issuer.post("/batches/documents", json=body).status_code == 409
    chain.register_batch(root, 5)
    # tampered fingerprints do not reproduce the root
    bad = {**body, "documents": [*body["documents"][:-1], {**body["documents"][-1], "document_hash": sha(b"intruder")}]}
    assert issuer.post("/batches/documents", json=bad).status_code == 422
    # wrong count / wrong wallet / duplicates / unauthenticated
    assert issuer.post("/batches/documents", json={**body, "documents": body["documents"][:4]}).status_code == 422
    with signed_in("issuer2") as other:
        assert other.post("/batches/documents", json=body).status_code == 403
    dup = {**body, "documents": body["documents"] + body["documents"][:1]}
    assert issuer.post("/batches/documents", json=dup).status_code == 422
    assert app_client.post("/batches/documents", json=body).status_code == 401

    ok = issuer.post("/batches/documents", json=body)
    assert ok.status_code == 201 and ok.json()["stored"] == 5
    index()

    batch_id = ok.json()["batch_id"]
    b = app_client.get(f"/batches/{batch_id}").json()
    assert b["merkle_root"] == root and b["document_count"] == 5 and b["documents_stored"] == 5
    assert b["issuer"]["organization_name"] == "Northfield University"
    assert issuer.get("/batches").json()["items"][0]["batch_id"] == batch_id

    # each member verifies; verdict comes from the contract via the stored proof
    for h in hashes:
        v = app_client.post("/verify", json={"document_hash": h}).json()
        assert v["verdict"] == "verified" and v["registration"]["kind"] == "batch"
        assert v["registration"]["batch_id"] == batch_id and v["registration"]["merkle_root"] == root
    assert app_client.post("/verify", json={"document_hash": sha(b"not in batch")}).json()["verdict"] == "not_verified"

    # proofs are exactly what the contract accepts
    p = app_client.get(f"/proofs/{hashes[2]}").json()["entries"][0]
    assert p["proof"] == proofs_for_all(hashes)[2] and p["leaf_index"] == 2
    res = chain.registry.functions.verifyBatchDocument(batch_id, bytes.fromhex(hashes[2][2:]), [bytes.fromhex(x[2:]) for x in p["proof"]]).call()
    assert res[0] is True
    pf = app_client.get(f"/batches/{batch_id}/proof/{hashes[2]}").json()
    assert pf["merkle_root"] == root and pf["proof"] == p["proof"] and "filename" not in json.dumps(pf)

    # leaf records (filenames) are private to the issuing wallet
    listing = issuer.get(f"/batches/{batch_id}/documents").json()
    assert listing["total"] == 5 and listing["items"][0]["filename"] == "cert-0.pdf"
    assert app_client.get(f"/batches/{batch_id}/documents").status_code == 401
    with signed_in("issuer2") as other:
        assert other.get(f"/batches/{batch_id}/documents").status_code == 403

    # revoke one document, then the whole batch
    chain.send(chain.registry.functions.revokeBatchDocument(batch_id, bytes.fromhex(hashes[1][2:]), [bytes.fromhex(x[2:]) for x in proofs_for_all(hashes)[1]], b"\x00" * 32), chain.issuer)
    assert app_client.post("/verify", json={"document_hash": hashes[1]}).json()["verdict"] == "revoked"
    assert app_client.post("/verify", json={"document_hash": hashes[0]}).json()["verdict"] == "verified"
    chain.send(chain.registry.functions.revokeBatch(batch_id, b"\x00" * 32), chain.issuer)
    assert app_client.post("/verify", json={"document_hash": hashes[0]}).json()["verdict"] == "revoked"
    index()
    listing = issuer.get(f"/batches/{batch_id}/documents").json()["items"]
    assert all(i["revoked_at"] for i in listing)
    assert app_client.get("/audit", params={"action": "batch.document_revoked"}).json()["total"] == 1
    assert app_client.get("/batches/9999").status_code == 404


def test_leaf_records_for_unregistered_roots_never_verify(chain, issuer, app_client):
    """Even if leaf rows exist in the database, the contract decides: a root nobody registered proves nothing."""
    from app.database.connection import session_scope
    from app.models import BatchDocument
    from app.database.base import utcnow

    files, hashes = batch_docs("ghost", 3)
    root = merkle_root(hashes)
    with session_scope() as s:
        for i, h in enumerate(hashes):
            s.add(BatchDocument(chain_id=31337, merkle_root=root, document_hash=h, leaf_index=i, filename="x", size_bytes=1,
                                proof=proofs_for_all(hashes)[i], created_at=utcnow()))
    assert app_client.post("/verify", json={"document_hash": hashes[0]}).json()["verdict"] == "not_verified"
    assert app_client.get(f"/proofs/{hashes[0]}").json()["entries"] == []


def test_transaction_status_endpoint(chain, issuer, app_client):
    up = upload(issuer, pdf("tx-status")).json()
    receipt = register_uploaded(chain, up)
    tx = receipt["transactionHash"].to_0x_hex()
    r = app_client.get(f"/transactions/{tx}").json()
    assert r["status"] == "success" and r["indexed"] is False
    index()
    r = app_client.get(f"/transactions/{tx}").json()
    assert r["indexed"] is True and r["indexed_events"] == ["DocumentRegistered"]
    assert app_client.get("/transactions/0x" + "00" * 32).json()["status"] == "not_found"
    assert app_client.get("/transactions/xyz").status_code == 422


def test_global_stats_are_public_and_health_reports_the_indexer(chain, app_client):
    index()
    s = app_client.get("/stats").json()
    assert s["scope"] == "global" and s["authorized_issuers"] >= 2 and len(s["daily"]) == 30
    assert app_client.get("/stats", params={"scope": "mine"}).status_code == 401
    h = app_client.get("/health").json()
    assert h["status"] == "ok" and h["indexer"]["last_block"] >= 0 and h["registry_configured"] is True
