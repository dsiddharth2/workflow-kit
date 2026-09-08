import { fileURLToPath } from 'node:url';

export const meta = { name: 'demo' };

const DUMMY_PY = fileURLToPath(new URL('./dummy.py', import.meta.url));

function toolText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const parts = result.content ?? [];
  if (parts.length > 0) {
    return parts.map((part) => part.text ?? '').join('\n');
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export async function main(context) {
  const { phase, command, transform, agent, log, args } = context;
  const fleetApi = args.fleetApi;
  if (!fleetApi) {
    throw new Error('demo.js requires args.fleetApi');
  }
  const signal = args.signal;
  const reportPhase = args.reportPhase ?? (() => {});
  const cancelled = () => signal?.aborted === true;

  phase('status');
  await reportPhase('reading fleet status');
  log(toolText(await fleetApi.fleetStatus()));
  if (cancelled()) return { cancelled: true };

  phase('python command');
  await reportPhase('running the python command');
  const cmdResult = await command(`python3 "${DUMMY_PY}"`, {
    member_name: 'DEMO-DOER',
    failSoft: true,
  });
  log(`command result: ${typeof cmdResult === 'string' ? cmdResult : JSON.stringify(cmdResult)}`);
  if (cancelled()) return { cancelled: true, command: cmdResult };

  phase('transform returns value');
  await reportPhase('running the transform');
  const payload = await transform('dummy payload', () => ({ ok: true, source: 'transform' }));
  log(`transform result: ${JSON.stringify(payload)}`);
  if (cancelled()) return { cancelled: true, command: cmdResult, transform: payload };

  phase('agent smoke');
  await reportPhase('dispatching the agent prompt');
  if (cancelled()) return { cancelled: true, command: cmdResult, transform: payload };
  const reply = await agent('Reply with exactly: pong', { member_name: 'DEMO-DOER' });
  log(`agent result: ${reply}`);

  return { command: cmdResult, transform: payload, agent: reply };
}
