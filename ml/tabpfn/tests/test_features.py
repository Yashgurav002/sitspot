"""Features + labelling on a small SYNTHETIC fixture (no network)."""
from datetime import date, datetime

import pandas as pd
import pytest

from features import FEATURES, build_features, dist_to_coast_km, feature_row, haversine_km, label, sun_times


def test_sun_times_mumbai():
    # Mumbai 6 Oct: sunrise ~06:27, sunset ~18:21 IST (published almanac values)
    rise, sset = sun_times(19.07, 72.88, date(2026, 10, 6))
    assert abs(rise - (6 * 60 + 27)) < 6
    assert abs(sset - (18 * 60 + 21)) < 6


def test_distances():
    assert haversine_km(19.0, 72.8, 19.0, 72.8) == 0
    assert 110 < haversine_km(19.0, 72.8, 20.0, 72.8) < 112
    assert dist_to_coast_km(19.098, 72.826) < 0.1      # Juhu beach
    assert dist_to_coast_km(19.24, 73.13) > 10          # Kalyan, inland


def test_feature_row_tide_trend_and_golden_hour():
    hourly = {"2025-10-01T06:00": {"tide_m": 0.1}, "2025-10-01T07:00": {"temp_c": 27.0, "tide_m": 0.4},
              "2025-10-01T08:00": {"tide_m": 0.9}}
    r = feature_row(19.4, 72.8, datetime(2025, 10, 1, 6, 50), hourly, 45, 1)
    assert set(FEATURES) <= set(r)
    assert r["temp_c"] == 27.0 and r["tide_trend"] == 1.0 and r["is_golden_hour"] == 1
    assert r["us_aqi"] is None  # missing history stays null, never invented


def fixture_checklists():
    """SYNTHETIC: hotspot A has 10 lists (own median), B has 2 (falls back to hour-band median)."""
    rows = [dict(checklist_id=f"A{i}", loc_id="A", lat=19.40, lon=72.80, protocol="traveling", duration_min=60,
                 obs_time=f"2024-10-{i + 1:02d}T07:00:00+05:30", num_species=10 + i, all_obs_reported=True)
            for i in range(10)]
    rows += [dict(checklist_id="B0", loc_id="B", lat=19.24, lon=73.13, protocol="stationary", duration_min=30,
                  obs_time="2024-10-01T07:30:00+05:30", num_species=30, all_obs_reported=True),
             dict(checklist_id="B1", loc_id="B", lat=19.24, lon=73.13, protocol="stationary", duration_min=30,
                  obs_time="2024-10-02T07:30:00+05:30", num_species=5, all_obs_reported=True),
             # filtered out: bad protocol, too short, too long, incomplete
             dict(checklist_id="X1", loc_id="A", lat=19.4, lon=72.8, protocol="incidental", duration_min=60,
                  obs_time="2024-10-03T07:00:00+05:30", num_species=50, all_obs_reported=True),
             dict(checklist_id="X2", loc_id="A", lat=19.4, lon=72.8, protocol="traveling", duration_min=10,
                  obs_time="2024-10-03T07:00:00+05:30", num_species=50, all_obs_reported=True),
             dict(checklist_id="X3", loc_id="A", lat=19.4, lon=72.8, protocol="traveling", duration_min=180,
                  obs_time="2024-10-03T07:00:00+05:30", num_species=50, all_obs_reported=True),
             dict(checklist_id="X4", loc_id="A", lat=19.4, lon=72.8, protocol="traveling", duration_min=60,
                  obs_time="2024-10-03T07:00:00+05:30", num_species=50, all_obs_reported=False)]
    return pd.DataFrame(rows)


def test_label_rule():
    df = label(fixture_checklists()).set_index("checklist_id")
    assert not df.index.str.startswith("X").any()
    # hotspot A: median of 10..19 = 14.5
    assert df.loc[[f"A{i}" for i in range(10)], "rich"].tolist() == [0] * 5 + [1] * 5
    # B (<10 lists): dawn band median over all 12 kept rows = 14.5 -> 30 rich, 5 not
    assert df.loc["B0", "rich"] == 1 and df.loc["B1", "rich"] == 0


def test_build_features_uses_grid_and_fetcher():
    calls = []

    def fake_fetch(lat, lon, start, end):  # SYNTHETIC weather, stands in for Open-Meteo
        calls.append((lat, lon))
        return {f"2024-10-{d:02d}T{h:02d}:00": {"temp_c": 28.0, "us_aqi": 90.0}
                for d in range(1, 12) for h in range(24)}

    out = build_features(label(fixture_checklists()), fetch=fake_fetch)
    assert sorted(calls) == [(19.2, 73.1), (19.4, 72.8)]  # one call per 0.1-degree cell per year
    assert len(out) == 12 and (out["temp_c"] == 28.0).all()
    assert out.loc[out.loc_id == "A", "is_traveling"].eq(1).all()
    assert out["tide_m"].isna().all()


def test_unknown_effort_rows_kept_with_nan_features():
    feed = fixture_checklists().iloc[:3].assign(duration_min=float("nan"), protocol=None, all_obs_reported=None)
    feed["checklist_id"] = ["F0", "F1", "F2"]
    df = label(pd.concat([fixture_checklists(), feed], ignore_index=True)).set_index("checklist_id")
    assert {"F0", "F1", "F2"} <= set(df.index) and not df.index.str.startswith("X").any()
    out = build_features(df.reset_index(), fetch=lambda *a: {}).set_index("checklist_id")
    assert out.loc[["F0", "F1", "F2"], ["duration_min", "is_traveling"]].isna().all().all()
    assert out.loc[["F0", "F1", "F2"], "effort_known"].eq(0).all()
    assert out.drop(["F0", "F1", "F2"])["effort_known"].eq(1).all()
