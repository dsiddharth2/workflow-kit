// host/config.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SUPPORTED_ADAPTERS = new Set(['express']);
const KNOWN_MODULES = new Set([
  'runLoop', 'memory', 'budgets', 'guardrails', 'evals', 'dispatch',
]);
const IMPLEMENTED_MODULES = new Set([]); // Phase 1: none

export async function loadConfig(configDir, env = process.env) {
  const raw = await resolveConfig(configDir);
  return validate(raw, env);
}

async function resolveConfig(dir) {
  const mjsPath = path.join(dir, 'host.config.mjs');
  try {
    const mod = await import(pathToFileURL(mjsPath).href);
    return mod.default;
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND' && !err.message?.includes('Cannot find module')) {
      throw err;
    }
  }

  const jsonPath = path.join(dir, 'host.config.json');
  try {
    const text = await fs.readFile(jsonPath, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  throw new Error(`host.config.mjs (or .json) not found in ${dir}`);
}

function validate(raw, env) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('config must be an object');
  }
  if (!raw.name || typeof raw.name !== 'string') {
    throw new Error('config.name is required (non-empty string)');
  }
  if (!raw.fleet || typeof raw.fleet !== 'object') {
    throw new Error('config.fleet is required (object)');
  }
  if (!raw.comm || typeof raw.comm !== 'object') {
    throw new Error('config.comm is required (object)');
  }
  if (!SUPPORTED_ADAPTERS.has(raw.comm.adapter)) {
    throw new Error(
      `unsupported comm adapter: "${raw.comm.adapter}" — supported: ${[...SUPPORTED_ADAPTERS].join(', ')}`,
    );
  }

  const port = raw.comm.port ?? Number(env.PORT ?? 3000);
  const host = raw.comm.host ?? env.MCP_BIND_HOST ?? '127.0.0.1';

  if (raw.modules && typeof raw.modules === 'object') {
    for (const key of Object.keys(raw.modules)) {
      if (!KNOWN_MODULES.has(key)) {
        console.warn(`[host/config] unknown module "${key}" — ignored`);
      } else if (raw.modules[key]?.enabled && !IMPLEMENTED_MODULES.has(key)) {
        console.warn(
          `[host/config] ${key} enabled but not implemented in this version — ignored`,
        );
      }
    }
  }

  return Object.freeze({
    name: raw.name,
    description: raw.description ?? '',
    fleet: Object.freeze({ ...raw.fleet }),
    comm: Object.freeze({
      adapter: raw.comm.adapter,
      port,
      host,
    }),
    modules: Object.freeze(raw.modules ?? {}),
  });
}
