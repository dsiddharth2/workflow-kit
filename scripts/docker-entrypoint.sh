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

# Create work folders so they exist before spawnFleet registers members.
mkdir -p /workspace/workdir/DEMO-DOER /workspace/workdir/DEMO-REVIEWER

# Register members and provision OAuth before the Fleet child process starts,
# so it inherits working auth from the data directory on disk.
echo "[entrypoint] registering Fleet members..."
apra-fleet register-member --type local --llm claude \
  --name DEMO-DOER --path /workspace/workdir/DEMO-DOER 2>/dev/null || true
apra-fleet register-member --type local --llm claude \
  --name DEMO-REVIEWER --path /workspace/workdir/DEMO-REVIEWER 2>/dev/null || true

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "[entrypoint] provisioning OAuth for DEMO-DOER..."
  apra-fleet auth --oauth --member DEMO-DOER "$CLAUDE_CODE_OAUTH_TOKEN" || true
fi

echo "[entrypoint] exec: $*"
exec "$@"
