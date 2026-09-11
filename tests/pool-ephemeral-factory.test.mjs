import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EphemeralWorkerFactory } from '../pool/ephemeral-factory.mjs';
import { MemberManager } from '../pool/member-manager.mjs';
import { createMockFleetApi } from './helpers/mock-fleet.mjs';

async function makeFactory({ maxConcurrent = 2, ttlMs = 600000, fleetApi = createMockFleetApi() } = {}) {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ephemeral-'));
  const memberManager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  const factory = new EphemeralWorkerFactory({
    memberManager,
    config: { maxConcurrent, workRoot, ttlMs },
  });
  return { factory, fleetApi, workRoot };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test('create registers a guid-named pair under workRoot and returns a lease', async () => {
  const { factory, fleetApi, workRoot } = await makeFactory();
  const lease = await factory.create();

  assert.match(lease.workerId, /^ephemeral-[0-9a-f]{8}$/);
  const shortId = lease.workerId.slice('ephemeral-'.length).toUpperCase();
  assert.equal(lease.doer.name, `EPHEMERAL-${shortId}-DOER`);
  assert.equal(lease.reviewer.name, `EPHEMERAL-${shortId}-REVIEWER`);
  assert.equal(path.dirname(path.dirname(lease.doer.folder)), workRoot);
  assert.equal(path.basename(lease.doer.folder), 'doer');
  assert.equal(fleetApi.registerCalls.length, 2);
  assert.equal(factory.active, 1);
  await lease.release();
  await factory.close();
});

test('release unregisters both members, deletes the folder, and frees the slot', async () => {
  const { factory, fleetApi } = await makeFactory();
  const lease = await factory.create();
  const pairRoot = path.dirname(lease.doer.folder);
  await fs.writeFile(path.join(lease.doer.folder, 'out.txt'), 'x');

  let fired = 0;
  factory.onRelease(() => { fired += 1; });
  await lease.release();
  await lease.release();

  assert.deepEqual(
    fleetApi.removeCalls.map((call) => call.member_name),
    [lease.doer.name, lease.reviewer.name],
  );
  await assert.rejects(() => fs.access(pairRoot));
  assert.equal(factory.active, 0);
  assert.equal(fired, 1, 'release is idempotent and notifies once');
  await factory.close();
});

test('create returns null at maxConcurrent and resumes after a release', async () => {
  const { factory } = await makeFactory({ maxConcurrent: 1 });
  const first = await factory.create();
  assert.equal(await factory.create(), null);
  await first.release();
  const second = await factory.create();
  assert.notEqual(second, null);
  await second.release();
  await factory.close();
});

test('concurrent creates never overshoot maxConcurrent', async () => {
  const { factory } = await makeFactory({ maxConcurrent: 2 });
  const leases = await Promise.all([factory.create(), factory.create(), factory.create()]);
  assert.equal(leases.filter(Boolean).length, 2);
  assert.equal(leases.filter((lease) => lease === null).length, 1);
  await Promise.all(leases.filter(Boolean).map((lease) => lease.release()));
  await factory.close();
});

test('a provisioning failure frees the slot and propagates', async () => {
  const fleetApi = createMockFleetApi({ registerFails: [] });
  const { factory } = await makeFactory({ maxConcurrent: 1, fleetApi });
  fleetApi.registerMember = async () => ({ content: [{ type: 'text', text: '❌ fleet is full' }] });
  await assert.rejects(() => factory.create(), /fleet is full/);
  assert.equal(factory.active, 0);
  await factory.close();
});

test('a failed provisionPair does not leave the workRoot on disk', async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ephemeral-leak-'));
  const memberManager = {
    async provisionPair(_prefix, root) {
      await fs.mkdir(path.join(root, 'doer'), { recursive: true });
      throw new Error('registration exploded');
    },
    async teardownPair(_prefix, root) {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
  const factory = new EphemeralWorkerFactory({
    memberManager,
    config: { maxConcurrent: 1, workRoot, ttlMs: 60_000 },
  });
  await assert.rejects(() => factory.create(), /registration exploded/);
  assert.deepEqual(await fs.readdir(workRoot), []);
  await factory.close();
});

test('the lease signal follows the caller signal', async () => {
  const { factory } = await makeFactory();
  const controller = new AbortController();
  const lease = await factory.create({ signal: controller.signal });
  assert.equal(lease.signal.aborted, false);
  controller.abort(new Error('caller cancelled'));
  assert.equal(lease.signal.aborted, true);
  assert.match(String(lease.signal.reason?.message), /caller cancelled/);
  await lease.release();
  await factory.close();
});

test('the ttl aborts the lease and tears the worker down', async () => {
  const { factory, fleetApi } = await makeFactory({ ttlMs: 40 });
  const lease = await factory.create();
  await tick(120);
  assert.equal(lease.signal.aborted, true);
  assert.match(String(lease.signal.reason?.message), /ttl/);
  assert.equal(fleetApi.removeCalls.length, 2);
  assert.equal(factory.active, 0);
  await lease.release();
  await factory.close();
});

test('close tears down every active lease and refuses new ones', async () => {
  const { factory, fleetApi } = await makeFactory({ maxConcurrent: 2 });
  await factory.create();
  await factory.create();
  await factory.close();
  assert.equal(fleetApi.removeCalls.length, 4);
  assert.equal(factory.active, 0);
  assert.equal(await factory.create(), null);
});

test('close waits for an in-flight create and does not return a live lease', async () => {
  let releaseRegister;
  const registerBlocked = new Promise((resolve) => {
    releaseRegister = resolve;
  });
  const fleetApi = createMockFleetApi();
  const originalRegister = fleetApi.registerMember.bind(fleetApi);
  fleetApi.registerMember = async (options) => {
    await registerBlocked;
    return originalRegister(options);
  };
  const { factory, workRoot } = await makeFactory({ fleetApi, maxConcurrent: 1 });
  const creating = factory.create();
  await tick();
  const closing = factory.close();
  releaseRegister();
  const lease = await creating;
  assert.equal(lease, null, 'a create that finishes after close must not return a usable lease');
  await closing;
  assert.equal(factory.active, 0);
  assert.equal(await factory.create(), null);
  assert.deepEqual(await fs.readdir(workRoot), []);
});
