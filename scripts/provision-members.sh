#!/bin/sh
set -eu

# OBSOLETE. Node MemberManager (pool/member-manager.mjs) owns registration and
# OAuth at process startup. DEMO-DOER / DEMO-REVIEWER are retired. This script
# is not on the Docker or MCP startup path; kept only so older docs/scripts
# that still mention it do not 404.
#
# Same commands as a host provision. Docker entrypoint runs this after `apra-fleet start`
# so DEMO-DOER / DEMO-REVIEWER exist in the shared data dir. Kit launchers spawn
# stdio Fleet, which sees that same data dir.
# Token comes from CLAUDE_CODE_OAUTH_TOKEN and goes straight into Fleet's credential store.

REGISTRY="${HOME}/.apra-fleet/data/registry.json"

ensure_member() {
  name="$1"
  work_path="$2"
  if [ -f "$REGISTRY" ] && grep -q "\"$name\"" "$REGISTRY"; then
    echo "✓ $name already registered; skipping."
    return 0
  fi
  apra-fleet register-member --type local --llm claude \
    --name "$name" \
    --path "$work_path"
}

ensure_member DEMO-DOER "$(pwd)/workdir/DEMO-DOER"
ensure_member DEMO-REVIEWER "$(pwd)/workdir/DEMO-REVIEWER"

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  apra-fleet auth --oauth --member DEMO-DOER "$CLAUDE_CODE_OAUTH_TOKEN"
else
  echo "CLAUDE_CODE_OAUTH_TOKEN is unset; skip auth. agent() calls will fail." >&2
fi
