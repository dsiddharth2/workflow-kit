import fs from 'node:fs/promises';
import path from 'node:path';
import { ROLES } from './roster.mjs';

// Fleet writes its own permission state here at registration. Wiping it makes
// the member re-prompt or fail on the next run, so it is the one exception.
export const PRESERVED_ENTRIES = Object.freeze(['.claude']);

export async function cleanWorkerFolder(folder) {
  await fs.mkdir(folder, { recursive: true });
  const entries = await fs.readdir(folder);
  const removed = [];
  for (const entry of entries) {
    if (PRESERVED_ENTRIES.includes(entry)) continue;
    await fs.rm(path.join(folder, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}

export async function cleanWorker(worker) {
  const removed = [];
  for (const role of ROLES) {
    removed.push(...(await cleanWorkerFolder(worker[role].folder)));
  }
  return removed;
}
