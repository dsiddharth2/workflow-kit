import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureApralabs } from './ensure-apralabs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineScript = path.join(here, 'demo.js');

export const selfExecuting = true;

export async function runDemo({ fleetApi, signal, reportPhase } = {}) {
  ensureApralabs();
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');

  let api = fleetApi;
  let stop = null;
  if (!api) {
    const { spawnFleet } = await import('../../transport/stdio-fleet.mjs');
    const repoRoot = path.resolve(here, '../..');
    const fleet = await spawnFleet({
      memberName: 'DEMO-DOER',
      workFolder: path.join(repoRoot, 'workdir', 'DEMO-DOER'),
    });
    api = fleet.fleetApi;
    stop = fleet.stop;
  }

  try {
    const workflow = new FleetWorkflow(api);
    const engine = new WorkflowEngine(workflow);
    return await engine.executeFile(engineScript, { fleetApi: api, signal, reportPhase });
  } finally {
    await stop?.();
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    await runDemo();
    process.exit(0);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
