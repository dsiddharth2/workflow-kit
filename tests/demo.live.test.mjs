import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Spawns Fleet over stdio via runDemo() with no injected fleetApi.
// Needs the apra-fleet binary and CLAUDE_CODE_OAUTH_TOKEN. No `apra-fleet start`.

const { runDemo } = await import('../workflows/demo/main.mjs');

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value.output === 'string') return value.output;
  if (typeof value.response === 'string') return value.response;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

test(
  'live runDemo runs python command and agent on DEMO-DOER',
  { timeout: 180_000 },
  async () => {
    const result = await runDemo();

    assert.equal(typeof result, 'object', 'runDemo() should return the dummy phase results');
    assert.match(asText(result.command), /hello-from-python/);
    assert.deepEqual(result.transform, { ok: true, source: 'transform' });
    assert.match(asText(result.agent), /\bpong\b/i);
  },
);
