"""Hourly job: p_rich for every spot x next 12 hours -> forecasts table.

  DATABASE_URL=postgres://... python forecast_job.py [--train cache/training.csv] [--dry-run]
  CRON_SECRET=... python forecast_job.py --api http://localhost:8787 [--train ...] [--dry-run]

DB mode: training rows come from training_checklists (features jsonb incl. `rich`, written by
`features.py --to-db`), else from --train CSV. API mode (--api or SITSPOT_API_URL; works with the
local PGlite DB): input from GET /cron/forecast-input, training from --train CSV, results POSTed to
/cron/forecast-ingest. Only hours that have a conditions row are scored.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from features import FEATURES, feature_row, hour_key
from train_eval import TABPFN_MAX_TRAIN, make_tabpfn, stratified_subsample, tabpfn_version

HERE = Path(__file__).resolve().parent
IST = timezone(timedelta(hours=5, minutes=30))
COND_COLS = ["temp_c", "apparent_c", "rh_pct", "wind_ms", "precip_mm", "cloud_pct", "us_aqi", "tide_m"]


def load_training(conn, csv_path: Path) -> pd.DataFrame:
    """conn=None (API mode): CSV only."""
    rows = conn.execute("select features from training_checklists where features ? 'rich'").fetchall() if conn else []
    if len(rows) >= 100:
        return pd.DataFrame([r[0] for r in rows])
    if csv_path.exists():
        return pd.read_csv(csv_path)
    sys.exit(f"No training data: training_checklists is empty and no training CSV at {csv_path}. "
             "Run export_ebird.py + features.py first (needs EBIRD_API_KEY).")


def predict(train: pd.DataFrame, rows: pd.DataFrame):
    train = train.dropna(subset=["rich"])
    sub = stratified_subsample(train, TABPFN_MAX_TRAIN)
    model = make_tabpfn().fit(sub[FEATURES].astype(float).to_numpy(), sub["rich"].astype(int).to_numpy())
    return model.predict_proba(rows[FEATURES].astype(float).to_numpy())[:, 1]


def http_json(method: str, url: str, secret: str, body=None):
    req = urllib.request.Request(
        url, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={"x-cron-secret": secret, "content-type": "application/json",
                 "ngrok-skip-browser-warning": "1"})  # harmless elsewhere; skips ngrok's free-tier interstitial
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def run_api(api: str, secret: str, train_csv: Path, dry_run=False, http=http_json, predict_fn=None):
    """GET /cron/forecast-input -> build_rows -> predict -> POST /cron/forecast-ingest. Returns the payload."""
    api = api.rstrip("/")
    inp = http("GET", f"{api}/cron/forecast-input?hours=12", secret)
    spots = [(s["id"], s["lat"], s["lon"]) for s in inp["spots"]]
    conds = [(c["spot_id"], datetime.fromisoformat(c["time"].replace("Z", "+00:00")), *(c.get(k) for k in COND_COLS))
             for c in inp["conditions"]]
    rows = build_rows(spots, conds)
    if rows.empty:
        sys.exit("no conditions rows for the next 12 h - run /cron/pull first.")
    rows["p_rich"] = (predict_fn or (lambda r: predict(load_training(None, train_csv), r)))(rows)
    version = f"tabpfn-{tabpfn_version()}-{date.today()}"
    print(rows[["spot_id", "time", "p_rich"]].to_string(index=False))
    payload = [{"time": r.time.isoformat(), "spot_id": r.spot_id, "p_rich": float(r.p_rich), "model_version": version}
               for r in rows.itertuples()]
    if not dry_run:
        print("ingest:", http("POST", f"{api}/cron/forecast-ingest", secret, payload))
    return payload


def build_rows(spots, conditions) -> pd.DataFrame:
    """spots: [(id, lat, lon)]; conditions: [(spot_id, time_utc, *COND_COLS)] for now-1h..now+13h."""
    hourly = {}
    for spot_id, t, *vals in conditions:
        hourly.setdefault(spot_id, {})[hour_key(t.astimezone(IST))] = dict(zip(COND_COLS, vals))
    now = pd.Timestamp.now(tz=IST).floor("h")
    out = []
    for spot_id, lat, lon in spots:
        h = hourly.get(spot_id, {})
        for k in range(1, 13):
            t = (now + pd.Timedelta(hours=k)).to_pydatetime()
            if hour_key(t) not in h:
                continue
            out.append({"spot_id": spot_id, "time": t,
                        **feature_row(lat, lon, t.replace(tzinfo=None), h, 45, 1)})
    return pd.DataFrame(out)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--train", default=str(HERE / "cache" / "training.csv"))
    p.add_argument("--dry-run", action="store_true", help="predict but do not write")
    p.add_argument("--api", default=os.environ.get("SITSPOT_API_URL"),
                   help="API base URL (e.g. http://localhost:8787 or https://<tunnel>/api); needs CRON_SECRET")
    a = p.parse_args(argv)
    if a.api:
        secret = os.environ.get("CRON_SECRET") or sys.exit("CRON_SECRET is not set (needed for --api).")
        run_api(a.api, secret, Path(a.train), a.dry_run)
        return
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("Set SITSPOT_API_URL/--api (+ CRON_SECRET) or DATABASE_URL (Postgres). Without a forecast "
                 "the app falls back to p_rich=0.5 / model_version='prior'.")
    import psycopg
    with psycopg.connect(url) as conn:
        train = load_training(conn, Path(a.train))
        spots = conn.execute("select id, lat, lon from spots").fetchall()
        conds = conn.execute(
            f"select spot_id, time, {', '.join(COND_COLS)} from conditions "
            "where time >= now() - interval '1 hour' and time <= now() + interval '13 hours'").fetchall()
        rows = build_rows(spots, conds)
        if rows.empty:
            sys.exit("no conditions rows for the next 12 h - run /cron/pull first.")
        rows["p_rich"] = predict(train, rows)
        version = f"tabpfn-{tabpfn_version()}-{date.today()}"
        print(rows[["spot_id", "time", "p_rich"]].to_string(index=False))
        if a.dry_run:
            return
        with conn.cursor() as cur:
            cur.executemany(
                """insert into forecasts (time, spot_id, p_rich, model_version) values (%s,%s,%s,%s)
                   on conflict (spot_id, time, model_version) do update
                   set p_rich = excluded.p_rich, created_at = now()""",
                [(r.time, r.spot_id, float(r.p_rich), version) for r in rows.itertuples()])
        print(f"upserted {len(rows)} forecasts as {version}")


if __name__ == "__main__":
    main()
