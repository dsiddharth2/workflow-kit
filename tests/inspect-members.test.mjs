import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi as createSharedMock } from './helpers/mock-fleet.mjs';

const { runInspectMembers } = await import('../workflows/inspect-members/main.mjs');

const workspace = {
  workerId: 'pool-1',
  doer: { name: 'WORKER-1-DOER', folder: '/tmp/worker-1/doer' },
  reviewer: { name: 'WORKER-1-REVIEWER', folder: '/tmp/worker-1/reviewer' },
};

function createMockFleetApi({ present = ['WORKER-1-DOER', 'WORKER-1-REVIEWER'], commandFails = false } = {}) {
  const api = createSharedMock({
    members: present,
    commandPayload: JSON.stringify({ root: '/tmp/x', exists: true, fileCount: 2, totalBytes: 10 }),
  });
  if (commandFails) {
    api.executeCommand = async (options) => {
      api.commandCalls.push(options);
      return {
        content: [{ type: 'text', text: 'python3: command not found' }],
        structuredContent: { stdout: '', exitCode: 127 },
      };
    };
  }
  return api;
}

test('inspects both roles of the leased worker by default', async () => {
  const fleetApi = createMockFleetApi();
  const result = await runInspectMembers({ fleetApi, workspace });

  assert.equal(typeof result.generatedAt, 'string');
  assert.equal(result.workerId, 'pool-1');
  assert.deepEqual(result.members.map((entry) => entry.role), ['doer', 'reviewer']);
  assert.deepEqual(result.members.map((entry) => entry.name), ['WORKER-1-DOER', 'WORKER-1-REVIEWER']);
  assert.equal(result.members[0].present, true);
  assert.equal(result.members[0].report.fileCount, 2);
  assert.equal(fleetApi.commandCalls.length, 2);
  assert.match(fleetApi.commandCalls[0].command, /inspect\.py/);
  assert.match(fleetApi.commandCalls[0].command, /--root "\/tmp\/worker-1\/doer"/);
  assert.equal(fleetApi.commandCalls[0].member_name, 'doer');
  assert.equal(fleetApi.commandCalls[0].failSoft, true);
});

test('honors an explicit roles list', async () => {
  const fleetApi = createMockFleetApi();
  const result = await runInspectMembers({ fleetApi, workspace, roles: ['reviewer'] });
  assert.deepEqual(result.members.map((entry) => entry.name), ['WORKER-1-REVIEWER']);
  assert.equal(fleetApi.commandCalls.length, 1);
  assert.equal(fleetApi.commandCalls[0].member_name, 'reviewer');
});

test('rejects unknown roles before command dispatch', async () => {
  const fleetApi = createMockFleetApi();
  await assert.rejects(
    () => runInspectMembers({ fleetApi, workspace, roles: ['OTHER"; touch /tmp/x; #'] }),
    /unsupported role/i,
  );
  assert.equal(fleetApi.commandCalls.length, 0);
});

test('requires a workspace', async () => {
  await assert.rejects(() => runInspectMembers({ fleetApi: createMockFleetApi() }), /workspace/);
});

test('reports an unregistered member as absent without running a command', async () => {
  const fleetApi = createMockFleetApi({ present: ['WORKER-1-DOER'] });
  const result = await runInspectMembers({ fleetApi, workspace });
  const reviewer = result.members.find((entry) => entry.role === 'reviewer');
  assert.equal(reviewer.present, false);
  assert.equal(reviewer.report, undefined);
  assert.equal(fleetApi.commandCalls.length, 1, 'absent members must not be probed');
});

test('presence matching is token-exact', async () => {
  const fleetApi = createMockFleetApi({ present: ['WORKER-11-DOER', 'WORKER-11-REVIEWER'] });
  const result = await runInspectMembers({ fleetApi, workspace });
  assert.deepEqual(result.members.map((entry) => entry.present), [false, false]);
  assert.equal(fleetApi.commandCalls.length, 0);
});

test('includeFiles adds the --files flag', async () => {
  const fleetApi = createMockFleetApi();
  await runInspectMembers({ fleetApi, workspace, includeFiles: true });
  assert.match(fleetApi.commandCalls[0].command, /--files/);

  const plain = createMockFleetApi();
  await runInspectMembers({ fleetApi: plain, workspace });
  assert.doesNotMatch(plain.commandCalls[0].command, /--files/);
});

test('a failSoft command failure becomes a per-member error, not a throw', async () => {
  const fleetApi = createMockFleetApi({ commandFails: true });
  const result = await runInspectMembers({ fleetApi, workspace });
  assert.equal(result.members[0].present, true);
  assert.equal(result.members[0].report, undefined);
  assert.match(result.members[0].error, /command not found/);
});

test('an aborted signal stops before the next role', async () => {
  const fleetApi = createMockFleetApi();
  const controller = new AbortController();
  controller.abort();
  const result = await runInspectMembers({ fleetApi, workspace, signal: controller.signal });
  assert.equal(fleetApi.commandCalls.length, 0);
  assert.deepEqual(result.members, []);
});

test('reportPhase is called and is optional', async () => {
  const phases = [];
  await runInspectMembers({
    fleetApi: createMockFleetApi(),
    workspace,
    reportPhase: (message) => phases.push(message),
  });
  assert.ok(phases.length >= 1);
  await runInspectMembers({ fleetApi: createMockFleetApi(), workspace });
});
