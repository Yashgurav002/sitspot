// The context block (spec §9.2). The model sees only this; validators check against it.
import { type DayFacts, type InvitationFacts, type Numbers, COAST_CLOSE_BEFORE_SUNSET_MIN, coastalClosed, confidenceWord, dayLabel, fmtAqi, fmtDate, fmtTemp, fmtTideM, fmtTime, fmtWind, visitMinutes } from './facts.js';

export const FIRM_GROUND = 'stay on firm ground';

/** With `now` (invitations), a low tide that has already passed is dropped: "tide rising", not a stale low. */
function factsLine(n: Numbers, now?: Date): string {
  const parts: string[] = [];
  const t = n.tide && now && n.tide.low_time && n.tide.low_time < now ? { trend: n.tide.trend } : n.tide;
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
  if (n.sunrise) parts.push(`sunrise ${fmtTime(n.sunrise)}`);
  if (n.sunset) parts.push(`sunset ${fmtTime(n.sunset)}`);
  return parts.join('; ') || 'none';
}

const fmtValue = (v: unknown) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));

export function safetyText(f: Pick<InvitationFacts, 'spot' | 'safety_line'>): string {
  if (f.safety_line) return f.spot.kind === 'coastal' && !/firm ground/i.test(f.safety_line) ? `coastal → ${FIRM_GROUND}; ${f.safety_line}` : f.safety_line;
  return f.spot.kind === 'coastal' ? `coastal → ${FIRM_GROUND}` : 'none';
}

/** S-1 in plain words for the model, when the coast is closed now. */
function closedText(f: InvitationFacts): string {
  if (!coastalClosed(f)) return '';
  const s = `; Too late for the coast now (after sunset − ${COAST_CLOSE_BEFORE_SUNSET_MIN} min). Do not suggest going.`;
  return f.detections ? `${s} They are there now: tell them to head back to firm ground and leave.` : s;
}

export function buildContextBlock(f: InvitationFacts): string {
  const lines = [
    `NOW: ${fmtDate(f.now)} ${fmtTime(f.now)} IST`,
    `INVITATION: spot "${f.spot.name}" (${f.spot.kind}), window ${fmtTime(f.window_start)}–${fmtTime(f.window_end)}, leave by ${fmtTime(f.leave_by)}, travel ${f.spot.travel_min} min`,
    `FACTS: ${factsLine(f.numbers, f.now)}`,
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
    `SAFETY: ${safetyText(f)}${closedText(f)}`,
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
