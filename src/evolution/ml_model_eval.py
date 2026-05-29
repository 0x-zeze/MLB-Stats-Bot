"""Offline evaluation harness for the optional ML moneyline model.

Joins the engineered feature breakdown stored on each pick with the settled
binary outcome, does a chronological train/test split, trains the sklearn
models from `model.py`, and compares their Brier score against the existing
baseline (rule-based) probability on the same held-out games.

This is a MEASUREMENT tool, not a live predictor. The ML model should only be
wired into the live pipeline if it beats the baseline here. Activating a model
that loses this comparison would degrade edge.

Run:  python -m src.evolution.ml_model_eval
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from ..calibration import brier_score
from ..model import train_ml_models
from ..utils import DATA_DIR, safe_float

# Feature columns from modelBreakdown that are stable, numeric, and pre-game.
FEATURE_COLUMNS = [
    "matchupEdge",
    "recordContextEdge",
    "offenseEdge",
    "preventionEdge",
    "starterEdge",
    "lineupEdge",
    "bullpenEdge",
    "fatigueEdge",
    "winPctEdge",
    "pythagoreanEdge",
    "log5Edge",
    "formEdge",
    "h2hEdge",
    "memoryEdge",
    "homeFieldEdge",
]

_OUTCOMES_PATH = DATA_DIR / "evolution" / "prediction_outcomes.csv"
_STATE_CANDIDATES = [DATA_DIR / "state.sqlite", DATA_DIR / "state.json"]
_MIN_TRAIN_ROWS = 80
_TEST_FRACTION = 0.25


def _load_labels(outcomes_path: Path) -> dict[str, int]:
    """Map game_id -> 1 if home team won, else 0 (moneyline, settled only)."""
    import csv

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


def _load_feature_rows(state_path: Path) -> dict[str, dict[str, Any]]:
    """Map game_id -> {features..., date, baseline_home_prob} from stored picks."""
    rows: dict[str, dict[str, Any]] = {}
    if not state_path.exists() or state_path.suffix.lower() not in {".sqlite", ".sqlite3", ".db"}:
        return rows
    with sqlite3.connect(state_path) as connection:
        connection.row_factory = sqlite3.Row
        for record in connection.execute("SELECT game_pk, payload FROM picks"):
            try:
                payload = json.loads(record["payload"])
            except (json.JSONDecodeError, TypeError):
                continue
            breakdown = payload.get("modelBreakdown") or {}
            features = {col: safe_float(breakdown.get(col), 0.0) for col in FEATURE_COLUMNS}
            if not any(features.values()):
                continue
            home_prob = safe_float((payload.get("home") or {}).get("winProbability"), None)
            if home_prob is None:
                continue
            rows[str(record["game_pk"])] = {
                **features,
                "date": str(payload.get("dateYmd") or ""),
                "baseline_home_prob": home_prob / 100.0 if home_prob > 1.0 else home_prob,
            }
    return rows


def _build_dataset(outcomes_path: Path, state_path: Path) -> list[dict[str, Any]]:
    labels = _load_labels(outcomes_path)
    feature_rows = _load_feature_rows(state_path)
    dataset = []
    for game_id in set(labels) & set(feature_rows):
        row = dict(feature_rows[game_id])
        row["home_win"] = labels[game_id]
        row["game_id"] = game_id
        dataset.append(row)
    # Chronological order so the split is a genuine forward test (no leakage).
    dataset.sort(key=lambda item: (item.get("date", ""), item.get("game_id", "")))
    return dataset


def evaluate(outcomes_path: Path | None = None, state_path: Path | None = None) -> dict[str, Any]:
    """Train ML models and compare Brier vs baseline on a held-out time split."""
    outcomes_path = outcomes_path or _OUTCOMES_PATH
    if state_path is None:
        state_path = next((p for p in _STATE_CANDIDATES if p.exists()), _STATE_CANDIDATES[0])

    dataset = _build_dataset(outcomes_path, state_path)
    if len(dataset) < _MIN_TRAIN_ROWS:
        return {
            "status": "skipped",
            "reason": f"only {len(dataset)} joined rows (need {_MIN_TRAIN_ROWS})",
            "joined_rows": len(dataset),
        }

    split_idx = int(len(dataset) * (1.0 - _TEST_FRACTION))
    train_rows, test_rows = dataset[:split_idx], dataset[split_idx:]
    if not test_rows:
        return {"status": "skipped", "reason": "empty test split", "joined_rows": len(dataset)}

    try:
        models = train_ml_models(train_rows, FEATURE_COLUMNS, target_column="home_win")
    except RuntimeError as exc:
        return {"status": "error", "reason": str(exc)}

    test_features = [[safe_float(row.get(col), 0.0) for col in FEATURE_COLUMNS] for row in test_rows]
    outcomes = [int(row["home_win"]) for row in test_rows]

    baseline_probs = [safe_float(row.get("baseline_home_prob"), 0.5) for row in test_rows]
    baseline_brier = brier_score(baseline_probs, outcomes)

    results: dict[str, Any] = {
        "status": "success",
        "joined_rows": len(dataset),
        "train_rows": len(train_rows),
        "test_rows": len(test_rows),
        "baseline_brier": round(baseline_brier, 5),
        "models": {},
    }
    best_name, best_brier = "baseline", baseline_brier
    for name, model in models.items():
        try:
            probs = [float(p[1]) for p in model.predict_proba(test_features)]
        except (AttributeError, IndexError):
            continue
        model_brier = brier_score(probs, outcomes)
        beats = model_brier < baseline_brier
        results["models"][name] = {
            "brier": round(model_brier, 5),
            "beats_baseline": beats,
            "improvement": round(baseline_brier - model_brier, 5),
        }
        if model_brier < best_brier:
            best_name, best_brier = name, model_brier

    results["best"] = best_name
    results["recommendation"] = (
        f"Wire '{best_name}' into the live pipeline (Brier {round(best_brier, 5)} < "
        f"baseline {round(baseline_brier, 5)})."
        if best_name != "baseline"
        else "Keep the baseline; no ML model beat it on the held-out split."
    )
    return results


if __name__ == "__main__":
    print(json.dumps(evaluate(), indent=2))
