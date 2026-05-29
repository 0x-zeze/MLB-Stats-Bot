"""Measure whether the LLM analyst's probability nudge improves accuracy.

The analyst may shift the pick probability by up to +/-5%. Whether that nudge
helps or just adds variance is an empirical question. This tool pairs each
settled game where a shift was applied and compares the Brier score of the
model-only (pre-LLM baseline) probability against the model+LLM (post-shift)
probability on the SAME games.

Baseline probabilities are preserved on each pick as `agentShift` (see
storage.js compactPrediction). Games predicted before that field existed are
skipped, so this metric is forward-looking and accumulates over time.

Run:  python -m src.evolution.llm_value_eval
"""

from __future__ import annotations

import csv
import json
import sqlite3
from pathlib import Path
from typing import Any

from ..calibration import brier_score
from ..utils import DATA_DIR, safe_float

_OUTCOMES_PATH = DATA_DIR / "evolution" / "prediction_outcomes.csv"
_STATE_CANDIDATES = [DATA_DIR / "state.sqlite", DATA_DIR / "state.json"]


def _load_home_win_labels(outcomes_path: Path) -> dict[str, int]:
    labels: dict[str, int] = {}
    if not outcomes_path.exists():
        return labels
    with open(outcomes_path, newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("market", "").strip().lower() != "moneyline":
                continue
            if row.get("result", "").strip().lower() not in ("win", "loss"):
                continue
            payload = row.get("evaluation_json") or ""
            try:
                data = json.loads(payload) if payload else {}
            except json.JSONDecodeError:
                continue
            home = data.get("actual_home_score")
            away = data.get("actual_away_score")
            if home is None or away is None:
                continue
            labels[str(row.get("game_id"))] = 1 if safe_float(home) > safe_float(away) else 0
    return labels


def _load_shift_pairs(state_path: Path) -> dict[str, dict[str, float]]:
    """Map game_id -> {baseline_home, final_home} for picks with an applied shift."""
    pairs: dict[str, dict[str, float]] = {}
    if not state_path.exists() or state_path.suffix.lower() not in {".sqlite", ".sqlite3", ".db"}:
        return pairs
    with sqlite3.connect(state_path) as connection:
        connection.row_factory = sqlite3.Row
        for record in connection.execute("SELECT game_pk, payload FROM picks"):
            try:
                payload = json.loads(record["payload"])
            except (json.JSONDecodeError, TypeError):
                continue
            shift = payload.get("agentShift") or {}
            if not shift.get("applied"):
                continue
            baseline_home = safe_float(shift.get("baselineHomeProbability"), None)
            final_home = safe_float((payload.get("home") or {}).get("winProbability"), None)
            if baseline_home is None or final_home is None:
                continue
            pairs[str(record["game_pk"])] = {
                "baseline_home": baseline_home / 100.0 if baseline_home > 1.0 else baseline_home,
                "final_home": final_home / 100.0 if final_home > 1.0 else final_home,
            }
    return pairs


def evaluate(outcomes_path: Path | None = None, state_path: Path | None = None) -> dict[str, Any]:
    """Compare model-only vs model+LLM Brier on games where a shift was applied."""
    outcomes_path = outcomes_path or _OUTCOMES_PATH
    if state_path is None:
        state_path = next((p for p in _STATE_CANDIDATES if p.exists()), _STATE_CANDIDATES[0])

    labels = _load_home_win_labels(outcomes_path)
    pairs = _load_shift_pairs(state_path)
    game_ids = sorted(set(labels) & set(pairs))

    if not game_ids:
        return {
            "status": "no_data",
            "reason": "no settled games with an applied LLM shift yet",
            "shifts_recorded": len(pairs),
            "settled_labels": len(labels),
            "note": "Baseline preserved going forward; re-run after more games settle.",
        }

    outcomes = [labels[gid] for gid in game_ids]
    baseline_probs = [pairs[gid]["baseline_home"] for gid in game_ids]
    final_probs = [pairs[gid]["final_home"] for gid in game_ids]

    baseline_brier = brier_score(baseline_probs, outcomes)
    llm_brier = brier_score(final_probs, outcomes)
    improvement = baseline_brier - llm_brier

    return {
        "status": "success",
        "paired_games": len(game_ids),
        "model_only_brier": round(baseline_brier, 5),
        "model_plus_llm_brier": round(llm_brier, 5),
        "improvement": round(improvement, 5),
        "llm_helps": improvement > 0,
        "recommendation": (
            "Keep the LLM nudge: it lowers Brier on shifted games."
            if improvement > 0
            else "Consider disabling the LLM nudge: it does not improve (or worsens) "
            "Brier on the games where it was applied. It may be adding variance."
        ),
    }


if __name__ == "__main__":
    print(json.dumps(evaluate(), indent=2))
