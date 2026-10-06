"""End-to-end train_eval on SYNTHETIC data (--synthetic mode)."""
import pytest

import train_eval


def test_synthetic_end_to_end(tmp_path):
    out, results = train_eval.main(["--synthetic", "--out", str(tmp_path / "r.md")])
    text = out.read_text(encoding="utf-8")
    assert "SYNTHETIC" in text
    by = {r["model"].split(" ")[0]: r for r in results}
    assert set(by) == {"hotspot", "logistic", "XGBoost", "TabPFN"}
    for name in ["hotspot", "logistic", "XGBoost"]:
        assert "skipped" not in by[name], by[name]
        assert 0 <= by[name]["brier"] <= 1
    assert by["logistic"]["roc_auc"] > 0.7  # synthetic signal is learnable
    if "skipped" in by["TabPFN"]:
        pytest.skip(f"TabPFN weights unavailable: {by['TabPFN']['skipped']}")
    assert by["TabPFN"]["roc_auc"] > 0.7


def test_synthetic_never_written_to_evaluation():
    with pytest.raises(SystemExit):
        train_eval.main(["--synthetic", "--out", str(train_eval.EVAL_DIR / "tabpfn_results.md")])


def test_models_handle_unknown_effort():
    df = train_eval.synthetic_data(600)
    assert df["duration_min"].isna().any() and (df["effort_known"] == 0).any()
    df.loc[df.obs_time.str.startswith("2025"), ["duration_min", "is_traveling"]] = float("nan")  # all-NaN in test
    results, info = train_eval.evaluate(df)
    for r in results:
        if r["model"].startswith("TabPFN"):
            continue  # covered by test_synthetic_end_to_end; slow on CPU
        assert "skipped" not in r, r
    assert info["test_rows"] + info["train_rows"] == 600
    assert "Effort caveat" in train_eval.report(results, info, synthetic=True)
