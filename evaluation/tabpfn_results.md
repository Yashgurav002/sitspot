# TabPFN forecast benchmark

Generated 2026-10-06 · train seasons [2022, 2023, 2024, 2025] (18586 rows) · test season 2026 (1002 rows, 53% rich) · 3424 locations · threshold 0.35

| Model | ROC-AUC | Brier | Precision@0.35 | Share flagged | Fit+predict s |
|---|---|---|---|---|---|
| hotspot x hour-band avg | 0.650 | 0.245 | 0.549 | 0.87 | 0.1 |
| logistic regression | 0.565 | 0.251 | 0.556 | 0.93 | 0.1 |
| XGBoost (defaults) | 0.631 | 0.256 | 0.609 | 0.61 | 0.5 |
| TabPFN (<= 3000 train rows) | 0.649 | 0.255 | 0.627 | 0.52 | 171.6 |

| Season | Split | Rows | With effort (duration/protocol) | Rich rate |
|---|---|---|---|---|
| 2022 | train | 3422 | 811 | 49% |
| 2023 | train | 4573 | 0 | 47% |
| 2024 | train | 4885 | 0 | 48% |
| 2025 | train | 5706 | 0 | 53% |
| 2026 | test | 1002 | 0 | 53% |

Train: 18586 rows (811 with effort). Test: 1002 rows (0 with effort). TabPFN is fit on a stratified subsample of <= 3000 train rows.

**Effort caveat.** Most rows come from eBird's daily checklist feed (`export_ebird.py --feed-only`), which has no duration, protocol or complete-checklist flag. For those rows `duration_min` and `is_traveling` are NaN and `effort_known` = 0, and the 15-120 min / stationary-traveling / complete filters cannot be applied. Long checklists find more species, so the `rich` label is noisier for them: part of what the models predict is unobserved effort, not conditions.

Label: rich = species count >= hotspot median (hotspots with >= 10 checklists) else hour-band regional median. Target per spec §19: TabPFN AUC >= best baseline + 0.05.

**Verdict (2026-10-06): target not met.** TabPFN's ROC-AUC (0.649) ties the hotspot × hour-band baseline (0.650) instead of beating it by 0.05. It does have the best precision at the invite threshold (0.627 vs 0.549) while flagging far fewer hours (52% vs 87%) — which is the property an app that should rarely interrupt you cares about. Main suspected cause: 96% of rows lack effort (duration/protocol) because eBird rate limits forced the feed-only export. Next step if time allows: fetch checklist details for a sample of recent seasons and re-run.
