// host/tools/registry.mjs
import { defaultRegistry } from '../../mcp/registry.mjs';

const DEFAULTS = {
  reversible: true,
  timeout: 300_000,
  retryable: false,
  tags: [],
};

export function extendRegistry(registry = defaultRegistry) {
  return registry.map(entry => ({
    ...DEFAULTS,
    ...entry,
    tags: entry.tags ?? DEFAULTS.tags,
  }));
}

export const hostRegistry = extendRegistry();
