// tests/host-registry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { extendRegistry, hostRegistry } = await import('../host/tools/registry.mjs');
const { defaultRegistry } = await import('../mcp/registry.mjs');

test('hostRegistry has same length as defaultRegistry', () => {
  assert.equal(hostRegistry.length, defaultRegistry.length);
});

test('every tool has the extended fields', () => {
  for (const tool of hostRegistry) {
    assert.equal(typeof tool.reversible, 'boolean', `${tool.name}.reversible`);
    assert.equal(typeof tool.timeout, 'number', `${tool.name}.timeout`);
    assert.equal(typeof tool.retryable, 'boolean', `${tool.name}.retryable`);
    assert.ok(Array.isArray(tool.tags), `${tool.name}.tags`);
  }
});

test('defaults are applied when tool does not declare them', () => {
  const original = [{ name: 'bare', run: async () => 'ok' }];
  const extended = extendRegistry(original);
  assert.equal(extended[0].reversible, true);
  assert.equal(extended[0].timeout, 300_000);
  assert.equal(extended[0].retryable, false);
  assert.deepEqual(extended[0].tags, []);
});

test('explicit values on a tool are preserved', () => {
  const original = [{
    name: 'custom',
    reversible: false,
    timeout: 10_000,
    retryable: true,
    tags: ['critical'],
    run: async () => 'ok',
  }];
  const extended = extendRegistry(original);
  assert.equal(extended[0].reversible, false);
  assert.equal(extended[0].timeout, 10_000);
  assert.equal(extended[0].retryable, true);
  assert.deepEqual(extended[0].tags, ['critical']);
});

test('original tool properties (name, description, run, inputSchema) are preserved', () => {
  for (let i = 0; i < hostRegistry.length; i++) {
    const original = defaultRegistry[i];
    const extended = hostRegistry[i];
    assert.equal(extended.name, original.name);
    assert.equal(extended.description, original.description);
    assert.equal(extended.run, original.run);
    if (original.inputSchema) {
      assert.equal(extended.inputSchema, original.inputSchema);
    }
  }
});
