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

# Members, folders, and OAuth are provisioned by Node at startup
# (pool/member-manager.mjs) from WORKER_POOL_SIZE and CLAUDE_CODE_OAUTH_TOKEN.
echo "[entrypoint] exec: $*"
exec "$@"
