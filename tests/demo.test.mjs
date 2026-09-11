import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockFleetApi } from './helpers/mock-fleet.mjs';

const { runDemo } = await import('../workflows/demo/main.mjs');

const dummyPy = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../workflows/demo/dummy.py',
);

const workspace = {
  workerId: 'pool-1',
  doer: { name: 'WORKER-1-DOER', folder: '/tmp/worker-1/doer' },
  reviewer: { name: 'WORKER-1-REVIEWER', folder: '/tmp/worker-1/reviewer' },
};

test('runDemo runs python command, transform, and agent smoke test', async () => {
  const fleetApi = createMockFleetApi();

  const result = await runDemo({ fleetApi, workspace });
  assert.match(String(result.command?.output ?? result.command), /hello-from-python/);
  assert.deepEqual(result.transform, { ok: true, source: 'transform' });
  assert.match(String(result.agent?.response ?? result.agent), /\bpong\b/i);

  assert.equal(fleetApi.commandCalls.length, 1);
  const cmd = fleetApi.commandCalls[0].command;
  assert.match(cmd, /python3/);
  assert.ok(cmd.includes(dummyPy), `expected dummy.py path, got: ${cmd}`);

  assert.ok(fleetApi.promptCalls.length >= 1, 'executePrompt should be invoked');
  assert.equal(fleetApi.commandCalls[0].member_name, 'doer', 'bodies address roles, not members');
  assert.equal(fleetApi.promptCalls[0].member_name, 'doer');
});

test('the workflow never registers members', async () => {
  const fleetApi = createMockFleetApi();
  await runDemo({ fleetApi, workspace });
  assert.deepEqual(fleetApi.registerCalls, []);
});

test('an aborted signal prevents the agent phase from spending tokens', async () => {
  const fleetApi = createMockFleetApi();
  const controller = new AbortController();
  controller.abort();

  const result = await runDemo({ fleetApi, workspace, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(fleetApi.promptCalls.length, 0, 'executePrompt must not run after abort');
});

test('aborting on the final progress notification prevents the agent call', async () => {
  const fleetApi = createMockFleetApi();
  const controller = new AbortController();

  const result = await runDemo({
    fleetApi,
    workspace,
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
    workspace,
    reportPhase: (message) => phases.push(message),
  });
  assert.ok(phases.length >= 4, `expected a message per phase, got ${phases.length}`);

  // Omitting reportPhase must not throw.
  await runDemo({ fleetApi: createMockFleetApi(), workspace });
});
