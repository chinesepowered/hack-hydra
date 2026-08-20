#!/usr/bin/env bash
# Boots a single-node HydraDB alongside the Blast Radius console in one
# container — sized for Render's free tier (512MB). HydraDB listens only on
# loopback; the console is the only exposed surface ($PORT).
set -euo pipefail

export CLOUD_PROVIDER=local
export LOCAL_PATH=/data/store
export GRAPH_NAMESPACE=default
export GRAPH_ID=default
export GRAPH_CELL_ID=cell-0
export GRAPH_CELLS=cell-0
export GRAPH_NODE_ID=node-0
export GRAPH_BOLT_NODE_ADDRESSES=node-0=127.0.0.1:7687
export GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687
export GRAPH_DATA_CACHE_DIR=/data/cache
export GRAPH_AUTH_TOKEN_FILE=/data/auth-token
export GRAPH_ALLOW_PLAINTEXT=true
# graph-node's async query futures exceed the default thread stack (see
# hydradb README) — without this the node aborts on the first query.
export RUST_MIN_STACK=33554432

mkdir -p /data/store /data/cache
if [ ! -f /data/auth-token ]; then
  printf '%s\n' "${HYDRA_TOKEN:-local-development-token-32-bytes}" > /data/auth-token
fi

echo "[start] launching HydraDB graph-node (loopback only)..."
/usr/local/bin/graph-node &
HYDRA_PID=$!
trap 'kill $HYDRA_PID 2>/dev/null || true' EXIT

echo "[start] launching Blast Radius console on :${PORT:-3000}..."
exec node /app/server/index.js
