// All policy weights and thresholds (spec §3.5, §3.6). Tune here, nowhere else.
export const CONFIG = {
  comfort: {
    tempFullC: 30, // factor 1.0 at or below
    tempZeroC: 38, // factor 0 at or above (linear in between)
    missingTempFactor: 0.5, // apparent AND air temp unknown -> penalise, don't crash
    aqiFull: 100, // 1.0 at or below
    aqiHalf: 150, // 0.5
    aqiZero: 200, // 0 at or above (piecewise linear between points)
    precipMaxMm: 2, // > this per hour -> 0
  },
  tide: {
    best: 1.0, // falling, 1..3 h before low
    nearLow: 0.6, // within 1 h of a low (either side)
    rising: 0.2, // rising, or falling but > 3 h from low
    highMargin: 0, // within highTideMarginMin of a high
    bestFromH: 1,
    bestToH: 3,
  },
  highTideMarginMin: 60,
  light: { max: 1.3 },
  novelty: { max: 1.3, perSighting: 0.15, withinHours: 48 },
  availability: {
    maxInvitesPerDay: 2,
    declineCooldownMin: 180,
    acceptFactorMin: 0.5,
    acceptFactorMax: 1.5,
  },
  safety: {
    sunsetBufferMin: 30,
    maxApparentC: 38,
    maxAqi: 200,
  },
  defaultThreshold: 0.35,
  horizonHours: 6,
  windowMin: 60,
  sendLeadMin: 10,
  prior: { p_rich: 0.5, model: "prior" },
  coastalSafetyLine: "Stay on firm ground",
} as const;
