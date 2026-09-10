import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const meta = { name: 'city-briefing' };

const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
const WEATHER_PY = path.join(toolsDir, 'weather', 'weather.py');
const TIMEZONE_PY = path.join(toolsDir, 'timezone', 'timezone.py');
const TEXTSTATS_PY = path.join(toolsDir, 'textstats', 'textstats.py');

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

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: 'failed to parse tool output', raw: text };
  }
}

export async function main(context) {
  const { phase, command, agent, log, args } = context;
  const fleetApi = args.fleetApi;
  if (!fleetApi) throw new Error('city-briefing requires args.fleetApi');

  const city = args.city || 'London';
  const signal = args.signal;
  const reportPhase = args.reportPhase ?? (() => {});
  const cancelled = () => signal?.aborted === true;

  // --- Phase 1: fetch weather ---
  phase('weather');
  await reportPhase(`fetching weather for ${city}`);
  const weatherRaw = await command(`python3 "${WEATHER_PY}" "${city}"`, {
    member_name: 'doer',
    failSoft: true,
  });
  const weather = safeJson(typeof weatherRaw === 'string' ? weatherRaw : weatherRaw?.output ?? toolText(weatherRaw));
  log(`weather: ${JSON.stringify(weather)}`);
  if (cancelled()) return { cancelled: true, weather };

  // --- Phase 2: fetch local time ---
  phase('timezone');
  await reportPhase(`fetching local time for ${city}`);
  const timeRaw = await command(`python3 "${TIMEZONE_PY}" "${city}"`, {
    member_name: 'doer',
    failSoft: true,
  });
  const timeInfo = safeJson(typeof timeRaw === 'string' ? timeRaw : timeRaw?.output ?? toolText(timeRaw));
  log(`timezone: ${JSON.stringify(timeInfo)}`);
  if (cancelled()) return { cancelled: true, weather, time: timeInfo };

  // --- Phase 3: agent composes the briefing ---
  phase('compose briefing');
  await reportPhase('composing city briefing with agent');
  if (cancelled()) return { cancelled: true, weather, time: timeInfo };

  const prompt = [
    `You are a concise travel assistant. Given the data below, write a short 3-4 sentence city briefing for ${city}.`,
    `Include the current weather, temperature, and local time. End with one practical tip for someone visiting today.`,
    '',
    `Weather data: ${JSON.stringify(weather)}`,
    `Time data: ${JSON.stringify(timeInfo)}`,
    '',
    'Reply with ONLY the briefing text, no preamble.',
  ].join('\n');

  const briefing = await agent(prompt, { member_name: 'doer' });
  log(`briefing: ${briefing}`);
  if (cancelled()) return { cancelled: true, weather, time: timeInfo, briefing };

  // --- Phase 4: analyze the briefing text ---
  phase('text stats');
  await reportPhase('analyzing briefing text');
  const escaped = briefing.replace(/"/g, '\\"').replace(/\n/g, ' ');
  const statsRaw = await command(`python3 "${TEXTSTATS_PY}" "${escaped}"`, {
    member_name: 'doer',
    failSoft: true,
  });
  const stats = safeJson(typeof statsRaw === 'string' ? statsRaw : statsRaw?.output ?? toolText(statsRaw));
  log(`text stats: ${JSON.stringify(stats)}`);

  return { city, weather, time: timeInfo, briefing, stats };
}
