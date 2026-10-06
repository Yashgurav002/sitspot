"""Feed-only rows from a REAL eBird product/lists response (user names removed, personal
location names redacted and coordinates rounded to 0.01 deg)."""
import json
from pathlib import Path

import pandas as pd

import export_ebird
from export_ebird import COLUMNS, feed_row

FEED = json.loads((Path(__file__).parent / "fixtures" / "ebird_feed_sample.json").read_text(encoding="utf-8"))


def test_feed_row_from_real_feed():
    rows = [feed_row(it, "KEY", "IN-MH-MC") for it in FEED]
    assert all(r is not None and set(r) == set(COLUMNS) for r in rows)
    r = rows[0]
    assert r["checklist_id"] == "S121487450" and r["loc_id"] == FEED[0]["locId"]
    assert r["obs_time"] == "2022-10-28T14:15:00+05:30" and r["num_species"] == 31
    assert (r["lat"], r["lon"]) == (FEED[0]["loc"]["latitude"], FEED[0]["loc"]["longitude"])
    assert r["duration_min"] is None and r["protocol"] is None and r["all_obs_reported"] is None
    assert not FEED[1]["loc"]["isHotspot"] and rows[1]["lat"] == 18.91  # personal location keeps feed coords


def test_feed_row_skips_missing_time_and_personal_without_coords(monkeypatch):
    no_time = {**FEED[0], "isoObsDate": "2022-10-28 00:00"}
    no_time.pop("obsTime")
    assert feed_row(no_time, "KEY", "IN-MH-MC") is None  # 00:00 is eBird's placeholder, not a time
    calls = []
    monkeypatch.setattr(export_ebird, "_ebird", lambda path, key, **p: calls.append(path) or
                        {"latitude": 1.0, "longitude": 2.0})
    personal = {**FEED[1], "loc": {"locId": FEED[1]["locId"], "isHotspot": False}}
    assert feed_row(personal, "KEY", "IN-MH-MC") is None and calls == []  # no call for personal locs
    hotspot = {**FEED[0], "loc": {"locId": FEED[0]["locId"], "isHotspot": True}}
    assert feed_row(hotspot, "KEY", "IN-MH-MC")["lat"] == 1.0
    assert calls == [f"ref/hotspot/info/{FEED[0]['locId']}"]


def test_export_feed_only_merge_prefers_cached_details(monkeypatch, tmp_path):
    from datetime import date
    view = {"subId": "S121487450", "locId": FEED[0]["locId"], "obsDt": "2022-10-28 14:15",
            "durationHrs": 1.0, "protocolId": "P22", "allObsReported": True, "obs": []}
    monkeypatch.setattr(export_ebird, "_ebird", lambda path, key, **p: FEED)  # the feed call
    monkeypatch.setattr(export_ebird, "cached_view", lambda sub: view if sub == "S121487450" else None)
    out = tmp_path / "c.csv"
    n = export_ebird.export(["IN-MH-MC"], date(2022, 10, 28), date(2022, 10, 28), {10}, 100, "KEY", out,
                            feed_only=True, merge=True)
    df = pd.read_csv(out).set_index("checklist_id")
    assert n == 3
    assert df.loc["S121487450", "duration_min"] == 60 and df.loc["S121487450", "protocol"] == "traveling"
    assert df.drop("S121487450")["duration_min"].isna().all()
