// Deterministic fallbacks. Built from the same formatters as the context block, so they
// always pass the validators (tested).
import { type DayFacts, type InvitationFacts, confidenceWord, fmtAqi, fmtTemp, fmtTideM, fmtTime, visitMinutes } from './facts.js';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (name: string, n: number) => (n === 1 ? name : `${name}s`);

/** Reasons in fixed priority: tide → birds → comfort → light. ponytail: fixed order, rank by factor size if it reads wrong. */
function reasons(f: InvitationFacts): string[] {
  const out: string[] = [];
  const t = f.numbers.tide;
  if (f.spot.kind === 'coastal' && t?.low_time && f.factors.tide_fit >= 0.6) {
    out.push(`low tide is at ${fmtTime(t.low_time)}${t.low_m !== undefined ? ` (${fmtTideM(t.low_m)})` : ''}${t.trend ? ` and it's ${t.trend}` : ''}`);
  }
  const top = [...f.sightings].sort((a, b) => b.count - a.count)[0];
  if (top) out.push(`${top.count} ${plural(top.common_name, top.count)} ${top.count === 1 ? 'was' : 'were'} reported nearby`);
  const n = f.numbers;
  if (n.apparent_c !== undefined) out.push(`it feels like ${fmtTemp(n.apparent_c)}${n.us_aqi !== undefined ? ` with ${fmtAqi(n.us_aqi)}` : ''}`);
  else if (n.us_aqi !== undefined) out.push(`the air is clean, ${fmtAqi(n.us_aqi)}`);
  if (n.golden_start && f.factors.light_bonus > 1) out.push(`golden hour starts at ${fmtTime(n.golden_start)}`);
  return out.slice(0, 3);
}

const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export function templateScript(f: InvitationFacts): { script: string; reason: string } {
  const r = reasons(f);
  const parts = [
    `${f.spot.name} looks good right now.`,
    r.length ? `${cap(list(r))}.` : '',
    `Leave by ${fmtTime(f.leave_by)}, it's about ${f.spot.travel_min} minutes away, and it stays good until ${fmtTime(f.window_end)}.`,
    f.spot.kind === 'coastal' ? 'Stay on firm ground.' : '',
    'Want to go?',
  ];
  return {
    script: parts.filter(Boolean).join(' '),
    reason: r.length ? `${cap(list(r))}.` : `${f.spot.name} is good between ${fmtTime(f.window_start)} and ${fmtTime(f.window_end)}.`,
  };
}

export function templateChat(f: InvitationFacts): string {
  return `I'm not sure, I can only go by today's conditions at ${f.spot.name}.${f.spot.kind === 'coastal' ? ' Stay on firm ground.' : ''}`;
}

export function templateNote(f: DayFacts): string {
  const head = `${f.spot.name}, ${fmtTime(f.start)}–${fmtTime(f.end)} (${visitMinutes(f)} min).`;
  if (!f.species.length) return `${head} A quiet visit, nothing identified.`;
  const birds = f.species.map((s) => {
    const c = confidenceWord(s.confidence);
    const name = `${s.count} ${plural(s.common_name, s.count)} from ${fmtTime(s.first_time)}`;
    return c === 'confident' ? name : `${name} (${c})`;
  });
  return `${head} Heard ${list(birds)}.`;
}
