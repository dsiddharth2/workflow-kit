import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memberIsPresent, toolResultLooksFailed, toolText } from '../pool/fleet-text.mjs';

test('toolText reads MCP content envelopes', () => {
  assert.equal(toolText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(toolText('plain'), 'plain');
  assert.equal(toolText(null), '');
});

test('memberIsPresent matches a whole name', () => {
  assert.equal(memberIsPresent('WORKER-1-DOER\nWORKER-1-REVIEWER', 'WORKER-1-DOER'), true);
  assert.equal(memberIsPresent('WORKER-2-DOER', 'WORKER-1-DOER'), false);
});

test('memberIsPresent does not match a name that is only a prefix', () => {
  // The bug this exists to prevent: WORKER-1-DOER is a substring of
  // WORKER-11-DOER, so a naive includes() reports a missing worker present.
  assert.equal(memberIsPresent('WORKER-11-DOER', 'WORKER-1-DOER'), false);
  assert.equal(memberIsPresent('WORKER-11-DOER\nWORKER-1-DOER', 'WORKER-1-DOER'), true);
});

test('memberIsPresent matches names inside JSON output', () => {
  const json = '{"members":[{"friendly_name":"WORKER-1-DOER"}]}';
  assert.equal(memberIsPresent(json, 'WORKER-1-DOER'), true);
  assert.equal(memberIsPresent(json, 'WORKER-1-REVIEWER'), false);
});

test('toolResultLooksFailed recognises isError and Fleet error prefixes', () => {
  assert.equal(toolResultLooksFailed({ isError: true, content: [] }), true);
  assert.equal(toolResultLooksFailed({ content: [{ type: 'text', text: '❌ host is required' }] }), true);
  assert.equal(toolResultLooksFailed({ content: [{ type: 'text', text: 'ERROR: nope' }] }), true);
  assert.equal(toolResultLooksFailed({ content: [{ type: 'text', text: 'registered X' }] }), false);
  assert.equal(toolResultLooksFailed(null), false);
});
