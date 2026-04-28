"""Evaluate logged MLB predictions and produce reports."""

from __future__ import annotations

import argparse
from collections import defaultdict
from pathlib import Path
from typing import Any

from .calibration import brier_score, calibration_by_confidence, calibration_table, log_loss
from .data_loader import read_csv
from .reports import format_calibration_report, format_group_report, format_metrics, market_total_range
from .utils import data_path, safe_float


def load_prediction_log(path: str | Path | None = None) -> list[dict[str, str]]:
    """Load prediction log rows."""
    source = Path(path) if path else data_path("predictions_log.csv")
    if not source.exists():
        return []
    return read_csv(source)


def settled_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rows with a win/loss outcome."""
    return [row for row in rows if str(row.get("result", "")).lower() in {"win", "loss"}]


def row_probability(row: dict[str, Any]) -> float:
    """Return probability attached to the final lean."""
    lean = str(row.get("final_lean", ""))
    if lean.startswith("Over"):
        return safe_float(row.get("over_probability"), 0.0)
    if lean.startswith("Under"):
        return safe_float(row.get("under_probability"), 0.0)
    if lean and lean == row.get("home_team"):
        return safe_float(row.get("home_win_probability"), 0.0)
    if lean and lean == row.get("away_team"):
        return safe_float(row.get("away_win_probability"), 0.0)
    home_prob = safe_float(row.get("home_win_probability"), 0.0)
    away_prob = safe_float(row.get("away_win_probability"), 0.0)
    return max(home_prob, away_prob, safe_float(row.get("over_probability"), 0.0), safe_float(row.get("under_probability"), 0.0))


def row_won(row: dict[str, Any]) -> int:
    """Return 1 for win, 0 for loss."""
    return 1 if str(row.get("result", "")).lower() == "win" else 0


def calculate_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Calculate accuracy, ROI, edge, CLV, Brier score, and log loss."""
    bets = settled_rows(rows)
    if not bets:
        return {
            "bets": 0,
            "wins": 0,
            "losses": 0,
            "accuracy": 0.0,
            "win_rate": 0.0,
            "roi": 0.0,
            "average_edge": 0.0,
            "average_clv": 0.0,
            "brier_score": 0.0,
            "log_loss": 0.0,
        }

    wins = sum(row_won(row) for row in bets)
    probabilities = [row_probability(row) for row in bets]
    outcomes = [row_won(row) for row in bets]
    profit = sum(safe_float(row.get("profit_loss"), 0.0) for row in bets)
    return {
        "bets": len(bets),
        "wins": wins,
        "losses": len(bets) - wins,
        "accuracy": wins / len(bets),
        "win_rate": wins / len(bets),
        "roi": profit / len(bets),
        "average_edge": sum(safe_float(row.get("model_edge"), 0.0) for row in bets) / len(bets),
        "average_clv": sum(safe_float(row.get("closing_line_value"), 0.0) for row in bets) / len(bets),
        "brier_score": brier_score(probabilities, outcomes),
        "log_loss": log_loss(probabilities, outcomes),
    }


def group_metrics(rows: list[dict[str, Any]], key_fn) -> dict[str, dict[str, Any]]:
    """Calculate metrics by arbitrary grouping function."""
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[key_fn(row)].append(row)
    return {key: calculate_metrics(value) for key, value in groups.items()}


def performance_by_market_total(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Metrics grouped by market total range."""
    return group_metrics(rows, lambda row: market_total_range(row.get("market_total")))


def performance_by_confidence(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Metrics grouped by confidence label."""
    return group_metrics(rows, lambda row: str(row.get("confidence", "unknown")).lower() or "unknown")


def calibration_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rows shaped for calibration helpers."""
    return [
        {
            "probability": row_probability(row),
            "won": row_won(row),
        }
        for row in settled_rows(rows)
    ]


def build_report(rows: list[dict[str, Any]]) -> str:
    """Build a text evaluation report."""
    metrics = calculate_metrics(rows)
    calibration_input = calibration_rows(rows)
    lines = [
        format_metrics(metrics),
        "",
        *format_group_report(performance_by_confidence(rows), "Performance by Confidence"),
        "",
        *format_group_report(performance_by_market_total(rows), "Performance by Market Total"),
        "",
        *format_calibration_report(calibration_table(calibration_input), "Calibration by Probability"),
        "",
        *format_calibration_report(calibration_by_confidence(calibration_input), "Calibration by Confidence"),
    ]
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate MLB prediction logs.")
    parser.add_argument("--log", default=str(data_path("predictions_log.csv")), help="Predictions log CSV")
    parser.add_argument("--market", choices=["moneyline", "totals", "all"], default="all")
    parser.add_argument("--report", action="store_true", help="Print evaluation report")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rows = load_prediction_log(args.log)
    if args.market != "all":
        if args.market == "moneyline":
            rows = [row for row in rows if not str(row.get("final_lean", "")).startswith(("Over", "Under"))]
        if args.market == "totals":
            rows = [row for row in rows if str(row.get("final_lean", "")).startswith(("Over", "Under", "NO BET"))]
    if args.report:
        print(build_report(rows))
    else:
        metrics = calculate_metrics(rows)
        print(format_metrics(metrics))


if __name__ == "__main__":
    main()

