# @sitspot/policy

Pure decision and safety policy (spec §3.5–3.6, PRD §6.3–6.4). It does no I/O and never reads the clock; `now` is always passed in. Every weight and threshold lives in `src/config.ts`.

## Judgment calls

- **Missing data in comfort.** A missing AQI or precipitation reading gives a factor of 1. A missing apparent temperature falls back to `temp_c`. If both are missing, the temperature factor is 0.5, a penalty that is neither a crash nor a pass. A missing value never triggers S-4, because the rule is "≥ 38 / ≥ 200" and an unknown value isn't known to meet it.
- **Comfort curves.** Temperature is linear from 30 °C (1.0) to 38 °C (0). AQI is piecewise linear: 100 → 1, 150 → 0.5, 200 → 0. Precipitation is cut off only above 2 mm, so exactly 2 mm still passes.
- **tideFit.** `hoursToLow` is the distance to the nearest low on either side. The factor is 0 within 60 min of a high. It is 0.6 within 1 h of a low, whether the tide is rising or falling. It is 1.0 when the tide is falling and 1–3 h before the low. Everything else gets 0.2: rising, or falling but more than 3 h from the low. A coastal spot with no tide data gets 0.
- **Trend** comes from the next tide event: if the next event is a low, the tide is falling. When there is no next event, the previous one decides.
- **lightBonus** is `1 + 0.3 × (the fraction of the 60-min window that falls in [sunrise, goldenHourEnd] ∪ [goldenHourStart, sunset])`.
- **novelty.** `true` gives 1.3. A count `n` gives `1 + 0.15n`, capped at 1.3.
- **Fail-closed safety.** For a coastal spot, missing sun times trigger S-1 and an empty high-tide list triggers S-2. Quiet-hour strings that can't be parsed are treated as quiet all day.
- **S-5 covers the call itself.** Quiet hours are checked over `[send_at, window_end]`, not just the window. A 07:00 window with 20 min of travel would otherwise ring the phone at 06:30.
- **Quiet hours** run from start (inclusive) to end (exclusive) in the user's timezone (default `Asia/Kolkata`), and they wrap past midnight. When start equals end, there are no quiet hours.
- **The decline cooldown** is measured from `now`, not from the window. The 2-per-day cap uses `history.invitesToday` as the caller gives it.
- **Windows** start at the next local top of the hour (an IST :00, which is UTC :30). There are 6 of them, each 60 min long. Conditions and forecasts are matched to the row nearest `window_start` that is less than 60 min away. Tide state is taken at the window midpoint.
- **pickInvitation** takes `now` as a required argument and re-checks `safe`, empty `blocked_by`, `availability > 0`, `score ≥ threshold` and `send_at ≥ now`.
- **sunFor(spotId, window_start)** should return the sun times for the local day that contains that instant.

S-3 (the script must say "Stay on firm ground") is enforced by the agent using `coastalSafetyLine` and `requiresSafetyLine(kind)`.
