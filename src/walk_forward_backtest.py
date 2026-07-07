"""Walk-forward backtesting with rolling retrain.

Standard backtesting trains on all available data and then predicts the
same period, which can leak future information. Walk-forward backtesting:

1. Train on data up to date T
2. Predict for date T+1 to T+N
3. Roll the training window forward by N days
4. Retrain and repeat

This eliminates lookahead bias and gives a realistic estimate of
out-of-sample performance.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .utils import safe_float

DEFAULT_STEP_DAYS = 30
DEFAULT_MIN_TRAIN_GAMES = 200


@dataclass
class WalkForwardFold:
    """One fold of a walk-forward backtest."""

    train_start: str
    train_end: str
    test_start: str
    test_end: str
    train_games: int = 0
    test_games: int = 0
    predictions: list[dict[str, Any]] = field(default_factory=list)

    @property
    def accuracy(self) -> float:
        correct = sum(1 for p in self.predictions if p.get("correct"))
        total = len([p for p in self.predictions if p.get("result") in ("win", "loss")])
        return correct / total if total > 0 else 0.0

    @property
    def roi(self) -> float:
        settled = [p for p in self.predictions if p.get("result") in ("win", "loss")]
        if not settled:
            return 0.0
        profit = sum(safe_float(p.get("profit_loss", 0), 0) for p in settled)
        return profit / len(settled)

    @property
    def avg_brier(self) -> float:
        scored = [p for p in self.predictions if p.get("brier") is not None]
        if not scored:
            return 0.0
        return sum(safe_float(p.get("brier"), 0) for p in scored) / len(scored)


@dataclass
class WalkForwardResult:
    """Aggregated results across all folds."""

    folds: list[WalkForwardFold] = field(default_factory=list)

    @property
    def total_predictions(self) -> int:
        return sum(len(f.predictions) for f in self.folds)

    @property
    def overall_accuracy(self) -> float:
        correct = sum(1 for f in self.folds for p in f.predictions if p.get("correct"))
        total = len([p for f in self.folds for p in f.predictions if p.get("result") in ("win", "loss")])
        return correct / total if total > 0 else 0.0

    @property
    def overall_roi(self) -> float:
        settled = [p for f in self.folds for p in f.predictions if p.get("result") in ("win", "loss")]
        if not settled:
            return 0.0
        profit = sum(safe_float(p.get("profit_loss", 0), 0) for p in settled)
        return profit / len(settled)

    @property
    def overall_brier(self) -> float:
        scored = [p for f in self.folds for p in f.predictions if p.get("brier") is not None]
        if not scored:
            return 0.0
        return sum(safe_float(p.get("brier"), 0) for p in scored) / len(scored)

    @property
    def accuracy_by_fold(self) -> list[tuple[str, str, float]]:
        return [(f.test_start, f.test_end, f.accuracy) for f in self.folds]

    @property
    def roi_by_fold(self) -> list[tuple[str, str, float]]:
        return [(f.test_start, f.test_end, f.roi) for f in self.folds]


def generate_walk_forward_dates(
    start_date: str,
    end_date: str,
    step_days: int = DEFAULT_STEP_DAYS,
) -> list[tuple[str, str, str, str]]:
    """Generate (train_start, train_end, test_start, test_end) tuples.

    Each fold's training window extends from the original start to just
    before the test window. This is an expanding window, not a rolling one,
    so earlier data is never discarded.
    """
    from datetime import date, datetime, timedelta

    start = datetime.fromisoformat(start_date[:10]).date()
    end = datetime.fromisoformat(end_date[:10]).date()

    folds: list[tuple[str, str, str, str]] = []
    current = start + timedelta(days=step_days)

    while current < end:
        test_end = min(current + timedelta(days=step_days), end)
        folds.append((
            start.isoformat(),
            (current - timedelta(days=1)).isoformat(),
            current.isoformat(),
            test_end.isoformat(),
        ))
        current = test_end

    return folds


def run_walk_forward(
    games: list[dict[str, Any]],
    predict_fn: Callable[[list[dict[str, Any]], list[dict[str, Any]]], list[dict[str, Any]]],
    step_days: int = DEFAULT_STEP_DAYS,
    min_train_games: int = DEFAULT_MIN_TRAIN_GAMES,
) -> WalkForwardResult:
    """Run a walk-forward backtest.

    Args:
        games: List of game dicts sorted by date. Each must have a "date" field.
        predict_fn: A function (train_games, test_games) -> list[prediction_rows]
            that trains on train_games and returns predictions for test_games.
        step_days: Number of days per test fold.
        min_train_games: Minimum training games before generating predictions.

    Returns:
        WalkForwardResult with all folds and predictions.
    """
    if not games:
        return WalkForwardResult()

    dates = sorted(str(g.get("date", "")) for g in games if g.get("date"))
    if not dates:
        return WalkForwardResult()

    folds = generate_walk_forward_dates(dates[0], dates[-1], step_days)
    result = WalkForwardResult()

    for train_start, train_end, test_start, test_end in folds:
        train_games = [
            g for g in games
            if train_start <= str(g.get("date", "")) <= train_end
        ]
        test_games = [
            g for g in games
            if test_start <= str(g.get("date", "")) <= test_end
        ]

        if len(train_games) < min_train_games or not test_games:
            continue

        try:
            predictions = predict_fn(train_games, test_games)
        except Exception:
            predictions = []

        fold = WalkForwardFold(
            train_start=train_start,
            train_end=train_end,
            test_start=test_start,
            test_end=test_end,
            train_games=len(train_games),
            test_games=len(test_games),
            predictions=predictions,
        )
        result.folds.append(fold)

    return result


def walk_forward_summary(result: WalkForwardResult) -> dict[str, Any]:
    """Return a printable summary of walk-forward results."""
    return {
        "folds": len(result.folds),
        "total_predictions": result.total_predictions,
        "overall_accuracy": round(result.overall_accuracy, 4),
        "overall_roi": round(result.overall_roi, 4),
        "overall_brier": round(result.overall_brier, 4),
        "accuracy_by_fold": [
            {"start": s, "end": e, "accuracy": round(a, 4)}
            for s, e, a in result.accuracy_by_fold
        ],
        "roi_by_fold": [
            {"start": s, "end": e, "roi": round(r, 4)}
            for s, e, r in result.roi_by_fold
        ],
    }
