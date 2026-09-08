import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { runDemo } = await import('../workflows/demo/main.mjs');

const dummyPy = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../workflows/demo/dummy.py',
);

function createMockFleetApi() {
  const commandCalls = [];
  const promptCalls = [];

  return {
    commandCalls,
    promptCalls,
    async fleetStatus() {
      return { content: [{ type: 'text', text: 'fleet server: running' }] };
    },
    async executeCommand(options) {
      commandCalls.push(options);
      return {
        content: [{ type: 'text', text: 'hello-from-python' }],
        structuredContent: { stdout: 'hello-from-python', exitCode: 0 },
      };
    },
    async executePrompt(options) {
      promptCalls.push(options);
      return {
        content: [{ type: 'text', text: 'pong' }],
        structuredContent: { response: 'pong' },
      };
    },
  };
}

test('runDemo runs python command, transform, and agent smoke test', async () => {
  const fleetApi = createMockFleetApi();

  const result = await runDemo({ fleetApi });
  assert.match(String(result.command?.output ?? result.command), /hello-from-python/);
  assert.deepEqual(result.transform, { ok: true, source: 'transform' });
  assert.match(String(result.agent?.response ?? result.agent), /\bpong\b/i);

  assert.equal(fleetApi.commandCalls.length, 1);
  const cmd = fleetApi.commandCalls[0].command;
  assert.match(cmd, /python3/);
  assert.ok(cmd.includes(dummyPy), `expected dummy.py path, got: ${cmd}`);

  assert.ok(fleetApi.promptCalls.length >= 1, 'executePrompt should be invoked');
});

test('the workflow does not register members', async () => {
  const fleetApi = createMockFleetApi();
  // fleetApi has no registerMember — if demo.js tried to call it, it would throw.
  await runDemo({ fleetApi });
});

test('an aborted signal prevents the agent phase from spending tokens', async () => {
  const fleetApi = createMockFleetApi();
  const controller = new AbortController();
  controller.abort();

  const result = await runDemo({ fleetApi, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(fleetApi.promptCalls.length, 0, 'executePrompt must not run after abort');
});

test('aborting on the final progress notification prevents the agent call', async () => {
  const fleetApi = createMockFleetApi();
  const controller = new AbortController();

  const result = await runDemo({
    fleetApi,
    signal: controller.signal,
    reportPhase(message) {
      if (message === 'dispatching the agent prompt') controller.abort();
    },
  });

  assert.equal(result.cancelled, true);
  assert.equal(fleetApi.promptCalls.length, 0, 'executePrompt must not run after final progress');
});

test('reportPhase receives one message per phase and is optional', async () => {
  const phases = [];
  await runDemo({
    fleetApi: createMockFleetApi(),
    reportPhase: (message) => phases.push(message),
  });
  assert.ok(phases.length >= 4, `expected a message per phase, got ${phases.length}`);

  // Omitting reportPhase must not throw.
  await runDemo({ fleetApi: createMockFleetApi() });
});
