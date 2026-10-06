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
| 1. Export checklists | `python export_ebird.py --start 2022-09-01 --end 2026-12-31 --max 8000` → `cache/checklists.csv` | `EBIRD_API_KEY` |
| 2. Features + label | `python features.py [--to-db]` → `cache/training.csv` (+ `training_checklists`) | network (Open-Meteo, no key) |
| 3. Benchmark | `python train_eval.py` → `evaluation/tabpfn_results.md` | step 2 output |
| 4. Hourly forecast | `python forecast_job.py [--dry-run]` → `forecasts` | `DATABASE_URL` (Postgres) |

- Every HTTP response is cached in `cache/http/` (gitignored). eBird calls are throttled to 1 req/s, Open-Meteo to 5 req/s. A full Sep–Dec export over 4 seasons is roughly 2,000 feed calls plus one call per checklist, so a few hours. Run it overnight; it is safe to Ctrl-C and rerun.
- `train_eval.py --synthetic` runs a smoke test on **synthetic** data and writes to the temp dir. It refuses to write into `evaluation/`.
- `forecast_job.py` exits with a message when `DATABASE_URL` is missing. The local dev DB is PGlite, which Python cannot open, so the app falls back to `p_rich = 0.5`, `model_version = 'prior'`. `model_version` is `tabpfn-<pkg>-<weights>-<date>`, e.g. `tabpfn-9.1.0-v2-2026-10-06`.

## Data notes (checked 2026-10-06)

- **eBird region codes:** `IN-MH-PG` (Palghar) and `IN-MH-MC` (Mumbai City) appear on ebird.org. `IN-MH-MS` (Mumbai Suburban) and `IN-MH-TN` (Thane) are **[verify]**. Once you have the key, run `python export_ebird.py --list-regions IN-MH` and fix `--regions` if needed.
- Checklists at personal (non-hotspot) locations are dropped when the feed has no coordinates. The API does not expose them.
- `num_species` is eBird's feed `numSpecies` (fallback: distinct `speciesCode` in the checklist, which can include spuh/slash taxa).
- Only complete checklists (`allObsReported`) with stationary/traveling protocol and 15–120 min duration are kept.
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
