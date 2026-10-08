"""Time-split benchmark: TabPFN vs hotspot x hour-band average, logistic regression, XGBoost.

  python train_eval.py [--data cache/training.csv]   -> evaluation/tabpfn_results.md (real data only)
  python train_eval.py --synthetic [--out PATH]      -> SYNTHETIC smoke run, written to a temp file

Season = calendar year of the (Sep-Dec) checklist; the latest season is the test set.
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile
import time
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from features import FEATURES, hour_band

HERE = Path(__file__).resolve().parent
EVAL_DIR = (HERE / "../../evaluation").resolve()
THRESHOLD = 0.35  # invitation threshold (spec §3)
TABPFN_MAX_TRAIN = 3000
os.environ.setdefault("TABPFN_MODEL_CACHE_DIR", str(HERE / "cache" / "models"))  # cacheable in CI
os.environ.setdefault("TABPFN_ALLOW_CPU_LARGE_DATASET", "1")  # v2 CPU soft limit is 1000 rows


def make_tabpfn():
    """TabPFN classifier on CPU. TABPFN_MODEL_VERSION=v2 (default; Prior Labs License = Apache-2.0
    + attribution) or 'latest' (package default; non-commercial weights, needs TABPFN_TOKEN)."""
    from tabpfn import TabPFNClassifier
    ver = os.environ.get("TABPFN_MODEL_VERSION", "v2").lower()
    if ver == "latest":
        return TabPFNClassifier(device="cpu", ignore_pretraining_limits=True)
    from tabpfn.constants import ModelVersion
    return TabPFNClassifier.create_default_for_version(ModelVersion(ver), device="cpu",
                                                       ignore_pretraining_limits=True)


def tabpfn_version() -> str:
    import tabpfn
    return f"{getattr(tabpfn, '__version__', 'unknown')}-{os.environ.get('TABPFN_MODEL_VERSION', 'v2')}"


def stratified_subsample(df: pd.DataFrame, n: int, seed: int = 0) -> pd.DataFrame:
    if len(df) <= n:
        return df
    sub, _ = train_test_split(df, train_size=n, stratify=df["rich"], random_state=seed)
    return sub


def synthetic_data(n: int = 1200, seed: int = 0) -> pd.DataFrame:
    """SYNTHETIC data for smoke tests only - never written to evaluation/."""
    rng = np.random.default_rng(seed)
    year = rng.choice([2022, 2023, 2024, 2025], n)
    doy = rng.integers(244, 365, n)
    hour = rng.choice(np.arange(5, 20), n)
    minute = rng.integers(0, 60, n)
    t = pd.to_datetime(year.astype(str), format="%Y") + pd.to_timedelta(doy - 1, "D") \
        + pd.to_timedelta(hour, "h") + pd.to_timedelta(minute, "min")
    df = pd.DataFrame({
        "checklist_id": [f"SYN{i}" for i in range(n)], "loc_id": rng.choice([f"L{i}" for i in range(12)], n),
        "obs_time": t.strftime("%Y-%m-%dT%H:%M:00+05:30"), "hour": hour, "day_of_year": doy,
        "minutes_from_sunrise": hour * 60 + minute - 390, "minutes_to_sunset": 1100 - hour * 60 - minute,
        "temp_c": rng.normal(29, 3, n), "rh_pct": rng.uniform(40, 95, n), "wind_ms": rng.gamma(2, 1.5, n),
        "precip_mm": rng.exponential(0.3, n), "cloud_pct": rng.uniform(0, 100, n),
        "us_aqi": rng.normal(110, 30, n), "tide_m": rng.normal(0, 1, n), "tide_trend": rng.choice([-1.0, 1.0], n),
        "dist_to_coast_km": rng.uniform(0, 40, n), "duration_min": rng.integers(15, 121, n),
        "is_traveling": rng.integers(0, 2, n).astype(float), "effort_known": 1})
    unknown = rng.random(n) < 0.3  # exercise feed-only rows (effort unknown)
    df.loc[unknown, ["duration_min", "is_traveling"]] = np.nan
    df.loc[unknown, "effort_known"] = 0
    df["apparent_c"] = df["temp_c"] + 2
    df["is_golden_hour"] = ((df.minutes_from_sunrise.between(0, 60)) | (df.minutes_to_sunset.between(0, 60))).astype(int)
    df.loc[rng.random(n) < 0.1, "us_aqi"] = np.nan  # exercise missing values
    logit = (-0.004 * df.minutes_from_sunrise.clip(0, 600) + 0.02 * df.duration_min.fillna(60)
             - 0.05 * df.dist_to_coast_km + 0.4 * df.is_traveling.fillna(0.5) - 0.02 * df.precip_mm + rng.normal(0, 1, n))
    df["rich"] = (logit > np.median(logit)).astype(int)
    df["hour_band"] = hour_band(df["hour"])
    return df


def hotspot_hour_baseline(train: pd.DataFrame, test: pd.DataFrame) -> np.ndarray:
    cell = train.groupby(["loc_id", "hour_band"])["rich"].mean()
    band = train.groupby("hour_band")["rich"].mean()
    keys = list(zip(test["loc_id"], test["hour_band"]))
    p = pd.Series([cell.get(k, np.nan) for k in keys], index=test.index)
    return p.fillna(test["hour_band"].map(band)).fillna(train["rich"].mean()).to_numpy()


def metrics(y, p) -> dict:
    sel = p >= THRESHOLD
    return {"roc_auc": roc_auc_score(y, p) if len(set(y)) > 1 else float("nan"),
            "brier": brier_score_loss(y, p),
            "precision@0.35": float(y[sel].mean()) if sel.any() else float("nan"),
            "share_flagged": float(sel.mean())}


def evaluate(df: pd.DataFrame) -> tuple[list[dict], dict]:
    df = df.copy()
    if "effort_known" not in df:  # older training.csv without the column
        df["effort_known"] = df["duration_min"].notna().astype(int)
    df["season"] = pd.to_datetime(df["obs_time"], utc=True).dt.tz_convert("Asia/Kolkata").dt.year
    if "hour_band" not in df:
        df["hour_band"] = hour_band(df["hour"])
    test_season = df["season"].max()
    train, test = df[df.season < test_season], df[df.season == test_season]
    if train.empty or test.empty:
        sys.exit("need at least two seasons for a time-ordered split")
    X, Xt = train[FEATURES].astype(float), test[FEATURES].astype(float)
    y, yt = train["rich"].to_numpy(), test["rich"].to_numpy()
    results = []

    def run(name, fit_predict):
        t0 = time.perf_counter()
        try:
            p = np.clip(fit_predict(), 0, 1)
            results.append({"model": name, **metrics(yt, p), "seconds": time.perf_counter() - t0})
        except Exception as e:  # report, don't hide: e.g. TabPFN weights unavailable
            results.append({"model": name, "skipped": f"{type(e).__name__}: {e}"[:300]})

    run("hotspot x hour-band avg", lambda: hotspot_hour_baseline(train, test))
    run("logistic regression", lambda: make_pipeline(SimpleImputer(strategy="median"), StandardScaler(),
                                                     LogisticRegression(max_iter=1000)).fit(X, y).predict_proba(Xt)[:, 1])

    def xgb():
        from xgboost import XGBClassifier
        return XGBClassifier().fit(X, y).predict_proba(Xt)[:, 1]

    def tabpfn():
        sub = stratified_subsample(train, TABPFN_MAX_TRAIN)
        return make_tabpfn().fit(sub[FEATURES].astype(float).to_numpy(), sub["rich"].to_numpy()) \
            .predict_proba(Xt.to_numpy())[:, 1]

    run("XGBoost (defaults)", xgb)
    run(f"TabPFN (<= {TABPFN_MAX_TRAIN} train rows)", tabpfn)
    info = {"train_rows": len(train), "test_rows": len(test), "test_season": int(test_season),
            "train_seasons": sorted(int(s) for s in train.season.unique()),
            "test_rich_rate": float(yt.mean()), "hotspots": df["loc_id"].nunique(),
            "train_effort_known": int(train.effort_known.sum()), "test_effort_known": int(test.effort_known.sum()),
            "per_season": df.groupby("season").agg(rows=("rich", "size"), rich=("rich", "mean"),
                                                    effort_known=("effort_known", "sum")).reset_index().to_dict("records")}
    return results, info


def report(results, info, synthetic: bool) -> str:
    head = "# TabPFN forecast benchmark\n\n"
    if synthetic:
        head += "> **SYNTHETIC DATA - smoke test only. These numbers mean nothing about birds.**\n\n"
    head += (f"Generated {date.today()} · train seasons {info['train_seasons']} ({info['train_rows']} rows) · "
             f"test season {info['test_season']} ({info['test_rows']} rows, {info['test_rich_rate']:.0%} rich) · "
             f"{info['hotspots']} locations · threshold {THRESHOLD}\n\n"
             "| Model | ROC-AUC | Brier | Precision@0.35 | Share flagged | Fit+predict s |\n|---|---|---|---|---|---|\n")
    for r in results:
        if "skipped" in r:
            head += f"| {r['model']} | skipped: {r['skipped']} | | | | |\n"
        else:
            head += (f"| {r['model']} | {r['roc_auc']:.3f} | {r['brier']:.3f} | {r['precision@0.35']:.3f} | "
                     f"{r['share_flagged']:.2f} | {r['seconds']:.1f} |\n")
    head += "\n| Season | Split | Rows | With effort (duration/protocol) | Rich rate |\n|---|---|---|---|---|\n"
    for r in info["per_season"]:
        split = "test" if r["season"] == info["test_season"] else "train"
        head += f"| {int(r['season'])} | {split} | {int(r['rows'])} | {int(r['effort_known'])} | {r['rich']:.0%} |\n"
    head += (f"\nTrain: {info['train_rows']} rows ({info['train_effort_known']} with effort). "
             f"Test: {info['test_rows']} rows ({info['test_effort_known']} with effort). "
             f"TabPFN is fit on a stratified subsample of <= {TABPFN_MAX_TRAIN} train rows.\n\n"
             "**Effort caveat.** Most rows come from eBird's daily checklist feed (`export_ebird.py --feed-only`), "
             "which has no duration, protocol or complete-checklist flag. For those rows `duration_min` and "
             "`is_traveling` are NaN and `effort_known` = 0, and the 15-120 min / stationary-traveling / complete "
             "filters cannot be applied. Long checklists find more species, so the `rich` label is noisier for "
             "them: part of what the models predict is unobserved effort, not conditions.\n")
    return head + ("\nLabel: rich = species count >= hotspot median (hotspots with >= 10 checklists) else "
                   "hour-band regional median. Target per spec §19: TabPFN AUC >= best baseline + 0.05.\n")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default=str(HERE / "cache" / "training.csv"))
    p.add_argument("--synthetic", action="store_true")
    p.add_argument("--out")
    a = p.parse_args(argv)
    if a.synthetic:
        out = Path(a.out or Path(tempfile.gettempdir()) / "tabpfn_results_SYNTHETIC.md").resolve()
        if EVAL_DIR in out.parents or out.parent == EVAL_DIR:
            sys.exit("refusing to write synthetic results into evaluation/")
        df = synthetic_data()
    else:
        if not Path(a.data).exists():
            sys.exit(f"{a.data} not found - run export_ebird.py then features.py (needs EBIRD_API_KEY).")
        out = Path(a.out or EVAL_DIR / "tabpfn_results.md")
        df = pd.read_csv(a.data)
    results, info = evaluate(df)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report(results, info, a.synthetic), encoding="utf-8")
    print(out.read_text(encoding="utf-8"))
    print(f"wrote {out}")
    return out, results


if __name__ == "__main__":
    main()
