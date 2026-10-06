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
