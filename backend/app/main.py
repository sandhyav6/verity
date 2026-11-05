import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from sqlalchemy import text

from app.api.deps import limiter
from app.api.routes import audit, auth, batches, documents, issuers, meta, stats, transactions, verify
from app.blockchain.client import ChainUnavailable
from app.blockchain.registry import RegistryNotConfigured
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.database.connection import new_session
from app.models import IndexerCheckpoint

log = logging.getLogger(__name__)
DESCRIPTION = (
    "Verity document registry API. Document contents stay off-chain; only SHA-256 fingerprints and issuance "
    "records live on-chain. Verification verdicts are read from the VerityRegistry contract; this database is an "
    "indexed read model of chain events and is never the source of truth."
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    configure_logging()
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Verity API", description=DESCRIPTION, version="1.0.0", lifespan=lifespan)
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.add_middleware(SlowAPIMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Authorization"],
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response

    @app.exception_handler(ChainUnavailable)
    async def chain_down(_: Request, exc: ChainUnavailable):
        return JSONResponse(status_code=503, content={"detail": f"blockchain node unavailable: {exc}"})

    @app.exception_handler(RegistryNotConfigured)
    async def registry_missing(_: Request, exc: RegistryNotConfigured):
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception):
        log.exception("unhandled error")  # details go to the log, never to the client
        return JSONResponse(status_code=500, content={"detail": "internal server error"})

    for module in (meta, auth, documents, verify, issuers, batches, audit, stats, transactions):
        app.include_router(module.router)

    @app.get("/health", tags=["meta"])
    def health() -> dict:
        db = new_session()
        try:
            db.execute(text("select 1"))
            cp = db.get(IndexerCheckpoint, settings.chain_id)
            indexer = {"last_block": cp.last_block, "updated_at": cp.updated_at} if cp else None
            return {"status": "ok", "database": "ok", "indexer": indexer, "registry_configured": bool(settings.registry_address)}
        finally:
            db.close()

    return app


app = create_app()
