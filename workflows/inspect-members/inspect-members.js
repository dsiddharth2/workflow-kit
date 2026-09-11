import { fileURLToPath } from 'node:url';
import { memberIsPresent, toolText } from '../../pool/fleet-text.mjs';

export const meta = { name: 'inspect-members' };

// A run may only inspect the pair it holds. Reporting on another run's worker
// would be the same-member collision the pool exists to prevent.
export const ROLES = Object.freeze(['doer', 'reviewer']);

const INSPECT_PY = fileURLToPath(new URL('./inspect.py', import.meta.url));

// The engine returns { ok, output, error } — verified from a live run. A
// failSoft failure carries an empty output and puts the reason in `error`, so
// read that first and skip empty candidates rather than returning ''.
function commandText(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (raw.ok === false) {
    const detail = raw.error ?? raw.output;
    return typeof detail === 'string' && detail.trim().length > 0 ? detail : 'command failed';
  }
  for (const candidate of [raw.output, raw.stdout, raw.structuredContent?.stdout]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return toolText(raw);
}

function parseReport(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('{')) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        // Keep scanning earlier lines.
      }
    }
  }
  return null;
}

export async function main(context) {
  const { phase, command, log, args } = context;
  const fleetApi = args.fleetApi;
  if (!fleetApi) {
    throw new Error('inspect-members.js requires args.fleetApi');
  }
  const workspace = args.workspace;
  if (!workspace?.doer || !workspace?.reviewer) {
    throw new Error('inspect-members.js requires args.workspace with doer and reviewer');
  }
  const signal = args.signal;
  const reportPhase = args.reportPhase ?? (() => {});
  const includeFiles = args.includeFiles === true;
  const requestedRoles = Array.isArray(args.roles) && args.roles.length > 0 ? args.roles : ROLES;
  const targets = requestedRoles.map((role) => {
    if (!ROLES.includes(role)) {
      throw new Error(`Unsupported role: ${String(role)}`);
    }
    return { role, name: workspace[role].name, folder: workspace[role].folder };
  });

  phase('members');
  await reportPhase('listing fleet members');
  const listed = toolText(await fleetApi.listMembers({}));

  const members = [];
  for (const { role, name, folder } of targets) {
    if (signal?.aborted) {
      log(`cancelled before inspecting ${role}`);
      break;
    }

    if (!memberIsPresent(listed, name)) {
      log(`${name} is not registered`);
      members.push({ role, name, present: false });
      continue;
    }

    phase(`inspect ${role}`);
    await reportPhase(`inspecting ${role} (${name})`);
    const flags = includeFiles ? ' --files' : '';
    const raw = await command(
      `python3 "${INSPECT_PY}" --root "${folder}"${flags}`,
      { member_name: role, failSoft: true },
    );
    const text = commandText(raw);
    const report = parseReport(text);
    if (report) {
      members.push({ role, name, present: true, report });
    } else {
      members.push({ role, name, present: true, error: text.trim() || 'no report produced' });
    }
  }

  return { generatedAt: new Date().toISOString(), workerId: workspace.workerId, members };
}
