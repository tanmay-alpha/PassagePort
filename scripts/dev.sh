#!/usr/bin/env bash
#
# Start the backend (reload, http://127.0.0.1:8000) and the Vite dev server
# (http://127.0.0.1:5173, proxies /api to the backend). Ctrl+C stops both.
#
# Usage: scripts/dev.sh            Windows: scripts/dev.ps1
#
# Both servers bind to the loopback interface only: the default PP_AUTH_MODE=local has no login.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${BACKEND_PORT:-8000}"

for tool in uv node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: '$tool' is not installed or not on PATH" >&2
    exit 1
  fi
done

if [[ ! -d "$ROOT/backend/.venv" ]]; then
  echo "[dev] installing backend dependencies"
  (cd "$ROOT/backend" && uv sync --extra dev)
fi
if [[ ! -d "$ROOT/frontend/node_modules" ]]; then
  echo "[dev] installing frontend dependencies"
  (cd "$ROOT/frontend" && npm ci)
fi

backend_args=(passageport.main:app --reload --reload-dir passageport --host 127.0.0.1 --port "$BACKEND_PORT")
if [[ -f "$ROOT/.env" ]]; then
  backend_args+=(--env-file "$ROOT/.env")
fi

pids=()

cleanup() {
  trap - EXIT INT TERM
  echo
  echo "[dev] stopping"
  for pid in "${pids[@]}"; do
    # Children first (uvicorn's reload worker, the node process behind npm), then the parent.
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[dev] backend   http://127.0.0.1:$BACKEND_PORT  (API docs: /api/docs)"
echo "[dev] frontend  http://127.0.0.1:5173"
echo "[dev] Ctrl+C stops both"

(cd "$ROOT/backend" && exec uv run uvicorn "${backend_args[@]}") &
pids+=("$!")
(cd "$ROOT/frontend" && exec npm run dev -- --host 127.0.0.1) &
pids+=("$!")

# Exit as soon as either server exits (portable replacement for `wait -n`, which the bash 3.2
# shipped with macOS does not have).
while true; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[dev] a server exited; shutting down the other one" >&2
      exit 1
    fi
  done
  sleep 1
done
