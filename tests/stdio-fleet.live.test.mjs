import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Skip the entire file if apra-fleet is not installed.
let fleetBin;
try {
  fleetBin = execSync('which apra-fleet', { encoding: 'utf8' }).trim();
} catch {
  try {
    const home = os.homedir();
    const candidate = path.join(home, '.apra-fleet', 'bin', 'apra-fleet');
    if (fs.existsSync(candidate)) {
      fleetBin = candidate;
    }
  } catch { /* skip */ }
}

if (!fleetBin) {
  test('live stdio tests skipped — apra-fleet not found', { skip: 'apra-fleet binary not installed' }, () => {});
} else {
  const { spawnFleet } = await import('../transport/stdio-fleet.mjs');

  test('spawnFleet connects to a real Fleet process and calls fleetStatus', async () => {
    const workFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-live-'));
    const { fleetApi, stop } = await spawnFleet({
      memberName: 'LIVE-TEST',
      workFolder,
      bin: fleetBin,
    });
    try {
      const status = await fleetApi.fleetStatus();
      assert.ok(status.content, 'fleetStatus should return a content envelope');
      assert.ok(status.content.length > 0, 'fleetStatus content should not be empty');
    } finally {
      await stop();
      fs.rmSync(workFolder, { recursive: true, force: true });
    }
  });

  test('spawnFleet registers a member and lists it', async () => {
    const workFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-live-'));
    const { fleetApi, stop } = await spawnFleet({
      memberName: 'LIVE-MEMBER',
      workFolder,
      bin: fleetBin,
    });
    try {
      const result = await fleetApi.listMembers({});
      const text = result.content.map((p) => p.text).join('\n');
      assert.ok(text.includes('LIVE-MEMBER'), `expected LIVE-MEMBER in: ${text}`);
    } finally {
      await stop();
      fs.rmSync(workFolder, { recursive: true, force: true });
    }
  });
}
