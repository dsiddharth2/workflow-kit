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

# Fleet skips provisionLlmAuth for local members — it assumes the host's
# login session is available. In Docker there is no host session, so we wrap
# the claude binary to inject the token only when claude is actually called.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  real_claude="$(command -v claude)"
  if [ -n "$real_claude" ] && [ ! -f "${real_claude}-real" ]; then
    mv "$real_claude" "${real_claude}-real"
    cat > "$real_claude" <<WRAPPER
#!/bin/sh
export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN}"
exec "${real_claude}-real" "\$@"
WRAPPER
    chmod +x "$real_claude"
    echo "[entrypoint] claude wrapper installed for LLM auth"
  fi
fi

# Members, folders, and OAuth are provisioned by Node at startup
# (pool/member-manager.mjs) from WORKER_POOL_SIZE and CLAUDE_CODE_OAUTH_TOKEN.
echo "[entrypoint] exec: $*"
exec "$@"
