"""Checklists -> one feature row per checklist + `rich` label (spec §12 steps 2-3).

  python features.py [--in cache/checklists.csv] [--out cache/training.csv] [--to-db]

Weather (Open-Meteo archive), US AQI (air-quality API) and tide (marine API) are fetched per
0.1-degree grid cell and year, cached on disk. AQI/tide become null when the API has no history.
Feed-only rows (export_ebird.py --feed-only) have no duration/protocol: those features are NaN and
effort_known = 0. They are kept; the label is noisier for them (long checklists find more species).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from export_ebird import CACHE, HERE, cached_get

FEATURES = ["hour", "day_of_year", "minutes_from_sunrise", "minutes_to_sunset", "is_golden_hour",
            "temp_c", "apparent_c", "rh_pct", "wind_ms", "precip_mm", "cloud_pct", "us_aqi",
            "tide_m", "tide_trend", "dist_to_coast_km", "duration_min", "is_traveling", "effort_known"]
WX_VARS = {"temperature_2m": "temp_c", "apparent_temperature": "apparent_c",
           "relative_humidity_2m": "rh_pct", "wind_speed_10m": "wind_ms",
           "precipitation": "precip_mm", "cloud_cover": "cloud_pct"}
IST_HOURS = 5.5

# Hand-picked shoreline points (approximate, read off a map), Colaba -> Arnala, plus two
# Thane-creek mudflat points (Sewri, Airoli) because creek shore matters for waders.
COAST = [(18.906, 72.814), (18.925, 72.820), (18.954, 72.814), (18.983, 72.811), (19.010, 72.815),
         (19.047, 72.818), (19.098, 72.826), (19.135, 72.810), (19.180, 72.795), (19.235, 72.785),
         (19.285, 72.783), (19.320, 72.800), (19.380, 72.785), (19.420, 72.770), (19.465, 72.735),
         (18.998, 72.861), (19.150, 72.985)]


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def dist_to_coast_km(lat, lon):
    return min(haversine_km(lat, lon, a, b) for a, b in COAST)


def sun_times(lat: float, lon: float, d: date, tz_hours: float = IST_HOURS):
    """Sunrise/sunset in local minutes after midnight (NOAA approximation, ~1-2 min error)."""
    g = 2 * math.pi / 365 * (d.timetuple().tm_yday - 1)
    eqt = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
                    - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    decl = (0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g)
            + 0.000907 * math.sin(2 * g) - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g))
    la = math.radians(lat)
    ha = math.degrees(math.acos(math.cos(math.radians(90.833)) / (math.cos(la) * math.cos(decl))
                                - math.tan(la) * math.tan(decl)))
    noon = 720 - 4 * lon - eqt + tz_hours * 60
    return noon - 4 * ha, noon + 4 * ha


def hour_key(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:00")


def feature_row(lat: float, lon: float, t: datetime, hourly: dict, duration_min: float,
                is_traveling: int) -> dict:
    """t is local (IST) naive time; hourly maps 'YYYY-MM-DDTHH:00' -> {temp_c, ..., us_aqi, tide_m}.
    duration_min/is_traveling None or NaN = effort unknown (feed-only row)."""
    known = duration_min is not None and not pd.isna(duration_min)
    near = (t + timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0)
    wx = hourly.get(hour_key(near), {})
    rise, sset = sun_times(lat, lon, t.date())
    m = t.hour * 60 + t.minute
    before = hourly.get(hour_key(near - timedelta(hours=1)), {}).get("tide_m")
    after = hourly.get(hour_key(near + timedelta(hours=1)), {}).get("tide_m")
    return {
        "hour": t.hour, "day_of_year": t.timetuple().tm_yday,
        "minutes_from_sunrise": m - rise, "minutes_to_sunset": sset - m,
        "is_golden_hour": int(0 <= m - rise <= 60 or 0 <= sset - m <= 60),
        **{k: wx.get(k) for k in [*WX_VARS.values(), "us_aqi", "tide_m"]},
        "tide_trend": None if before is None or after is None else float(np.sign(after - before)),
        "dist_to_coast_km": dist_to_coast_km(lat, lon),
        "duration_min": float(duration_min) if known else np.nan,
        "is_traveling": is_traveling if known else np.nan, "effort_known": int(known),
    }


def _series(url, params, var_map):
    try:
        h = cached_get(url, params, min_interval=0.2)["hourly"]
    except (requests.RequestException, KeyError, ValueError) as e:
        print(f"warn: {url} {params['latitude']},{params['longitude']} -> {e}", file=sys.stderr)
        return {}
    out = {}
    for i, t in enumerate(h["time"]):
        out[t] = {dst: h[src][i] for src, dst in var_map.items() if h.get(src) is not None}
    return out


def fetch_hourly(lat: float, lon: float, start: date, end: date) -> dict:
    """Real history for one grid cell: archive weather + AQI + tide (coastal cells only)."""
    base = {"latitude": lat, "longitude": lon, "start_date": str(start), "end_date": str(end),
            "timezone": "Asia/Kolkata"}
    hourly = _series("https://archive-api.open-meteo.com/v1/archive",
                     {**base, "hourly": ",".join(WX_VARS), "wind_speed_unit": "ms"}, WX_VARS)
    extra = [("https://air-quality-api.open-meteo.com/v1/air-quality", "us_aqi", "us_aqi")]
    if dist_to_coast_km(lat, lon) < 15:
        extra.append(("https://marine-api.open-meteo.com/v1/marine", "sea_level_height_msl", "tide_m"))
    for url, src, dst in extra:
        for t, v in _series(url, {**base, "hourly": src}, {src: dst}).items():
            hourly.setdefault(t, {}).update(v)
    return hourly


def build_features(df: pd.DataFrame, fetch=fetch_hourly) -> pd.DataFrame:
    df = df.copy()
    local = pd.to_datetime(df["obs_time"], utc=True).dt.tz_convert("Asia/Kolkata").dt.tz_localize(None)
    df["_t"], df["_year"] = local, local.dt.year
    df["_cell_lat"], df["_cell_lon"] = df["lat"].round(1), df["lon"].round(1)
    rows = {}
    for (clat, clon, _), g in df.groupby(["_cell_lat", "_cell_lon", "_year"]):
        hourly = fetch(clat, clon, g["_t"].min().date(), (g["_t"].max() + timedelta(hours=2)).date())
        for idx, r in g.iterrows():
            rows[idx] = feature_row(r.lat, r.lon, r["_t"].to_pydatetime(), hourly, r.duration_min,
                                    np.nan if pd.isna(r.protocol) else int(r.protocol == "traveling"))
    feats = pd.DataFrame.from_dict(rows, orient="index")[FEATURES]
    return pd.concat([df.drop(columns=[c for c in df if c.startswith("_")]), feats], axis=1)


def hour_band(hour):
    return np.digitize(hour, [8, 11, 15, 18])  # 0 dawn <8, 1 morning, 2 midday, 3 afternoon, 4 dusk >=18


def label(df: pd.DataFrame) -> pd.DataFrame:
    """Filter protocols/duration, then rich = num_species >= hotspot median (>=10 checklists)
    else >= regional median for the hour band. Rows with unknown effort (feed-only: duration and
    protocol empty) are kept unfiltered - we cannot tell an incidental or 5-min list from a 2-h one."""
    unknown = df["duration_min"].isna() & df["protocol"].isna()
    keep = df["protocol"].isin(["stationary", "traveling"]) & df["duration_min"].between(15, 120)
    if "all_obs_reported" in df:
        keep &= df["all_obs_reported"].astype(str).str.lower().isin(["true", "1"])
    keep |= unknown
    df = df[keep].copy()
    hour = pd.to_datetime(df["obs_time"], utc=True).dt.tz_convert("Asia/Kolkata").dt.hour
    df["hour_band"] = hour_band(hour)
    n = df.groupby("loc_id")["loc_id"].transform("size")
    med = np.where(n >= 10, df.groupby("loc_id")["num_species"].transform("median"),
                   df.groupby("hour_band")["num_species"].transform("median"))
    df["rich"] = (df["num_species"] >= med).astype(int)
    return df


def to_db(df: pd.DataFrame, url: str):
    import psycopg
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        for r in df.itertuples():
            feats = {k: (None if pd.isna(getattr(r, k)) else float(getattr(r, k)))
                     for k in [*FEATURES, "rich", "hour_band"]}
            cur.execute(
                """insert into training_checklists
                   (checklist_id, loc_id, lat, lon, obs_time, duration_min, protocol, num_species, features)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   on conflict (checklist_id) do update set features = excluded.features,
                     num_species = excluded.num_species""",
                (r.checklist_id, r.loc_id, r.lat, r.lon, r.obs_time,
                 None if pd.isna(r.duration_min) else int(r.duration_min), None if pd.isna(r.protocol) else r.protocol,
                 int(r.num_species), json.dumps(feats)))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--in", dest="inp", default=str(CACHE / "checklists.csv"))
    p.add_argument("--out", default=str(CACHE / "training.csv"))
    p.add_argument("--to-db", action="store_true", help="also upsert into training_checklists ($DATABASE_URL)")
    a = p.parse_args(argv)
    if not Path(a.inp).exists():
        sys.exit(f"{a.inp} not found - run export_ebird.py first (needs EBIRD_API_KEY).")
    df = build_features(label(pd.read_csv(a.inp)))
    df.to_csv(a.out, index=False)
    print(f"wrote {len(df)} rows ({df['rich'].mean():.2f} rich, {int(df['effort_known'].sum())} with effort) to {a.out}")
    # Small copy for forecast_job (committable): features + label only, no ids, times or coordinates
    # (personal eBird locations can be someone's home).
    slim = HERE / "training.csv"
    df[[*FEATURES, "rich"]].to_csv(slim, index=False, float_format="%.4g")
    mb = slim.stat().st_size / 1e6
    print(f"wrote {slim} ({mb:.2f} MB){'  - over 2 MB, keep it out of git' if mb > 2 else ''}")
    if a.to_db:
        if not os.environ.get("DATABASE_URL"):
            sys.exit("--to-db needs DATABASE_URL (Postgres).")
        to_db(df, os.environ["DATABASE_URL"])


if __name__ == "__main__":
    main()
