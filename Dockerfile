# syntax=docker/dockerfile:1

# PassagePort: one image that serves the API and the built web client from a single origin.
#
#   docker build -t passageport .                       # models baked in, starts offline
#   docker build --build-arg PRELOAD_MODELS=0 -t ...    # smaller image, models download on first use

# ---------------------------------------------------------------------------- frontend build
FROM node:24-slim AS frontend

WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------------------- backend dependencies
FROM python:3.15-slim AS backend-deps

COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv

# The virtualenv is created at the path it will have in the runtime image and uses the base
# image's interpreter, so it can be copied between stages as-is.
ENV UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /src/backend
# Only third-party dependencies are installed here (exactly as locked); the application package
# is copied into the runtime stage as source, so editing code does not invalidate this layer.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=backend/pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=backend/uv.lock,target=uv.lock \
    uv sync --frozen --no-dev --extra postgres --no-install-project

# ---------------------------------------------------------------------------- runtime
FROM python:3.15-slim AS runtime

ARG PRELOAD_MODELS=1

LABEL org.opencontainers.image.title="PassagePort" \
      org.opencontainers.image.description="Document workspace: hybrid search with page-accurate citations, evidence-backed answers and document comparison." \
      org.opencontainers.image.licenses="MIT"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/app/.venv/bin:$PATH \
    PYTHONPATH=/app/backend \
    PORT=8000 \
    PP_DATA_DIR=/data \
    PP_STATIC_DIR=/app/static \
    PP_MODEL_CACHE_DIR=/models

# Fixed numeric ids so bind mounts and Kubernetes `runAsUser` can match them.
RUN groupadd --gid 10001 passageport \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /app --shell /usr/sbin/nologin passageport \
    && mkdir -p /app /data /models \
    && chown passageport:passageport /app /data /models

WORKDIR /app
COPY --from=backend-deps /app/.venv /app/.venv
COPY backend/passageport /app/backend/passageport
COPY --from=frontend /src/frontend/dist /app/static
COPY scripts/preload_models.py /app/scripts/preload_models.py
# The MIT license requires the copyright and permission notice to accompany every copy.
COPY LICENSE NOTICE.md /app/

USER 10001:10001

# Bakes the default fastembed models (BAAI/bge-small-en-v1.5, Xenova/ms-marco-MiniLM-L-6-v2)
# into /models and proves they load with the Hugging Face hub offline. /models stays writable
# so a different PP_EMBEDDING_MODEL can still be downloaded at runtime.
RUN if [ "$PRELOAD_MODELS" = "1" ]; then python /app/scripts/preload_models.py; fi

# SQLite database and uploaded files. Mount a volume here or everything is lost with the container.
VOLUME ["/data"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8000') + '/api/health', timeout=4)"]

# One worker process, on purpose: the retrieval index cache, the rate limiter and the indexing
# worker thread live in process memory. More workers would each load the models and rebuild every
# index (multiplying RAM) while adding nothing for correctness. Scale by running more containers
# against PostgreSQL instead; the job queue is lease-based and safe across processes.
#
# --proxy-headers only trusts X-Forwarded-* from the addresses in FORWARDED_ALLOW_IPS
# (default 127.0.0.1); set it to your reverse proxy's address when you deploy behind one.
CMD ["sh", "-c", "exec uvicorn passageport.main:app --host 0.0.0.0 --port \"${PORT:-8000}\" --workers 1 --proxy-headers"]
