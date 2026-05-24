#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

cd "$ROOT_DIR"

echo "Starting Postgres + pgvector..."
docker compose up -d postgres >/dev/null

echo "Waiting for Postgres..."
until docker exec expense_guard_postgres pg_isready -U expense_guard -d expense_guard >/dev/null 2>&1; do
  sleep 1
done

echo "Preparing Python backend..."
if [ ! -d "$BACKEND_DIR/.venv" ]; then
  python3 -m venv "$BACKEND_DIR/.venv"
fi
"$BACKEND_DIR/.venv/bin/pip" install -q -r "$BACKEND_DIR/requirements.txt"

echo "Installing frontend dependencies..."
if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  (cd "$FRONTEND_DIR" && npm install --silent)
fi

echo "Starting backend on http://127.0.0.1:8001 ..."
(cd "$BACKEND_DIR" && "$BACKEND_DIR/.venv/bin/uvicorn" app.main:app --host 127.0.0.1 --port 8001) &
BACKEND_PID=$!

cleanup() {
  kill "$BACKEND_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

until curl -fsS http://127.0.0.1:8001/api/health >/dev/null 2>&1; do
  sleep 1
done

echo "Seeding Postgres and the remote Synapsor database on synapsor.ai..."
curl -fsS -X POST http://127.0.0.1:8001/api/reset >/dev/null

echo "Starting UI on http://127.0.0.1:5174 ..."
(cd "$FRONTEND_DIR" && npm run dev)
