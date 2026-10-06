# ml/tabpfn — `p_rich` forecast (spec §12)

Probability that a ~45-min birding visit at a place and hour is "rich" (species count at or above the usual for that place).

## Setup (Windows / Git Bash, Python 3.11)

```bash
cd ml/tabpfn
python -m venv .venv
.venv/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cpu   # CPU wheel, ~200 MB
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m pytest -q tests
```

## Pipeline

| Step | Command | Needs |
|---|---|---|
| 1. Export checklists | `python export_ebird.py --feed-only --merge --start 2022-09-01 --end 2026-10-05 --max 100000` → `cache/checklists.csv` | `EBIRD_API_KEY` |
| 2. Features + label | `python features.py [--to-db]` → `cache/training.csv` (full) + `training.csv` (features + label only, used by step 4) (+ `training_checklists`) | network (Open-Meteo, no key) |
| 3. Benchmark | `python train_eval.py` → `evaluation/tabpfn_results.md` | step 2 output |
| 4. Hourly forecast | `python forecast_job.py [--dry-run]` → `forecasts` | `DATABASE_URL` (Postgres) |

- Every HTTP response is cached in `cache/http/` (gitignored). eBird calls are paced at 2 s, Open-Meteo at 0.2 s. eBird answers HTTP 429 (`Retry-After` ~4 s) on almost every call after a few hundred, so the real rate is about 7 s per call. It is safe to Ctrl-C and rerun.
- **Feed-only export (default way to run it).** `--feed-only` builds rows from `product/lists/{region}/{y}/{m}/{d}` alone: one call per region-day (`maxResults=200`, the API maximum; a day that hits 200 is logged). Sep 2022 – 5 Oct 2026 is 523 days × 4 regions ≈ 2,100 calls, about 4 h. The detailed mode also calls `product/checklist/view` for every checklist, which managed ~640 checklists in 3 h. `--merge` uses a checklist/view that is already in the HTTP cache (from earlier detailed runs), so those rows keep their effort fields. No new view calls are made. Use a large `--max`, because the default 8,000 stops before the latest (test) season.
- **What the feed has** (seen in real responses): `subId`, `locId`, `numSpecies`, `isoObsDate` (`"2022-10-28 14:15"`, local time), `obsDt`/`obsTime`, `userDisplayName` (not exported), and `loc` with `latitude`/`longitude`, `isHotspot` and `subnational2Code`. Coordinates are present for personal locations too, so `ref/hotspot/info` is only a fallback. It is called only for hotspots without coordinates, and is cached per locId. `obsTime` is missing when no start time was entered (`isoObsDate` then shows a fake `00:00`), so those rows are dropped.
- **Feed-only rows have no effort.** `duration_min`, `protocol` and `all_obs_reported` are empty. `features.py` keeps these rows, sets `duration_min`/`is_traveling` to NaN and `effort_known = 0`, and cannot apply the 15–120 min / stationary-traveling / complete-checklist filters to them. Long checklists find more species, so the `rich` label is **noisier** for these rows: part of the target is unobserved effort. TabPFN and XGBoost take NaN natively. Logistic regression median-imputes. The forecast job always predicts for `duration_min=45, traveling, effort_known=1`.
- `train_eval.py --synthetic` runs a smoke test on **synthetic** data and writes to the temp dir. It refuses to write into `evaluation/`.
- `forecast_job.py` exits with a message when `DATABASE_URL` is missing. The local dev DB is PGlite, which Python cannot open, so the app falls back to `p_rich = 0.5`, `model_version = 'prior'`. `model_version` is `tabpfn-<pkg>-<weights>-<date>`, e.g. `tabpfn-9.1.0-v2-2026-10-06`.

## Data notes (checked 2026-10-06)

- **eBird region codes (verified 2026-10-06):** `IN-MH-PG` Palghar, `IN-MH-TH` Thane, `IN-MH-MC` Mumbai City, `IN-MH-MS` Mumbai Suburban.
- Checklists at personal (non-hotspot) locations are dropped when the feed has no coordinates. The API does not expose them.
- `num_species` is eBird's feed `numSpecies` (fallback: distinct `speciesCode` in the checklist, which can include spuh/slash taxa).
- Rows with known effort: only complete checklists (`allObsReported`) with stationary/traveling protocol and 15–120 min duration are kept. Feed-only rows are not filtered (see above).
- **Open-Meteo history:** archive weather and air-quality `us_aqi` both return values for Oct 2022. Marine `sea_level_height_msl` was **null for Oct 2022** and has values from 2023 on, so tide features are null for the 2022 season. TabPFN and XGBoost handle NaN natively; logistic regression imputes the median. Tide is only fetched for cells within 15 km of the coast.
- `dist_to_coast_km` uses 17 hand-picked, approximate shoreline points (Colaba → Arnala, plus Sewri and Airoli on Thane creek).
- Label medians are computed over the whole table, including the test season (spec §12 step 3 as written). This leaks slightly; per-season medians would fix it.

## TabPFN licence and weights (checked 2026-10-06, `tabpfn==9.1.0`)

- The **code** (`tabpfn` on PyPI) is Apache-2.0.
- **TabPFN-2 weights** (`ModelVersion.V2`, our default) use the *Prior Labs License*: Apache-2.0 plus an attribution requirement. They download directly from HuggingFace with **no login or token**, verified here (`cache/models/tabpfn-v2-classifier-*.ckpt`). Attribution: credit "TabPFN by Prior Labs" in the README or DEV post.
- **TabPFN-2.5 / 2.6 / 3 / 3.5 weights** (the package default) use **non-commercial** licences and are gated. To use them, set `TABPFN_MODEL_VERSION=latest` (or `v3`, etc.) and:
  1. Log in at https://ux.priorlabs.ai and accept the licence on the Licenses tab.
  2. Copy your API key and set `TABPFN_TOKEN=<key>`. Without it, tabpfn tries to open a browser, which fails in CI.
- **CPU:** v2's soft limit is 1,000 training rows on CPU. We set `TABPFN_ALLOW_CPU_LARGE_DATASET=1` and `ignore_pretraining_limits=True` and fit on a ≤3,000-row stratified subsample. On the synthetic test (891 train / 309 test rows) fit+predict took about 40 s on this laptop's CPU.
- Weights are cached in `ml/tabpfn/cache/models` (`TABPFN_MODEL_CACHE_DIR`). Cache that directory in GitHub Actions.
- If weights cannot be fetched, `train_eval.py` records TabPFN as `skipped: <reason>` instead of failing the other models.
