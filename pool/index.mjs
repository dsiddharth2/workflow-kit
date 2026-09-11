import { workersConfig } from './config.mjs';
import { EphemeralWorkerFactory } from './ephemeral-factory.mjs';
import { MemberManager } from './member-manager.mjs';
import { buildRoster } from './roster.mjs';
import { WorkerDispatcher } from './worker-dispatcher.mjs';
import { WorkerPool } from './worker-pool.mjs';

export { DispatchOverflowError, WorkerDispatcher } from './worker-dispatcher.mjs';
export { WorkerPool } from './worker-pool.mjs';
export { EphemeralWorkerFactory } from './ephemeral-factory.mjs';
export { MemberManager } from './member-manager.mjs';
export { createPooledFleetApi } from './pooled-fleet-api.mjs';
export { workersConfig } from './config.mjs';

// The startup lifecycle from the spec, in dependency order. A roster failure
// here is deliberately fatal: better a loud startup error than an agent()
// call failing deep inside a run.
export async function createWorkerDispatcher({ fleetApi, env = process.env, config, oauthToken } = {}) {
  if (!fleetApi) throw new Error('createWorkerDispatcher requires fleetApi');
  const resolved = config ?? workersConfig(env);
  const memberManager = new MemberManager(fleetApi, {
    oauthToken: oauthToken ?? env.CLAUDE_CODE_OAUTH_TOKEN,
  });

  let pool = null;
  if (resolved.pool.size > 0) {
    const roster = buildRoster(resolved.pool);
    await memberManager.provisionRoster(roster);
    pool = WorkerPool.create({ config: resolved.pool, roster });
  }

  let ephemeral = null;
  if (resolved.ephemeral.maxConcurrent > 0) {
    ephemeral = new EphemeralWorkerFactory({ memberManager, config: resolved.ephemeral });
  }

  return new WorkerDispatcher({ pool, ephemeral, config: resolved.dispatch });
}
