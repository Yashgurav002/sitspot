// Deterministic fallbacks. Built from the same formatters as the context block, so they
// always pass the validators (tested).
import { type DayFacts, type InvitationFacts, airLine, coastalClosed, poorAir, confidenceWord, fmtAqi, fmtTemp, fmtTideM, fmtTime, nextWindow, upcomingLow, visitMinutes } from './facts.js';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (name: string, n: number) => (n === 1 ? name : `${name}s`);

/** Reasons in fixed priority: tide → birds → comfort → light. ponytail: fixed order, rank by factor size if it reads wrong. */
function reasons(f: InvitationFacts): string[] {
  const out: string[] = [];
  const t = f.numbers.tide;
  const low = upcomingLow(t, f.now);
  if (f.spot.kind === 'coastal' && t && low && f.factors.tide_fit >= 0.6) {
    out.push(`low tide is at ${fmtTime(low)}${t.low_m !== undefined ? ` (${fmtTideM(t.low_m)})` : ''}${t.trend ? ` and it's ${t.trend}` : ''}`);
  }
  const top = [...f.sightings].sort((a, b) => b.count - a.count)[0];
  if (top) out.push(`${top.count} ${plural(top.common_name, top.count)} ${top.count === 1 ? 'was' : 'were'} reported nearby`);
  const n = f.numbers;
  if (n.apparent_c !== undefined) out.push(`it feels like ${fmtTemp(n.apparent_c)}${n.us_aqi !== undefined ? ` with ${fmtAqi(n.us_aqi)}` : ''}`);
  else if (n.us_aqi !== undefined && !poorAir(f)) out.push(`the air is clean, ${fmtAqi(n.us_aqi)}`);
  if (n.golden_start && f.factors.light_bonus > 1) out.push(`golden hour starts at ${fmtTime(n.golden_start)}`);
  return out.slice(0, 3);
}

const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** S-1 wording when the coast is closed: an invitation says don't go; a visit in progress says head back. */
function closedLine(f: InvitationFacts): string {
  if (f.detections) return `It's too late to stay at the coast now, so please head back to firm ground and leave ${f.spot.name}.`;
  const next = nextWindow(f);
  return `It's too late for the coast today, so please don't go to ${f.spot.name} now. Stay on firm ground if you're nearby.${next ? ` The next good window starts at ${fmtTime(next)}.` : ''}`;
}

export function templateScript(f: InvitationFacts): { script: string; reason: string } {
  if (coastalClosed(f)) return { script: closedLine(f), reason: "It's too late for the coast today." };
  const r = reasons(f);
  const parts = [
    `${f.spot.name} looks good right now.`,
    r.length ? `${cap(list(r))}.` : '',
    `Leave by ${fmtTime(f.leave_by)}, it's about ${f.spot.travel_min} ${plural('minute', f.spot.travel_min)} away, and it stays good until ${fmtTime(f.window_end)}.`,
    poorAir(f) ? airLine(f.numbers.us_aqi!) : '',
    f.spot.kind === 'coastal' ? 'Stay on firm ground.' : '',
    'Want to go?',
  ];
  return {
    script: parts.filter(Boolean).join(' '),
    reason: r.length ? `${cap(list(r))}.` : `${f.spot.name} is good between ${fmtTime(f.window_start)} and ${fmtTime(f.window_end)}.`,
  };
}

export function templateChat(f: InvitationFacts): string {
  if (coastalClosed(f)) return closedLine(f);
  // Latest confidence per bird, last 3 birds, each with its §9.3 word.
  const heard = [...new Map((f.detections ?? []).map((d) => [d.common_name, d])).values()].slice(-3);
  const birds = heard.length ? ` So far I've picked up ${list(heard.map((d) => `${d.common_name} (${confidenceWord(d.confidence)})`))}.` : '';
  return `I'm not sure, I can only go by today's conditions at ${f.spot.name}.${birds}${f.spot.kind === 'coastal' ? ' Stay on firm ground.' : ''}`;
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
