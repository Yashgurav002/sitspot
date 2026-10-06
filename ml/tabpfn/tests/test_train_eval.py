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
