# PassagePort development commands. Run `make help` for the list.
#
# Recipes are single `cd dir && command` lines without shell-specific syntax, so they work with
# GNU Make under sh (Linux, macOS, Git Bash) and under cmd.exe. On Windows without Make, run
# the commands shown here directly; `scripts/dev.ps1` replaces `make dev`.

.DEFAULT_GOAL := help

.PHONY: help install dev backend frontend test test-backend test-frontend test-mcp e2e \
        lint format typecheck eval docker-build docker-up docker-down clean

# The backend reads `.env` from the repository root when it exists (same file docker compose uses).
ENV_FILE := $(if $(wildcard .env),--env-file ../.env,)

# Datasets for `make eval`, e.g. `make eval EVAL_DATASETS=mini`.
EVAL_DATASETS ?= mini scifact

ifeq ($(OS),Windows_NT)
DEV_SCRIPT := powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1
else
DEV_SCRIPT := bash scripts/dev.sh
endif

help:
	@echo "PassagePort"
	@echo ""
	@echo "  make install        Install backend (uv), frontend and MCP server dependencies"
	@echo "  make dev            Backend with reload on 127.0.0.1:8000 + Vite on 127.0.0.1:5173"
	@echo "  make backend        Backend only (reload, 127.0.0.1:8000)"
	@echo "  make frontend       Vite dev server only (proxies /api to 127.0.0.1:8000)"
	@echo ""
	@echo "  make test           Backend, frontend and MCP server unit tests"
	@echo "  make test-backend   pytest (hashing embedder, no model download)"
	@echo "  make test-frontend  vitest"
	@echo "  make test-mcp       MCP server tests"
	@echo "  make e2e            Build the frontend and run the Playwright suite"
	@echo "  make lint           ruff check + ruff format --check + eslint"
	@echo "  make format         Apply ruff formatting and safe fixes"
	@echo "  make typecheck      mypy + tsc (frontend, MCP server)"
	@echo "  make eval           Run the retrieval evaluation (downloads models and datasets)"
	@echo ""
	@echo "  make docker-build   Build the image (models preloaded)"
	@echo "  make docker-up      Start with docker compose on http://localhost:8000"
	@echo "  make docker-down    Stop the compose stack (volumes are kept)"
	@echo "  make clean          Remove build output and tool caches (never data or .env)"

install:
	cd backend && uv sync --extra dev --extra postgres
	cd frontend && npm ci
	cd mcp-server && npm ci

dev:
	$(DEV_SCRIPT)

backend:
	cd backend && uv run uvicorn passageport.main:app --reload --reload-dir passageport --host 127.0.0.1 --port 8000 $(ENV_FILE)

frontend:
	cd frontend && npm run dev

test: test-backend test-frontend test-mcp

# Tests must never download models, whatever the developer's environment or .env says.
test-backend: export PP_EMBEDDING_BACKEND := hashing
test-backend: export PP_RERANKER_BACKEND := none
test-backend:
	cd backend && uv run pytest

test-frontend:
	cd frontend && npm test -- --run

test-mcp:
	cd mcp-server && npm test

e2e:
	cd frontend && npm run build
	cd e2e && npm ci
	cd e2e && npx playwright install chromium firefox
	cd e2e && npx playwright test

lint:
	cd backend && uv run ruff check .
	cd backend && uv run ruff format --check .
	cd frontend && npm run lint

format:
	cd backend && uv run ruff format .
	cd backend && uv run ruff check --fix .

typecheck:
	cd backend && uv run mypy passageport
	cd frontend && npm run typecheck
	cd mcp-server && npm run typecheck

# Downloads models and datasets (cached in eval/.cache); not part of CI. Writes the raw numbers to
# eval/results/ and regenerates the report that Search Lab displays. Both files are committed.
eval:
	cd backend && uv run python -m passageport.evaluation.run evaluate --datasets $(EVAL_DATASETS) --out ../eval/results/default.json
	cd backend && uv run python -m passageport.evaluation.run report --inputs ../eval/results/default.json --out passageport/evaluation/report.json

docker-build:
	docker build -t passageport:local .

docker-up:
	docker compose up --build --detach

docker-down:
	docker compose down

clean:
	node scripts/clean.mjs
