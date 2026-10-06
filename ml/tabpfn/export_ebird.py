"""Export eBird checklists (real data only) for the TabPFN training table.

Uses eBird API 2.0 with header X-eBirdApiToken=$EBIRD_API_KEY:
  product/lists/{region}/{y}/{m}/{d}   checklist feed for a date
  product/checklist/view/{subId}       duration, protocol, species
  ref/hotspot/info/{locId}             hotspot lat/lon (fallback when the feed lacks it)
Every HTTP response is cached under cache/http/, uncached calls are throttled to 1 req/s.

  python export_ebird.py --start 2022-09-01 --end 2025-12-31 --max 8000
  python export_ebird.py --feed-only --merge --start 2022-09-01 --end 2026-10-05
      feed only: one call per region-day, no checklist/view (effort columns empty);
      --merge uses an already-cached checklist/view when there is one
  python export_ebird.py --list-regions IN-MH     # verify district codes
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
EBIRD = "https://api.ebird.org/v2"
# Verified 2026-10-06 via `--list-regions IN-MH`: Palghar, Thane, Mumbai City, Mumbai Suburban.
DEFAULT_REGIONS = "IN-MH-PG,IN-MH-TH,IN-MH-MC,IN-MH-MS"
PROTOCOLS = {"P21": "stationary", "P22": "traveling"}
COLUMNS = ["checklist_id", "loc_id", "lat", "lon", "obs_time", "duration_min", "protocol",
           "num_species", "all_obs_reported", "region"]

_last_call = 0.0


def cache_path(url: str, params: dict | None = None) -> Path:
    key = hashlib.sha1(json.dumps([url, sorted((params or {}).items())]).encode()).hexdigest()
    return CACHE / "http" / f"{key}.json"


def cached_get(url: str, params: dict | None = None, headers: dict | None = None,
               min_interval: float = 2.0):
    """GET JSON with an on-disk cache (key excludes headers, so tokens never hit disk)."""
    global _last_call
    path = cache_path(url, params)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    wait = min_interval - (time.monotonic() - _last_call)
    if wait > 0:
        time.sleep(wait)
    for attempt in range(1, 7):
        _last_call = time.monotonic()
        try:
            r = requests.get(url, params=params, headers=headers, timeout=60)
        except (requests.ConnectionError, requests.Timeout) as e:
            if attempt == 6:
                raise
            print(f"{type(e).__name__}, retrying in {30 * attempt}s (attempt {attempt})", file=sys.stderr)
            time.sleep(30 * attempt)
            continue
        if r.status_code not in (429, 500, 502, 503, 504) or attempt == 6:
            break
        # eBird rate-limits even at 1 req/s; back off (honour Retry-After when given).
        pause = float(r.headers.get("Retry-After") or 60 * attempt)
        print(f"HTTP {r.status_code}, backing off {pause:.0f}s (attempt {attempt})", file=sys.stderr)
        time.sleep(pause)
    r.raise_for_status()  # failures are not cached
    data = r.json()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return data


def _ebird(path: str, key: str, **params):
    return cached_get(f"{EBIRD}/{path}", params or None, {"X-eBirdApiToken": key})


def checklist_row(item: dict, view: dict, key: str, region: str) -> dict | None:
    if not view.get("obsTimeValid", True) or "durationHrs" not in view:
        return None  # no start time or no effort -> unusable for hour/duration features
    loc = item.get("loc") or {}
    lat, lon = loc.get("latitude", loc.get("lat")), loc.get("longitude", loc.get("lng"))
    loc_id = view.get("locId") or item.get("locId")
    if lat is None:
        try:
            info = _ebird(f"ref/hotspot/info/{loc_id}", key)
            lat, lon = info.get("latitude"), info.get("longitude")
        except requests.HTTPError:
            return None  # personal location: the API does not expose coordinates
    species = {o["speciesCode"] for o in view.get("obs", []) if o.get("speciesCode")}
    return {
        "checklist_id": view.get("subId") or item.get("subId"),
        "loc_id": loc_id, "lat": lat, "lon": lon,
        "obs_time": view["obsDt"].replace(" ", "T") + ":00+05:30",  # eBird obsDt is local time
        "duration_min": round(float(view["durationHrs"]) * 60),
        "protocol": PROTOCOLS.get(view.get("protocolId"), view.get("protocolId")),
        "num_species": item.get("numSpecies") or len(species),
        "all_obs_reported": bool(view.get("allObsReported")),
        "region": region,
    }


def feed_row(item: dict, key: str, region: str) -> dict | None:
    """Row from a product/lists item alone. Feed items carry loc.latitude/longitude, numSpecies,
    isoObsDate ('YYYY-MM-DD HH:MM', local) and obsTime (absent when no start time was entered,
    then isoObsDate shows a fake 00:00). Effort (duration/protocol/complete) is not in the feed."""
    if not item.get("obsTime") or item.get("numSpecies") is None:
        return None
    loc = item.get("loc") or {}
    loc_id = item.get("locId") or loc.get("locId")
    lat, lon = loc.get("latitude", loc.get("lat")), loc.get("longitude", loc.get("lng"))
    if lat is None:
        if not loc.get("isHotspot"):
            return None  # personal location: the API does not expose coordinates
        try:  # cached per locId by cached_get
            info = _ebird(f"ref/hotspot/info/{loc_id}", key)
            lat, lon = info.get("latitude"), info.get("longitude")
        except requests.HTTPError:
            return None
    return {"checklist_id": item.get("subId") or item.get("subID"), "loc_id": loc_id, "lat": lat, "lon": lon,
            "obs_time": item["isoObsDate"].replace(" ", "T") + ":00+05:30",
            "duration_min": None, "protocol": None, "num_species": int(item["numSpecies"]),
            "all_obs_reported": None, "region": region}


def cached_view(sub: str) -> dict | None:
    """checklist/view from the HTTP cache only (never a network call)."""
    path = cache_path(f"{EBIRD}/product/checklist/view/{sub}")
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def export(regions: list[str], start: date, end: date, months: set[int], max_rows: int,
           key: str, out: Path, stride: int = 1, feed_only: bool = False, merge: bool = False) -> int:
    rows, seen = [], set()
    try:
        d = start
        while d <= end and len(rows) < max_rows:
            if d.month in months:
                for region in regions:
                    feed = _ebird(f"product/lists/{region}/{d.year}/{d.month}/{d.day}", key,
                                  maxResults=200)  # API maximum is 200 per call
                    if len(feed) >= 200:
                        print(f"note: {region} {d} feed hit the 200 cap, some checklists missed", file=sys.stderr)
                    for item in feed:
                        sub = item.get("subId") or item.get("subID")
                        if not sub or sub in seen:
                            continue
                        seen.add(sub)
                        if feed_only:
                            view = cached_view(sub) if merge else None
                            row = checklist_row(item, view, key, region) if view else feed_row(item, key, region)
                        else:
                            row = checklist_row(item, _ebird(f"product/checklist/view/{sub}", key), key, region)
                        if row:
                            rows.append(row)
                        if len(rows) >= max_rows:
                            break
                print(f"{d} rows={len(rows)}", file=sys.stderr)
            d += timedelta(days=stride)
    finally:  # Ctrl-C keeps what we have; the HTTP cache makes reruns cheap
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, COLUMNS)
            w.writeheader()
            w.writerows(rows)
    return len(rows)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--regions", default=DEFAULT_REGIONS)
    p.add_argument("--start", default="2022-09-01")
    p.add_argument("--end", default=str(date.today()))
    p.add_argument("--months", default="9,10,11,12", help="only dates in these months (Sep-Dec season)")
    p.add_argument("--max", type=int, default=8000)
    p.add_argument("--out", default=str(CACHE / "checklists.csv"))
    p.add_argument("--stride", type=int, default=1,
                   help="sample every Nth day so every season (incl. the latest test season) is covered")
    p.add_argument("--feed-only", action="store_true",
                   help="rows from the daily feed only (1 call per region-day); no duration/protocol")
    p.add_argument("--merge", action="store_true",
                   help="with --feed-only: use cached checklist/view details when available")
    p.add_argument("--list-regions", metavar="PARENT", help="print subnational2 codes of PARENT and exit")
    a = p.parse_args(argv)
    key = os.environ.get("EBIRD_API_KEY")
    if not key:
        sys.exit("EBIRD_API_KEY is not set. Get a free key at https://ebird.org/api/keygen. No data is faked.")
    if a.list_regions:
        for r in _ebird(f"ref/region/list/subnational2/{a.list_regions}", key):
            print(r["code"], r["name"])
        return
    n = export(a.regions.split(","), date.fromisoformat(a.start), date.fromisoformat(a.end),
               {int(m) for m in a.months.split(",")}, a.max, key, Path(a.out), a.stride, a.feed_only, a.merge)
    print(f"wrote {n} checklists to {a.out}")


if __name__ == "__main__":
    main()
