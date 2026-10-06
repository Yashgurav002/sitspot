"""forecast_job row building from SYNTHETIC conditions (no DB)."""
from datetime import timezone

import pandas as pd

from features import FEATURES
from forecast_job import COND_COLS, build_rows


def test_build_rows_next_12h_only_with_conditions():
    now = pd.Timestamp.now(tz="Asia/Kolkata").floor("h")  # build_rows works on IST hours
    conds = [("s1", (now + pd.Timedelta(hours=k)).to_pydatetime(), *[1.0] * len(COND_COLS)) for k in range(0, 8)]
    rows = build_rows([("s1", 19.4, 72.8), ("s2", 19.0, 72.9)], conds)
    assert len(rows) == 7 and set(rows.spot_id) == {"s1"}  # hours +1..+7 have conditions; s2 none
    assert set(FEATURES) <= set(rows.columns)
    assert (rows.duration_min == 45).all() and (rows.is_traveling == 1).all()
    assert rows.tide_trend.iloc[:-1].eq(0.0).all()  # flat synthetic tide


def test_run_api_fetches_input_and_posts_forecasts():
    from forecast_job import run_api

    now = pd.Timestamp.now(tz="UTC").floor("h")
    cond = {k: 1.0 for k in COND_COLS}
    inp = {
        "spots": [{"id": "s1", "lat": 19.4, "lon": 72.8, "kind": "coastal"}],
        "conditions": [{"spot_id": "s1", "time": (now + pd.Timedelta(hours=k)).strftime("%Y-%m-%dT%H:%M:%S.000Z"), **cond}
                       for k in range(-1, 14)],
    }
    calls = []

    def fake_http(method, url, secret, body=None):
        calls.append((method, url, secret, body))
        return inp if method == "GET" else {"inserted": len(body), "skipped_unknown_spot": 0}

    payload = run_api("http://api.test/api/", "s3cret", train_csv=None, http=fake_http,
                      predict_fn=lambda rows: [0.25] * len(rows))
    assert [(m, u, s) for m, u, s, _ in calls] == [
        ("GET", "http://api.test/api/cron/forecast-input?hours=12", "s3cret"),
        ("POST", "http://api.test/api/cron/forecast-ingest", "s3cret"),
    ]
    assert calls[1][3] == payload and len(payload) == 12  # next 12 hours, one spot
    assert {r["spot_id"] for r in payload} == {"s1"} and all(r["p_rich"] == 0.25 for r in payload)
    assert all(r["model_version"].startswith("tabpfn-") for r in payload)
    times = [pd.Timestamp(r["time"]) for r in payload]
    assert times[0] > now and all(b - a == pd.Timedelta(hours=1) for a, b in zip(times, times[1:]))  # IST hours

    calls.clear()
    run_api("http://api.test", "s3cret", train_csv=None, dry_run=True, http=fake_http, predict_fn=lambda r: [0.5] * len(r))
    assert [c[0] for c in calls] == ["GET"]  # dry run never POSTs
