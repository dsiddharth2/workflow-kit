import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPooledFleetApi } from '../pool/pooled-fleet-api.mjs';

function fixture() {
  const calls = [];
  const fleetApi = {
    calls,
    async executeCommand(options) { calls.push(['command', options]); return 'ok'; },
    async executePrompt(options) { calls.push(['prompt', options]); return 'ok'; },
    async listMembers() { return { content: [{ type: 'text', text: 'roster' }] }; },
  };
  const lease = {
    workerId: 2,
    doer: { name: 'WORKER-2-DOER', folder: '/root/worker-2/doer' },
    reviewer: { name: 'WORKER-2-REVIEWER', folder: '/root/worker-2/reviewer' },
  };
  return { fleetApi, lease, api: createPooledFleetApi(fleetApi, lease) };
}

test('role keywords resolve to this lease-s members', async () => {
  const { api, fleetApi } = fixture();
  await api.executeCommand({ command: 'ls', member_name: 'doer' });
  await api.executePrompt({ prompt: 'hi', member_name: 'reviewer' });
  assert.equal(fleetApi.calls[0][1].member_name, 'WORKER-2-DOER');
  assert.equal(fleetApi.calls[1][1].member_name, 'WORKER-2-REVIEWER');
});

test('a literal member name passes through unchanged', async () => {
  const { api, fleetApi } = fixture();
  await api.executeCommand({ command: 'ls', member_name: 'SOME-OTHER-MEMBER' });
  assert.equal(fleetApi.calls[0][1].member_name, 'SOME-OTHER-MEMBER');
});

test('other options and other methods are untouched', async () => {
  const { api, fleetApi } = fixture();
  await api.executeCommand({ command: 'ls', member_name: 'doer', failSoft: true });
  assert.equal(fleetApi.calls[0][1].command, 'ls');
  assert.equal(fleetApi.calls[0][1].failSoft, true);
  assert.equal(await api.listMembers().then((r) => r.content[0].text), 'roster');
});

test('non-function properties stay readable through the wrapper', async () => {
  const { api, fleetApi } = fixture();
  await api.executeCommand({ command: 'ls', member_name: 'doer' });
  assert.equal(api.calls, fleetApi.calls, 'test mocks expose recorded calls as arrays');
});
