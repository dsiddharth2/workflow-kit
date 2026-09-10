import { createPooledFleetApi, createWorkerDispatcher } from '../pool/index.mjs';

// CLI runs (`node workflows/<name>/main.mjs`) get the same lease discipline as
// MCP calls: spawn Fleet over stdio, build a dispatcher, take one lease, run,
// release, tear everything down. Members are MemberManager's job, so
// spawnFleet is called without a memberName.
export async function withStandaloneLease(run, { env = process.env } = {}) {
  const { spawnFleet } = await import('../transport/stdio-fleet.mjs');
  const fleet = await spawnFleet({ env });
  try {
    const dispatcher = await createWorkerDispatcher({ fleetApi: fleet.fleetApi, env });
    try {
      const lease = await dispatcher.dispatch({});
      try {
        return await run({
          fleetApi: createPooledFleetApi(fleet.fleetApi, lease),
          signal: lease.signal,
          workspace: { workerId: lease.workerId, doer: lease.doer, reviewer: lease.reviewer },
        });
      } finally {
        await lease.release();
      }
    } finally {
      await dispatcher.close();
    }
  } finally {
    await fleet.stop();
  }
}
