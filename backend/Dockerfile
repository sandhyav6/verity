# Backend image: API, indexer and data worker share this image (different commands in docker-compose.yml).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv
RUN useradd --create-home --uid 10001 app \
    && mkdir -p /data/storage && chown app:app /data/storage

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY alembic.ini ./
COPY migrations ./migrations
COPY app ./app
COPY docker-entrypoint.sh ./
# tolerate CRLF checkouts on Windows
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh && chown -R app:app /srv

USER app
EXPOSE 8000

# Healthchecks are defined per service in docker-compose.yml (only the API listens on a port).
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
