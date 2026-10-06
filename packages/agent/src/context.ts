// The context block (spec §9.2). The model sees only this; validators check against it.
import { type DayFacts, type InvitationFacts, type Numbers, confidenceWord, dayLabel, fmtAqi, fmtDate, fmtTemp, fmtTideM, fmtTime, fmtWind, visitMinutes } from './facts.js';

export const FIRM_GROUND = 'stay on firm ground';

function factsLine(n: Numbers): string {
  const parts: string[] = [];
  const t = n.tide;
  if (t && (t.low_time || t.low_m !== undefined || t.trend)) {
    let s = t.low_time ? `low tide ${fmtTime(t.low_time)}` : 'tide';
    if (t.low_m !== undefined) s += ` (${fmtTideM(t.low_m)})`;
    if (t.trend) s += `${t.low_time || t.low_m !== undefined ? ',' : ''} ${t.trend}`;
    parts.push(s);
  }
  if (n.apparent_c !== undefined) parts.push(`apparent ${fmtTemp(n.apparent_c)}`);
  if (n.wind_ms !== undefined) parts.push(fmtWind(n.wind_ms));
  if (n.us_aqi !== undefined) parts.push(fmtAqi(n.us_aqi));
  if (n.golden_start) parts.push(`golden hour from ${fmtTime(n.golden_start)}`);
  if (n.sunset) parts.push(`sunset ${fmtTime(n.sunset)}`);
  return parts.join('; ') || 'none';
}

const fmtValue = (v: unknown) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));

export function safetyText(f: Pick<InvitationFacts, 'spot' | 'safety_line'>): string {
  if (f.safety_line) return f.spot.kind === 'coastal' && !/firm ground/i.test(f.safety_line) ? `coastal → ${FIRM_GROUND}; ${f.safety_line}` : f.safety_line;
  return f.spot.kind === 'coastal' ? `coastal → ${FIRM_GROUND}` : 'none';
}

export function buildContextBlock(f: InvitationFacts): string {
  const lines = [
    `NOW: ${fmtDate(f.now)} ${fmtTime(f.now)} IST`,
    `INVITATION: spot "${f.spot.name}" (${f.spot.kind}), window ${fmtTime(f.window_start)}–${fmtTime(f.window_end)}, leave by ${fmtTime(f.leave_by)}, travel ${f.spot.travel_min} min`,
    `FACTS: ${factsLine(f.numbers)}`,
    `SIGHTINGS (eBird, last 48h, ≤3 km): ${
      f.sightings.map((s) => `${s.common_name} ×${s.count} (${dayLabel(s.when, f.now)} ${fmtTime(s.when)})`).join(', ') || 'none'
    }`,
  ];
  if (f.detections)
    lines.push(
      `LIVE DETECTIONS (this visit): ${
        f.detections.map((d) => `${d.common_name} ${d.confidence.toFixed(2)} "${confidenceWord(d.confidence)}" (${fmtTime(d.time)})`).join(', ') || 'none'
      }`,
    );
  lines.push(
    `PREFERENCES: ${f.preferences.map((p) => `${p.key} = ${fmtValue(p.value)}`).join('; ') || 'none'}`,
    `RELEVANT NOTES: ${f.notes.map((n) => `[${n.date}] "${n.excerpt}"`).join(' ') || 'none'}`,
    `SAFETY: ${safetyText(f)}`,
  );
  return lines.join('\n');
}

/** Field-note facts as text: the note model's input and the verifier's ground truth. */
export function renderDayFacts(f: DayFacts): string {
  const lines = [
    `DATE: ${f.date}`,
    `SPOT: "${f.spot.name}" (${f.spot.kind})`,
    `VISIT: ${fmtTime(f.start)}–${fmtTime(f.end)}, ${visitMinutes(f)} min`,
    `SPECIES: ${
      f.species
        .map((s) => `${s.common_name} ×${s.count}, first ${fmtTime(s.first_time)}, ${s.confidence.toFixed(2)} "${confidenceWord(s.confidence)}"`)
        .join('; ') || 'none'
    }`,
    `CONDITIONS: ${f.numbers ? factsLine(f.numbers) : 'none'}`,
    `OBSERVATIONS: ${f.observations?.map((o) => `[${fmtTime(o.time)}] "${o.text}"`).join(' ') || 'none'}`,
  ];
  return lines.join('\n');
}
