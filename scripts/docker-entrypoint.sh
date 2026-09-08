#!/bin/sh
set -eu

echo "[entrypoint] starting..."

# Ensure project deps exist — the named volume starts empty on first run.
if [ ! -d /workspace/node_modules/@modelcontextprotocol ]; then
  echo "[entrypoint] installing project dependencies..."
  npm ci --omit=dev
fi

# Symlink @apralabs packages so workflows can resolve them.
echo "[entrypoint] linking @apralabs packages..."
node -e "import('./workflows/demo/ensure-apralabs.mjs').then(m => m.ensureApralabs())" 2>/dev/null || true

skip_provision=0
for arg in "$@"; do
  if [ "$arg" = "--test" ]; then
    skip_provision=1
    break
  fi
done

if [ "$skip_provision" -eq 0 ]; then
  mkdir -p /workspace/workdir/DEMO-DOER /workspace/workdir/DEMO-REVIEWER

  # HTTP Fleet is started only so provision-members.sh can register into the
  # shared data dir. The MCP / workflow process spawns its own stdio child.
  echo "[entrypoint] starting Fleet server..."
  apra-fleet start
  n=0
  while [ "$n" -lt 120 ]; do
    if apra-fleet status >/dev/null 2>&1; then
      echo "[entrypoint] Fleet server is ready."
      break
    fi
    n=$((n + 1))
    sleep 0.5
  done
  if ! apra-fleet status >/dev/null 2>&1; then
    echo "[entrypoint] Fleet server did not become ready within 60s after 'apra-fleet start'." >&2
    exit 1
  fi

  echo "[entrypoint] provisioning members..."
  /usr/local/bin/provision-members.sh
fi

echo "[entrypoint] exec: $*"
exec "$@"
