import { describe, expect, it } from 'vitest';
import {
  buildContextBlock, checkScript, confidenceWord, firstSentences, hasSafetyLine, mentionsTime, numbersInFacts, quickRespond,
  quoteIsSubstring, renderDayFacts, speciesInFacts, templateChat, templateNote, templateScript, unsafeAdvice, verifyNote,
} from '../src/index.js';
import { creek, park, visitDay } from './fixtures.js';

describe('buildContextBlock', () => {
  it('produces the §9.2 shape', () => {
    expect(buildContextBlock({ ...creek, detections: [{ common_name: 'Common Kingfisher', confidence: 0.71, time: new Date('2026-10-08T12:01:00Z') }] }))
      .toBe(`NOW: 2026-10-08 17:05 IST
INVITATION: spot "Creek edge" (coastal), window 17:15–18:05, leave by 17:05, travel 12 min
FACTS: low tide 17:20 (0.6 m), falling; apparent 28°C; wind 4 m/s; US AQI 62; golden hour from 17:30; sunset 18:15
SIGHTINGS (eBird, last 48h, ≤3 km): Little Egret ×6 (yesterday 07:40), Common Kingfisher ×1 (today 08:10)
LIVE DETECTIONS (this visit): Common Kingfisher 0.71 "fairly confident, not certain" (17:31)
PREFERENCES: loves = "kingfishers"
RELEVANT NOTES: [2026-10-07] "Egrets on the mudflats at falling tide"
SAFETY: coastal → stay on firm ground; leave before 17:45 (sunset − 30)`);
  });
  it('writes "none" for empty sections and omits LIVE DETECTIONS off-visit', () => {
    const b = buildContextBlock({ ...park, numbers: {} });
    expect(b).toContain('FACTS: none');
    expect(b).toContain('SIGHTINGS (eBird, last 48h, ≤3 km): none');
    expect(b).toContain('PREFERENCES: none');
    expect(b).toContain('RELEVANT NOTES: none');
    expect(b).toContain('SAFETY: none');
    expect(b).not.toContain('LIVE DETECTIONS');
    expect(buildContextBlock({ ...park, detections: [] })).toContain('LIVE DETECTIONS (this visit): none');
  });
  it('coastal always gets firm ground in SAFETY', () => {
    expect(buildContextBlock({ ...creek, safety_line: undefined })).toContain('SAFETY: coastal → stay on firm ground');
  });
});

describe('numbersInFacts', () => {
  const ctx = buildContextBlock(creek);
  it('accepts numbers, times, decimals and units from the facts', () => {
    expect(numbersInFacts('Low tide at 17:20, 0.6 m, it feels like 28°C, AQI 62, leave by 17:05.', ctx)).toEqual([]);
  });
  it('accepts 12-hour spelling of a fact time and leading zeros', () => {
    expect(numbersInFacts('Low tide at 5:20 pm.', ctx)).toEqual([]);
    expect(numbersInFacts('Egrets at 7:40.', ctx)).toEqual([]);
  });
  it('allows 0–2 freely (digits and words), not 3+', () => {
    expect(numbersInFacts('One more thing, two egrets, 2 minutes.', 'nothing')).toEqual([]);
    expect(numbersInFacts('three egrets', 'nothing')).toEqual(['number "three" is not in the facts']);
  });
  it('rejects invented numbers, times, decimals and number words', () => {
    expect(numbersInFacts('Low tide at 18:40.', ctx)).toEqual(['number "18:40" is not in the facts']);
    expect(numbersInFacts('It feels like 31°C.', ctx)).toEqual(['number "31" is not in the facts']);
    expect(numbersInFacts('Tide 0.8 m.', ctx)).toEqual(['number "0.8" is not in the facts']);
    expect(numbersInFacts('About forty-five minutes.', ctx)).toEqual(['number "forty-five" is not in the facts']);
  });
  it('accepts spelled numbers that are in the facts', () => {
    expect(numbersInFacts('six egrets, twelve minutes away', ctx)).toEqual([]);
  });
  it('does not let a time leak its parts ("20" is not allowed by 17:20)', () => {
    expect(numbersInFacts('20 minutes', 'low tide 17:20')).toHaveLength(1);
  });
});

describe('speciesInFacts', () => {
  const allowed = ['Little Egret', 'Common Kingfisher'];
  it('allows facts species, plurals, any case, and group nouns they cover', () => {
    expect(speciesInFacts('Six little egrets and a COMMON KINGFISHER. Egrets love it. Kingfishers too.', allowed)).toEqual([]);
  });
  it('allows generic words', () => {
    expect(speciesInFacts('Lots of birds and waders about.', [])).toEqual([]);
  });
  it('rejects look-alikes and groups not in the facts', () => {
    expect(speciesInFacts('A Great Egret is there.', allowed)).toEqual(['species "great egret" is not in the facts']);
    expect(speciesInFacts('Maybe a white-throated kingfisher', allowed)).toEqual(['species "white throated kingfisher" is not in the facts']);
    expect(speciesInFacts('Herons and bulbuls', allowed)).toEqual(['species "heron" is not in the facts', 'species "bulbul" is not in the facts']);
  });
  it('handles hyphen variants and a custom known list', () => {
    expect(speciesInFacts('red vented bulbul', ['Red-vented Bulbul'])).toEqual([]);
    expect(speciesInFacts('a dodo', [], ['Dodo'])).toEqual(['species "dodo" is not in the facts']);
  });
});

describe('hasSafetyLine / unsafeAdvice', () => {
  it('coastal requires firm ground', () => {
    expect(hasSafetyLine('Go to the creek. Want to go?', 'coastal')).toHaveLength(1);
    expect(hasSafetyLine('Stay on firm ground. Want to go?', 'coastal')).toEqual([]);
    expect(hasSafetyLine('Want to go?', 'park')).toEqual([]);
  });
  it.each([
    'Walk out onto the mudflats for a closer look.',
    'You could step into the water.',
    'Wade across at low tide.',
    'Head off the path to the reeds.',
    'Go on the mud flats.',
  ])('rejects unsafe advice: %s', (t) => {
    expect(hasSafetyLine(`${t} Stay on firm ground.`, 'coastal').length).toBeGreaterThan(0);
    expect(unsafeAdvice(t).length).toBeGreaterThan(0);
  });
  it('ignores negated or observational mentions', () => {
    expect(unsafeAdvice("Don't walk onto the mudflats.")).toEqual([]);
    expect(unsafeAdvice('Never go into the water.')).toEqual([]);
    expect(unsafeAdvice('Egrets on the mudflats. It is good on the creek. Going to the creek is fine.')).toEqual([]);
  });
});

describe('quoteIsSubstring', () => {
  const u = "Honestly, the creek's too far on weekdays — weekends only, OK?";
  it('matches ignoring case, punctuation and whitespace', () => {
    expect(quoteIsSubstring('the creeks too far on weekdays', u)).toBe(true);
    expect(quoteIsSubstring("The creek's   too far, on weekdays", u)).toBe(true);
  });
  it('rejects fabricated, partial-word and empty quotes', () => {
    expect(quoteIsSubstring('I hate the creek', u)).toBe(false);
    expect(quoteIsSubstring('eekends', u)).toBe(false);
    expect(quoteIsSubstring(' ... ', u)).toBe(false);
  });
});

describe('confidenceWord', () => {
  it('uses §9.3 thresholds', () => {
    expect(confidenceWord(0.8)).toBe('confident');
    expect(confidenceWord(0.79)).toBe('fairly confident, not certain');
    expect(confidenceWord(0.6)).toBe('fairly confident, not certain');
    expect(confidenceWord(0.59)).toBe('possibly');
  });
});

describe('verifyNote', () => {
  it('accepts a grounded note, incl. species named in observations', () => {
    expect(verifyNote('From 17:20 to 18:02 we heard 2 Common Kingfishers and 3 Red-vented Bulbuls; possibly a Little Egret. A heron flew low.', visitDay)).toEqual([]);
  });
  it('rejects invented species, counts and times', () => {
    expect(verifyNote('We saw 5 Common Kingfishers.', visitDay)).toEqual(['number "5" is not in the facts']);
    expect(verifyNote('A Black Drongo at 17:31.', visitDay)).toEqual(['species "black drongo" is not in the facts', 'species "drongo" is not in the facts']);
    expect(verifyNote('Kingfisher at 17:50.', visitDay)).toEqual(['number "17:50" is not in the facts']);
  });
});

describe('templates always pass validators', () => {
  const cases = {
    'coastal + sightings': creek,
    'coastal, no sightings, no tide': { ...creek, sightings: [], numbers: { apparent_c: 30 } },
    'park + sightings': { ...park, sightings: creek.sightings },
    'park, nothing': { ...park, numbers: {} },
  };
  it.each(Object.entries(cases))('templateScript: %s', (_n, f) => {
    const out = templateScript(f);
    expect(checkScript(out, f)).toEqual([]);
    expect(out.script).toMatch(/Want to go\?$/);
    expect(out.script).toContain(f.spot.name);
  });
  it('coastal template says firm ground; park does not need to', () => {
    expect(templateScript(creek).script).toContain('Stay on firm ground.');
    expect(templateScript(park).script).not.toContain('firm ground');
  });
  it('templateChat passes', () => {
    for (const f of [creek, park]) {
      const r = templateChat(f);
      expect([...speciesInFacts(r, []), ...unsafeAdvice(r), ...numbersInFacts(r, buildContextBlock(f))]).toEqual([]);
    }
  });
  it('templateNote passes verifyNote, with and without species', () => {
    expect(verifyNote(templateNote(visitDay), visitDay)).toEqual([]);
    const empty = { ...visitDay, species: [], observations: [] };
    expect(verifyNote(templateNote(empty), empty)).toEqual([]);
    expect(templateNote(empty)).toContain('quiet visit');
    expect(templateNote(visitDay)).toContain('(possibly)');
  });
  it('renderDayFacts includes counts and times', () => {
    expect(renderDayFacts(visitDay)).toContain('Common Kingfisher ×2, first 17:31');
  });
});

describe('small helpers', () => {
  it('mentionsTime accepts 24h, 12h and zero-padded forms', () => {
    const t = new Date('2026-10-08T11:35:00Z'); // 17:05 IST
    expect(mentionsTime('leave by 17:05', t)).toBe(true);
    expect(mentionsTime('leave by 5:05 pm', t)).toBe(true);
    expect(mentionsTime('leave by 17:50', t)).toBe(false);
    expect(mentionsTime('at 07:40', new Date('2026-10-08T02:10:00Z'))).toBe(true);
  });
  it('firstSentences trims to 3', () => {
    expect(firstSentences('One. Two! Three? Four.')).toBe('One. Two! Three?');
    expect(firstSentences('No punctuation')).toBe('No punctuation');
  });
  it('quickRespond', () => {
    expect(quickRespond("Yes, let's go")).toBe('accept');
    expect(quickRespond('sure')).toBe('accept');
    expect(quickRespond('Not today, thanks')).toBe('decline');
    expect(quickRespond('No thanks')).toBe('decline');
    expect(quickRespond('how far is it?')).toBeUndefined();
  });
});
