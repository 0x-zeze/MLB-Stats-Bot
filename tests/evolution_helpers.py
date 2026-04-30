from __future__ import annotations

import os
import shutil
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import patch


@contextmanager
def isolated_evolution_store():
    root = Path.cwd() / "data" / "evolution_test_tmp" / uuid.uuid4().hex
    root.mkdir(parents=True, exist_ok=True)
    try:
        with patch.dict(os.environ, {"MLB_EVOLUTION_DATA_DIR": str(root)}, clear=False):
            yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)
        try:
            root.parent.rmdir()
        except OSError:
            pass


def sample_trajectory(**overrides: Any) -> dict[str, Any]:
    trajectory = {
        "game_id": "2026-04-30-TB-CLE",
        "date": "2026-04-30",
        "market": "totals",
        "matchup": "Tampa Bay Rays @ Cleveland Guardians",
        "home_team": "Cleveland Guardians",
        "away_team": "Tampa Bay Rays",
        "input_snapshot": {
            "probable_pitchers": "confirmed",
            "lineup_status": "projected",
            "weather_status": "missing",
            "odds_status": "fresh",
            "bullpen_status": "available",
            "park_factor_status": "available",
            "data_quality": 72,
        },
        "tool_usage": ["get_today_games", "get_probable_pitchers", "predict_total_runs", "generate_quality_report"],
        "prediction": {
            "final_lean": "Over 8.5",
            "confidence": "Medium",
            "projected_total": 9.0,
            "market_total": 8.5,
            "over_probability": 56,
            "under_probability": 44,
            "model_edge": 2.1,
            "market_odds": {"over": "-110", "under": "-110"},
        },
        "prompt_version": "mlb-analyst-v1.0",
        "rule_version": "rules-v1.0",
        "weight_version": "weights-v1.0",
        "model_version": "baseline-model-v1.0",
    }
    trajectory.update(overrides)
    return trajectory


def final_result(home_score: int = 3, away_score: int = 3) -> dict[str, Any]:
    return {"home_score": home_score, "away_score": away_score, "closing_line": 8.0}
