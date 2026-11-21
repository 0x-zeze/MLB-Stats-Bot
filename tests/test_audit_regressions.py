"""Regression tests locking in critical fixes from the full project audit."""

from __future__ import annotations

import numpy as np
import pytest

from src.clv_tracking import clv_cents
from src.dashboard_service import _as_edge_pct, rows_to_csv
from src.evaluate import market_baselines
from src.evolution.evolution_audit import _classify_reason, reason_quality
from src.models.train_market_residual_v2 import _fit_offset_logistic
from src.probability_calibrator import calibrate_banded_shrink
from src.sharp_money import detect_sharp_money_signal


def test_calibrate_banded_shrink_parses_default_string_bands() -> None:
    # Band "0.55-0.60" uses factor 0.4 -> 0.5 + (0.58 - 0.5) * 0.4 = 0.532
    assert calibrate_banded_shrink(0.58) == pytest.approx(0.532, abs=1e-6)
    # Band "0.00-0.45" uses factor 1.2 -> 0.5 + (0.38 - 0.5) * 1.2 = 0.356
    assert calibrate_banded_shrink(0.38) == pytest.approx(0.356, abs=1e-6)


def test_market_baselines_skips_missing_probabilities_without_type_error() -> None:
    rows = [
        {"market_type": "moneyline", "result": "win", "fair_prob": "", "model_prob": 0.6},
        {"market_type": "moneyline", "result": "loss", "fair_prob": 0.55, "model_prob": ""},
        {"market_type": "moneyline", "result": "win", "fair_prob": 0.55, "model_prob": 0.60},
    ]
    res = market_baselines(rows)
    assert res["comparable_moneyline_rows"] == 1
    assert res["model_accuracy"] == 1.0


def test_evolution_audit_word_boundary_and_reason_quality_excludes_non_actionable() -> None:
    # "era" must NOT match inside "general".
    assert _classify_reason("general") is None
    assert _classify_reason("starter era regression") == "starting_pitcher"

    losses = [
        {"loss_type": "correct_pick", "affected_factor": "general"},
        {"loss_type": "general", "affected_factor": "general"},
        {"loss_type": "bullpen_meltdown", "affected_factor": "bullpen"},
    ]
    rq = reason_quality([], losses)
    factors = {entry["factor"] for entry in rq}
    assert "starting_pitcher" not in factors
    assert "bullpen" in factors


def test_dashboard_edge_pp_no_100x_blowup_and_csv_formula_neutralization() -> None:
    # Before fix, values in [-1, 1] were multiplied by 100 (0.8 -> 80.0, -0.45 -> -45.0).
    assert _as_edge_pct(0.8) == pytest.approx(0.8)
    assert _as_edge_pct(-0.4) == pytest.approx(-0.4)

    csv_text = rows_to_csv([{"team": "=SUM(A1:A2)", "note": "+cmd|'/c calc'!A0", "safe": "Dodgers"}])
    assert "'=SUM(A1:A2)" in csv_text
    assert "'+cmd|'/c calc'!A0" in csv_text
    assert "Dodgers" in csv_text


def test_sharp_money_underdog_direction_and_continuous_cents_across_100() -> None:
    # Underdog moves from +150 to +130 -> shorter price -> money moved TOWARD the underdog pick.
    sig = detect_sharp_money_signal(
        model_pick="Away",
        model_probability=0.44,
        opening_odds={"away": 150, "home": -170},
        closing_odds={"away": 130, "home": -150},
        pick_side="away",
    )
    assert sig.movement_direction == "toward_model"
    assert sig.movement_magnitude == pytest.approx(20.0)

    # Crossing pick'em (+105 -> -105) is 10 cents, not 210 cents.
    sig_cross = detect_sharp_money_signal(
        model_pick="Away",
        model_probability=0.52,
        opening_odds={"away": 105, "home": -115},
        closing_odds={"away": -105, "home": -105},
        pick_side="away",
    )
    assert sig_cross.movement_magnitude == pytest.approx(10.0)
    assert clv_cents(105, -105) == pytest.approx(10.0)


def test_fit_offset_logistic_respects_fixed_market_offset() -> None:
    rng = np.random.default_rng(42)
    n = 400
    offset = rng.normal(0.0, 1.0, size=n)
    probs = 1.0 / (1.0 + np.exp(-offset))
    y = (rng.random(n) < probs).astype(float)
    X = rng.normal(0.0, 1.0, size=(n, 3))

    intercept, weights = _fit_offset_logistic(X, y, offset, c=0.5)
    assert abs(intercept) < 0.35
    assert np.all(np.abs(weights) < 0.35)
