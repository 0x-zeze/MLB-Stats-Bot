"""Phase 3 Python calibration tests: Platt, Beta-Logit, JS<->Python parity, walk-forward benchmark."""

from __future__ import annotations

import json
import math
import random
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import src.probability_calibrator as pc


def _synthetic_overconfident_series(n: int = 420) -> list[tuple[str, float, float]]:
    """Deterministic overconfident probability series where true p = sigmoid(0.40 * logit(raw) - 0.15)."""
    rng = random.Random(42)
    rows: list[tuple[str, float, float]] = []
    for i in range(n):
        raw_p = 0.15 + 0.70 * rng.random()
        logit_raw = math.log(raw_p / (1.0 - raw_p))
        true_p = 1.0 / (1.0 + math.exp(-(0.40 * logit_raw - 0.15)))
        outcome = 1.0 if rng.random() < true_p else 0.0
        date_str = f"2026-04-{(i // 12) + 1:02d}"
        rows.append((date_str, raw_p, outcome))
    return rows


def test_platt_and_beta_logit_fit_monotonic_and_recover_shrinkage():
    dated = _synthetic_overconfident_series(400)
    pairs = [(p, y) for _, p, y in dated]

    platt, p_info = pc.fit_platt_calibrator(pairs)
    assert platt is not None and p_info["status"] == "success"
    assert platt["method"] == "platt"
    assert 0.25 < platt["a"] < 0.90, f"expected overconfident slope < 1, got {platt['a']}"

    beta_logit, b_info = pc.fit_beta_logit_calibrator(pairs)
    assert beta_logit is not None and b_info["status"] == "success"
    assert beta_logit["method"] == "beta_logit"
    assert beta_logit["a"] >= 0.0 and beta_logit["b"] >= 0.0 and (beta_logit["a"] + beta_logit["b"]) > 0.0

    # Strict monotonicity across [0.10, 0.90]
    grid = [0.10, 0.25, 0.40, 0.50, 0.60, 0.75, 0.90]
    p_vals = [pc.apply_parametric_calibrator(platt, p) for p in grid]
    b_vals = [pc.apply_parametric_calibrator(beta_logit, p) for p in grid]
    for i in range(1, len(grid)):
        assert p_vals[i] > p_vals[i - 1], f"Platt non-monotonic: {p_vals}"
        assert b_vals[i] > b_vals[i - 1], f"Beta-Logit non-monotonic: {b_vals}"


def test_js_python_parametric_calibration_bit_exact_parity():
    platt = {"method": "platt", "a": 0.683421, "b": -0.07125}
    beta_logit = {"method": "beta_logit", "a": 0.5912, "b": 0.8145, "c": 0.0423}
    probs = [0.15, 0.32, 0.5, 0.64, 0.82]

    repo_root = Path(__file__).resolve().parent.parent
    js_snippet = (
        "import { applyParametricCalibration } from './src/calibration.js';"
        f"const platt = {json.dumps(platt)};"
        f"const beta = {json.dumps(beta_logit)};"
        f"const probs = {json.dumps(probs)};"
        "console.log(JSON.stringify({"
        "  platt: probs.map(p => applyParametricCalibration(platt, p)),"
        "  beta: probs.map(p => applyParametricCalibration(beta, p))"
        "}));"
    )
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", js_snippet],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        check=True,
    )
    js_out = json.loads(proc.stdout)
    for idx, p in enumerate(probs):
        py_p = pc.apply_parametric_calibrator(platt, p)
        py_b = pc.apply_parametric_calibrator(beta_logit, p)
        assert abs(py_p - js_out["platt"][idx]) < 1e-12
        assert abs(py_b - js_out["beta"][idx]) < 1e-12


def test_walk_forward_calibration_benchmark_prefers_parametric_on_overconfident_series():
    dated = _synthetic_overconfident_series(420)
    report = pc.walk_forward_calibration_benchmark(dated, min_train_samples=100, step_size=40)
    assert report["status"] == "ok"
    # 12 games/day -> min_train_samples=100 advances to 9 full days (108 train rows), leaving 312 OOF rows.
    assert report["n_oof_evaluated"] == 312
    methods = report["methods"]
    # Both Platt and Beta-Logit must beat raw identity AND legacy isotonic on Brier, Log-Loss, and ECE!
    assert methods["platt"]["brier"] < methods["isotonic"]["brier"] < methods["identity"]["brier"]
    assert methods["platt"]["log_loss"] < methods["isotonic"]["log_loss"] < methods["identity"]["log_loss"]
    assert methods["platt"]["ece"] < methods["isotonic"]["ece"] < methods["identity"]["ece"]
    assert methods["beta_logit"]["brier"] < methods["isotonic"]["brier"] < methods["identity"]["brier"]
    assert methods["beta_logit"]["log_loss"] < methods["isotonic"]["log_loss"] < methods["identity"]["log_loss"]


def test_parametric_retrain_round_trip_in_temp_dir():
    dated = _synthetic_overconfident_series(160)
    with TemporaryDirectory() as tmp:
        outcomes = Path(tmp) / "prediction_outcomes.csv"
        lines = ["date,game_id,market,result,brier_score,evaluation_json"]
        for i, (d, p, y) in enumerate(dated):
            ej = json.dumps({"model_probability": p})
            lines.append(
                f"{d},g{i},moneyline,{'win' if y >= 0.5 else 'loss'},0.2,\"{ej.replace(chr(34), chr(34)*2)}\""
            )
        outcomes.write_text("\n".join(lines))
        maps_path = Path(tmp) / "calibration_maps.json"
        legacy_path = Path(tmp) / "calibration_map.json"
        with patch.object(pc, "_OUTCOMES_PATH", outcomes), \
             patch.object(pc, "_CALIBRATION_MAPS_PATH", maps_path), \
             patch.object(pc, "_CALIBRATION_MAP_PATH", legacy_path):
            pc._cached_maps = None
            pc._cached_meta = None
            res = pc.retrain(method="platt")
            assert res["status"] == "success"
            assert res["markets"]["moneyline"]["method"] == "platt"
            # Force reload from temp disk and verify calibrate() uses the persisted Platt model
            pc._cached_maps = None
            pc._cached_meta = None
            cal_high = pc.calibrate(0.75, market="moneyline")
            assert 0.50 < cal_high < 0.75


def test_audit5_walk_forward_benchmark_obeys_strict_day_boundaries():
    """No two games on the same date may ever be split across train and test."""
    # 10 distinct dates * 25 games/date = 250 games.
    # min_train_samples=60 must advance to full day boundary -> 3 dates = 75 train rows!
    # Therefore exactly 250 - 75 = 175 rows are evaluated OOF (never 190!).
    rng = random.Random(99)
    dated: list[tuple[str, float, float]] = []
    for day in range(1, 11):
        d_str = f"2026-05-{day:02d}"
        for _ in range(25):
            p = 0.25 + 0.50 * rng.random()
            y = 1.0 if rng.random() < p else 0.0
            dated.append((d_str, p, y))

    report = pc.walk_forward_calibration_benchmark(dated, min_train_samples=60, step_size=15)
    assert report["status"] == "ok"
    assert report["n_total"] == 250
    assert report["n_oof_evaluated"] == 175


def test_audit6_low_sample_parametric_shrinkage_matches_js_parity():
    """When parametric samples < 60, Python and JS both shrink the parametric output toward 0.5."""
    platt = {"method": "platt", "a": 0.65, "b": -0.05}
    with TemporaryDirectory() as tmp:
        maps_path = Path(tmp) / "calibration_maps.json"
        meta_path = Path(tmp) / "calibration_meta.json"
        maps_path.write_text(json.dumps({"moneyline": platt}))
        meta_path.write_text(json.dumps({
            "version": 1,
            "markets": {"moneyline": {"status": "success", "samples": 40, "method": "platt"}},
        }))
        with patch.object(pc, "_CALIBRATION_MAPS_PATH", maps_path):
            pc._cached_maps = None
            pc._cached_disk_maps = None
            pc._cached_meta = None
            py_val = pc.calibrate(0.75, market="moneyline")

    repo_root = Path(__file__).resolve().parent.parent
    js_snippet = (
        "import { buildCalibrationArtifact, calibrateProbabilityWithArtifact } from './src/calibration.js';"
        f"const art = buildCalibrationArtifact({{ market: 'moneyline', mapping: {json.dumps(platt)}, meta: {{ markets: {{ moneyline: {{ status: 'success', samples: 40, method: 'platt' }} }} }} }});"
        "console.log(JSON.stringify({ mode: art.mode, val: calibrateProbabilityWithArtifact(0.75, art) }));"
    )
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", js_snippet],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        check=True,
    )
    js_out = json.loads(proc.stdout)
    assert js_out["mode"] == "parametric_low_sample_shrink"
    assert abs(py_val - js_out["val"]) < 1e-12

