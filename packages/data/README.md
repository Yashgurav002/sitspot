# @sitspot/data

Data pullers (Open-Meteo weather / air quality / marine, eBird recent observations), suncalc sun times, and derived features. Spec §3.4, §11.

## API

```ts
fetchWeather(lat, lon, { fetch?, ttlMs? })      // Hourly<temperature_2m|apparent_temperature|relative_humidity_2m|wind_speed_10m|precipitation|cloud_cover>
fetchAirQuality(lat, lon, { fetch?, ttlMs? })   // Hourly<pm2_5|pm10|us_aqi>
fetchMarine(lat, lon, { fetch?, ttlMs? })       // Hourly<sea_level_height_msl>
fetchConditions(spot: {id, lat, lon, kind}, { fetch?, ttlMs?, now? }) // ConditionsHour[]
fetchRecentSightings(lat, lon, apiKey, { dist = 5, back = 7, fetch?, ttlMs? }) // Sighting[]
sunTimes(date, lat, lon)                        // SunTimes for the IST day containing `date`
minutesFromSunrise(time, lat, lon) / minutesToSunset(time, lat, lon) / isGoldenHour(time, lat, lon)
tideTrend(rows, time)                           // 'rising' | 'falling' | null
nextLowTide(rows, after) / nextHighTide(rows, after)   // { time, tide_m } | null
hoursToLowTide(rows, time) / hoursToHighTide(rows, time) // number | null
clearCache()
```

`Hourly<V>` = `Array<{ time: Date } & Record<V, number | null>>`. All `Date`s are real UTC instants.

## Decisions

- **Timezone**: requests use `timezone=GMT`, so Open-Meteo times are UTC wall-clock; we parse `t + "Z"` and still subtract `utc_offset_seconds` (so a request with `Asia/Kolkata` would also parse correctly — tested).
- **Merge**: `fetchConditions` uses the weather time axis. Weather failure throws; air/marine failures give null fields. Marine is called only for `kind === 'coastal'`. `is_forecast = time > now`.
- **Cache**: in-memory `Map` keyed by URL, default TTL 15 min, `ttlMs: 0` disables. Per process only.
- **Sun**: suncalc evaluated at local (IST) noon of the IST date, otherwise early-morning IST times pick the previous UTC day. Golden hour = sunrise→`goldenHourEnd` or `goldenHour`→sunset (suncalc's sun-below-6° definition).
- **Tide extrema**: hourly local minima/maxima of `tide_m`, so they're accurate to the hour only. No interpolation.

## Verified live (2026-10-06)

Captured with `curl` → `test/fixtures/*.json`, one file per API:

| Fixture | Request | Result |
| --- | --- | --- |
| `weather.json` | forecast API, Vasai 19.37,72.81 | all 6 variable names are valid, 48 rows, 0 nulls, `wind_speed_10m` in m/s |
| `air.json` | air-quality API | `pm2_5`, `pm10`, `us_aqi` are valid, 0 nulls (grid cell snaps to 19.40,72.80) |
| `marine_creek.json` | marine API, 19.37,72.81 | `sea_level_height_msl` is valid, unit m, 0 nulls (snaps to 19.375,72.792) |
| `marine_arnala.json` | marine API, 19.47,72.73 (sea near Arnala) | valid, 0 nulls (snaps to 19.458,72.708) |

`LIVE=1 pnpm --filter @sitspot/data test` passed against the real APIs.

**How useful the tide data is**
- The variable `sea_level_height_msl` is correct. The spec's guess was right.
- It shows a clean semidiurnal tide: two highs and two lows a day, about 6 h apart. On 2026-10-06 the highs were at 03:00Z and 15:00Z and the lows at 09:00Z and 21:00Z. Range over 48 h was about −1.0 to +1.8 m.
- The creek and Arnala points are almost the same (values within about 0.1 m). The model shows the open coast, not the creek. The creek's own timing lag and amplification are not modelled.
- The datum is global mean sea level, not chart datum. The amplitude (about 2.8 m peak to trough) also looks smaller than published Mumbai spring ranges (about 4–5 m). That is not checked against tide tables. **Use it for timing (trend, next low or high), not for absolute heights.**
- Open-Meteo's docs say: "Accuracy is limited in coastal areas—while it can be reasonably accurate near unobstructed coasts, it may be completely unreliable further inland. This data is not suitable for coastal navigation." Source: MeteoFrance SMOC, 0.08° (~8 km), 3-hourly, available from Oct 2021.
- `past_days=92` returned 2208 hourly rows with no nulls, so there is history for TabPFN features.

## eBird: NOT verified live

We have no `EBIRD_API_KEY` yet. Without one, the endpoint returns `403`, which was checked. The client follows the eBird API 2.0 Postman docs ("Recent nearby observations"): `GET /v2/data/obs/geo/recent?lat&lng&dist&back` with the header `X-eBirdApiToken`.

`test/fixtures/ebird_recent.json` is copied **word for word from the docs' example response**, not from a real call. Fields used: `speciesCode`, `comName`, `locId`, `obsDt`, `howMany`, `lat`, `lng`.
- `subId` is not in the doc example. It is mapped to `checklist_id` only when present, otherwise null.
- `howMany` can be missing (count recorded as "X"), which gives null.
- `obsDt` is local time at the location, `"YYYY-MM-DD HH:mm"` or a date only. It is parsed as IST (+05:30).
- The docs say this endpoint returns only the **most recent observation per species**, so it is not a full list of sightings.

To do once a key exists: run one real call, save it over the fixture, and confirm `subId` is present.
