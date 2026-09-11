// tests/dispatch.live.test.mjs
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Spawns a real Fleet over stdio. Needs the apra-fleet binary and
// CLAUDE_CODE_OAUTH_TOKEN. Not part of `npm test`.
//   node --test tests/dispatch.live.test.mjs

const { spawnFleet } = await import('../transport/stdio-fleet.mjs');
const { createWorkerDispatcher, createPooledFleetApi } = await import('../pool/index.mjs');
const { memberIsPresent, toolText } = await import('../pool/fleet-text.mjs');

test(
  'live: two pool workers, two ephemeral, two queued — all six calls complete on distinct pairs',
  { timeout: 600_000 },
  async () => {
    const poolRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'live-pool-'));
    const ephemeralRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'live-eph-'));
    const fleet = await spawnFleet({});
    try {
      const dispatcher = await createWorkerDispatcher({
        fleetApi: fleet.fleetApi,
        config: {
          pool: { size: 2, root: poolRoot, acquireTimeoutMs: 120_000 },
          ephemeral: { maxConcurrent: 2, workRoot: ephemeralRoot, ttlMs: 300_000 },
          dispatch: { maxQueueSize: 10, queueTimeoutMs: 300_000 },
        },
      });
      try {
        const listed = toolText(await fleet.fleetApi.listMembers({}));
        for (const name of ['WORKER-1-DOER', 'WORKER-1-REVIEWER', 'WORKER-2-DOER', 'WORKER-2-REVIEWER']) {
          assert.ok(memberIsPresent(listed, name), `${name} must be registered by MemberManager`);
        }

        const holders = new Set();
        let grants = 0;
        let maxConcurrent = 0;
        const grantBarrier = { target: 4, timeoutMs: 120_000 };

        const waitForGrants = () =>
          new Promise((resolve, reject) => {
            if (grants >= grantBarrier.target) {
              resolve();
              return;
            }
            const deadline = Date.now() + grantBarrier.timeoutMs;
            const check = () => {
              if (grants >= grantBarrier.target) {
                clearInterval(timer);
                resolve();
              } else if (Date.now() >= deadline) {
                clearInterval(timer);
                reject(
                  new Error(
                    `only ${grants} leases granted within ${grantBarrier.timeoutMs}ms; expected ${grantBarrier.target}`,
                  ),
                );
              }
            };
            const timer = setInterval(check, 25);
            check();
          });

        const runOne = async () => {
          const lease = await dispatcher.dispatch({});
          grants += 1;
          holders.add(lease.workerId);
          maxConcurrent = Math.max(maxConcurrent, holders.size);
          // Hold until the first wave (2 pool + 2 ephemeral) has all been granted.
          await waitForGrants();
          try {
            const api = createPooledFleetApi(fleet.fleetApi, lease);
            const result = await api.executeCommand({ member_name: 'doer', command: 'echo live-ok' });
            assert.match(toolText(result), /live-ok/);
            return { workerId: lease.workerId, doer: lease.doer.name };
          } finally {
            holders.delete(lease.workerId);
            await lease.release();
          }
        };

        const results = await Promise.all(Array.from({ length: 6 }, runOne));
        const ids = results.map((r) => r.workerId);
        assert.ok(ids.filter((id) => id.startsWith('pool-')).length >= 2);
        assert.ok(ids.filter((id) => id.startsWith('ephemeral-')).length >= 2);
        assert.equal(results.length, 6);
        assert.equal(
          maxConcurrent,
          4,
          '2 pool + 2 ephemeral held concurrently; the extra two wait then reuse',
        );

        const after = toolText(await fleet.fleetApi.listMembers({}));
        for (const { doer } of results.filter((r) => r.workerId.startsWith('ephemeral-'))) {
          assert.equal(memberIsPresent(after, doer), false, `${doer} must be removed after release`);
        }
        assert.deepEqual(await fs.readdir(ephemeralRoot), [], 'ephemeral folders are deleted');
      } finally {
        await dispatcher.close();
      }
    } finally {
      await fleet.stop();
    }
  },
);
