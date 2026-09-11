import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemberManager } from '../pool/member-manager.mjs';
import { buildRoster } from '../pool/roster.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'member-manager-'));

test('provisionPair registers both roles, creates folders, and authorises both', async () => {
  const fleetApi = createMockFleetApi();
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  const workRoot = path.join(await tmp(), 'pair');

  const pair = await manager.provisionPair('EPHEMERAL-ABCDEF12', workRoot);

  assert.deepEqual(pair, {
    doer: { name: 'EPHEMERAL-ABCDEF12-DOER', folder: path.join(workRoot, 'doer') },
    reviewer: { name: 'EPHEMERAL-ABCDEF12-REVIEWER', folder: path.join(workRoot, 'reviewer') },
  });
  assert.deepEqual(
    fleetApi.registerCalls.map((call) => call.friendly_name),
    ['EPHEMERAL-ABCDEF12-DOER', 'EPHEMERAL-ABCDEF12-REVIEWER'],
  );
  assert.equal(fleetApi.registerCalls[0].member_type, 'local');
  assert.equal(fleetApi.registerCalls[0].work_folder, pair.doer.folder);
  assert.deepEqual(
    fleetApi.authCalls.map((call) => call.member_name),
    ['EPHEMERAL-ABCDEF12-DOER', 'EPHEMERAL-ABCDEF12-REVIEWER'],
  );
  assert.deepEqual((await fs.readdir(workRoot)).sort(), ['doer', 'reviewer']);
});

test('provisionPair skips members that Fleet already lists', async () => {
  const fleetApi = createMockFleetApi({ members: ['WORKER-1-DOER'] });
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  await manager.provisionPair('WORKER-1', path.join(await tmp(), 'worker-1'));
  assert.deepEqual(fleetApi.registerCalls.map((call) => call.friendly_name), ['WORKER-1-REVIEWER']);
  assert.equal(fleetApi.authCalls.length, 2, 'auth still runs for both roles');
});

test('provisionPair matches names token-exactly', async () => {
  const fleetApi = createMockFleetApi({ members: ['WORKER-11-DOER', 'WORKER-11-REVIEWER'] });
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  await manager.provisionPair('WORKER-1', path.join(await tmp(), 'worker-1'));
  assert.deepEqual(
    fleetApi.registerCalls.map((call) => call.friendly_name),
    ['WORKER-1-DOER', 'WORKER-1-REVIEWER'],
  );
});

test('provisionPair rolls back the doer when the reviewer fails to register', async () => {
  const fleetApi = createMockFleetApi({ registerFails: ['EPHEMERAL-BAD00000-REVIEWER'] });
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  await assert.rejects(
    async () => manager.provisionPair('EPHEMERAL-BAD00000', path.join(await tmp(), 'pair')),
    /register_member failed for EPHEMERAL-BAD00000-REVIEWER/,
  );
  assert.deepEqual(
    fleetApi.removeCalls.map((call) => call.member_name),
    ['EPHEMERAL-BAD00000-DOER', 'EPHEMERAL-BAD00000-REVIEWER'],
  );
  assert.equal(fleetApi.authCalls.length, 0, 'no auth for a half-provisioned pair');
});

test('provisionPair removes the workRoot when reviewer registration fails', async () => {
  const fleetApi = createMockFleetApi({ registerFails: ['EPHEMERAL-BAD00000-REVIEWER'] });
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  const workRoot = path.join(await tmp(), 'pair');
  await assert.rejects(
    () => manager.provisionPair('EPHEMERAL-BAD00000', workRoot),
    /register_member failed for EPHEMERAL-BAD00000-REVIEWER/,
  );
  await assert.rejects(() => fs.access(workRoot), /ENOENT/);
});

test('provisionPair without a token registers but never calls provisionLlmAuth', async () => {
  const fleetApi = createMockFleetApi();
  const manager = new MemberManager(fleetApi, {});
  await manager.provisionPair('WORKER-1', path.join(await tmp(), 'worker-1'));
  assert.equal(fleetApi.registerCalls.length, 2);
  assert.equal(fleetApi.authCalls.length, 0);
});

test('provisionPair tolerates a Fleet without provision_llm_auth', async () => {
  const fleetApi = createMockFleetApi({ tools: ['remove_member'] });
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  const pair = await manager.provisionPair('WORKER-1', path.join(await tmp(), 'worker-1'));
  assert.equal(pair.doer.name, 'WORKER-1-DOER');
});

test('teardownPair removes both members and deletes the work root', async () => {
  const fleetApi = createMockFleetApi();
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  const workRoot = path.join(await tmp(), 'pair');
  await manager.provisionPair('EPHEMERAL-ABCDEF12', workRoot);
  await fs.writeFile(path.join(workRoot, 'doer', 'artifact.txt'), 'x');

  await manager.teardownPair('EPHEMERAL-ABCDEF12', workRoot);

  assert.deepEqual(
    fleetApi.removeCalls.map((call) => call.member_name),
    ['EPHEMERAL-ABCDEF12-DOER', 'EPHEMERAL-ABCDEF12-REVIEWER'],
  );
  assert.equal(fleetApi.present.has('EPHEMERAL-ABCDEF12-DOER'), false);
  await assert.rejects(() => fs.access(workRoot));
});

test('teardownPair still deletes the folder when Fleet has no remove_member', async () => {
  const fleetApi = createMockFleetApi({ tools: ['provision_llm_auth'] });
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  const workRoot = path.join(await tmp(), 'pair');
  await manager.provisionPair('EPHEMERAL-ABCDEF12', workRoot);
  await manager.teardownPair('EPHEMERAL-ABCDEF12', workRoot);
  await assert.rejects(() => fs.access(workRoot));
});

test('provisionRoster registers and authorises every roster member in order', async () => {
  const fleetApi = createMockFleetApi();
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  const root = await tmp();
  const roster = buildRoster({ size: 2, root });

  await manager.provisionRoster(roster);

  assert.deepEqual(fleetApi.registerCalls.map((call) => call.friendly_name), rosterNames(2));
  assert.deepEqual(fleetApi.authCalls.map((call) => call.member_name), rosterNames(2));
  assert.deepEqual((await fs.readdir(path.join(root, 'worker-2'))).sort(), ['doer', 'reviewer']);
});

test('provisionRoster fails fast on the first member that cannot register', async () => {
  const fleetApi = createMockFleetApi({ registerFails: ['WORKER-1-REVIEWER'] });
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  await assert.rejects(
    async () => manager.provisionRoster(buildRoster({ size: 2, root: await tmp() })),
    /WORKER-1-REVIEWER/,
  );
  assert.equal(fleetApi.registerCalls.length, 2, 'must not continue to worker-2');
});

test('constructor requires fleetApi', () => {
  assert.throws(() => new MemberManager(undefined, {}), /requires fleetApi/);
});
