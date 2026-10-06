export type Species = { scientific_name: string; common_name: string };

/** BirdNET label line: "Pycnonotus cafer_Red-vented Bulbul". Split on the first "_". */
export function parseLabel(line: string): Species {
  const s = line.trim();
  const i = s.indexOf("_");
  if (i < 0) return { scientific_name: s, common_name: s };
  return { scientific_name: s.slice(0, i), common_name: s.slice(i + 1) };
}

/** Accepts labels.json (string[]) or a labels .txt (one label per line). */
export function parseLabels(src: string[] | string): Species[] {
  const lines = typeof src === "string" ? src.split(/\r?\n/).filter((l) => l.trim()) : src;
  return lines.map(parseLabel);
}
