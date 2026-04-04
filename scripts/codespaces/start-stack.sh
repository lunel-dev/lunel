#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$REPO_ROOT/.codespaces"
LOG_DIR="$STATE_DIR/logs"
PID_DIR="$STATE_DIR/pids"
ENV_FILE="$STATE_DIR/runtime.env"
BUN_BIN="$HOME/.bun/bin"
LOCAL_BIN="$HOME/.local/bin"
export PATH="$BUN_BIN:$LOCAL_BIN:$PATH"

mkdir -p "$LOG_DIR" "$PID_DIR"

if [[ -z "${CODESPACE_NAME:-}" || -z "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]]; then
  echo "This script must run inside GitHub Codespaces."
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is missing. Rebuild the codespace or run: bash .devcontainer/post-create.sh"
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "codex is missing. Rebuild the codespace or run: bash .devcontainer/post-create.sh"
  exit 1
fi

if [[ ! -f "$REPO_ROOT/cli/dist/index.js" ]]; then
  echo "CLI build output is missing. Building it now..."
  (cd "$REPO_ROOT/cli" && npm install && npm run build)
fi

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  PROXY_PASSWORD="$(openssl rand -hex 24)"
  MANAGER_ADMIN_PASSWORD="$(openssl rand -hex 24)"
  cat > "$ENV_FILE" <<EOF
PROXY_PASSWORD=$PROXY_PASSWORD
MANAGER_ADMIN_PASSWORD=$MANAGER_ADMIN_PASSWORD
EOF
fi

set -a
source "$ENV_FILE"
set +a

MANAGER_PORT=8899
GATEWAY_PORT=3000
MANAGER_PUBLIC_URL="https://${CODESPACE_NAME}-${MANAGER_PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
GATEWAY_PUBLIC_URL="https://${CODESPACE_NAME}-${GATEWAY_PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"

stop_if_running() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
}

wait_for_local_health() {
  local url="$1"
  local label="$2"
  for _ in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "$label did not become healthy in time."
  exit 1
}

stop_if_running "$PID_DIR/manager.pid"
stop_if_running "$PID_DIR/proxy.pid"

echo "Starting manager on port $MANAGER_PORT..."
(
  cd "$REPO_ROOT/manager"
  PORT="$MANAGER_PORT" MANAGER_ADMIN_PASSWORD="$MANAGER_ADMIN_PASSWORD" bun run src/index.ts
) >"$LOG_DIR/manager.log" 2>&1 &
echo $! > "$PID_DIR/manager.pid"

wait_for_local_health "http://127.0.0.1:${MANAGER_PORT}/health" "Manager"

echo "Starting gateway on port $GATEWAY_PORT..."
(
  cd "$REPO_ROOT/proxy"
  PORT="$GATEWAY_PORT" \
  MANAGER_URL="$MANAGER_PUBLIC_URL" \
  PUBLIC_URL="$GATEWAY_PUBLIC_URL" \
  GATEWAY_URL="$GATEWAY_PUBLIC_URL" \
  PROXY_PASSWORD="$PROXY_PASSWORD" \
  bun run src/index.ts
) >"$LOG_DIR/proxy.log" 2>&1 &
echo $! > "$PID_DIR/proxy.pid"

wait_for_local_health "http://127.0.0.1:${GATEWAY_PORT}/health" "Gateway"

cat <<EOF

Codespace runtime started.

Manager URL for the iPhone app:
  $MANAGER_PUBLIC_URL

Gateway URL for the iPhone app:
  $GATEWAY_PUBLIC_URL

Important:
  1. Open the PORTS tab in GitHub Codespaces.
  2. Set port 8899 to Public.
  3. Set port 3000 to Public.
  4. Keep this terminal open.

Waiting for the gateway to see the manager through the public Codespaces URL...
EOF

for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${GATEWAY_PORT}/health" | grep -q '"managerReachable":true'; then
    break
  fi
  sleep 2
done

if ! curl -fsS "http://127.0.0.1:${GATEWAY_PORT}/health" | grep -q '"managerReachable":true'; then
  echo
  echo "The gateway still cannot reach the manager through the public Codespaces URL."
  echo "Make sure both forwarded ports are Public, then run this script again."
  exit 1
fi

cat <<EOF

Gateway is connected to the manager.

If Codex is not authenticated in this codespace yet:
  codex

If you want to verify OpenCode is installed:
  opencode --help

Starting the mobile bridge CLI now...
EOF

cd "$REPO_ROOT/cli"
MANAGER_URL="$MANAGER_PUBLIC_URL" GATEWAY_URL="$GATEWAY_PUBLIC_URL" node dist/index.js
