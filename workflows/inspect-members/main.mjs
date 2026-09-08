import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Shared with the demo workflow on purpose: duplicating the symlink
// logic would mean two places to fix when the Fleet install layout changes.
import { ensureApralabs } from '../demo/ensure-apralabs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineScript = path.join(here, 'inspect-members.js');

export const selfExecuting = true;

export async function runInspectMembers({
  fleetApi,
  members,
  includeFiles,
  signal,
  reportPhase,
} = {}) {
  ensureApralabs();
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');

  let api = fleetApi;
  let stop = null;
  if (!api) {
    const { spawnFleet } = await import('../../transport/stdio-fleet.mjs');
    const fleet = await spawnFleet({});
    api = fleet.fleetApi;
    stop = fleet.stop;
  }

  try {
    const workflowApi = {
      executeCommand(options) {
        Object.defineProperty(options, 'failSoft', { value: true, enumerable: false });
        return api.executeCommand(options);
      },
    };
    const workflow = new FleetWorkflow(workflowApi);
    const engine = new WorkflowEngine(workflow);
    return await engine.executeFile(engineScript, {
      fleetApi: api,
      members,
      includeFiles,
      signal,
      reportPhase,
    });
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
    const report = await runInspectMembers();
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
