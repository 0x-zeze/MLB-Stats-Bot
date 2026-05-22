"""Rolling backtest automation and scheduling."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any

from .backtest_segments import segment_summary, tag_game_segments
from .utils import safe_float


@dataclass
class BacktestWindow:
    """Result of a rolling backtest window."""

    start_date: str
    end_date: str
    games: int = 0
    wins: int = 0
    losses: int = 0
    no_bets: int = 0
    total_profit_loss: float = 0.0
    roi: float = 0.0
    brier_score: float = 0.0
    log_loss: float = 0.0
    clv_avg: float = 0.0
    segments: dict[str, dict[str, Any]] = field(default_factory=dict)


def run_rolling_backtest(
    prediction_log: list[dict[str, Any]],
    lookback_days: int = 14,
    end_date: str | date | None = None,
) -> BacktestWindow:
    """Run backtest over the last N days with full segment breakdown."""
    if end_date is None:
        target_end = date.today()
    elif isinstance(end_date, str):
        target_end = datetime.fromisoformat(end_date).date()
    else:
        target_end = end_date

    target_start = target_end - timedelta(days=lookback_days)

    filtered = []
    for row in prediction_log:
        row_date_str = row.get("date", row.get("game_date", ""))
        if not row_date_str:
            continue
        try:
            row_date = datetime.fromisoformat(str(row_date_str)).date()
        except (ValueError, TypeError):
            continue
        if target_start <= row_date <= target_end:
            segments = tag_game_segments(row)
            filtered.append({**row, "segments": segments})

    if not filtered:
        return BacktestWindow(
            start_date=target_start.isoformat(),
            end_date=target_end.isoformat(),
        )

    wins = sum(1 for r in filtered if r.get("result") == "win")
    losses = sum(1 for r in filtered if r.get("result") == "loss")
    no_bets = sum(1 for r in filtered if r.get("result") == "no_bet")
    total_profit = sum(safe_float(r.get("profit_loss", 0), 0) for r in filtered)
    total_wagered = wins + losses

    brier = _compute_brier(filtered)
    log_loss_val = _compute_log_loss(filtered)
    clv = _compute_avg_clv(filtered)

    segment_data = {}
    for key in ("venue", "role", "time", "confidence", "edge_size", "total_range"):
        seg = segment_summary(filtered, key)
        if seg:
            segment_data[key] = seg

    return BacktestWindow(
        start_date=target_start.isoformat(),
        end_date=target_end.isoformat(),
        games=len(filtered),
        wins=wins,
        losses=losses,
        no_bets=no_bets,
        total_profit_loss=round(total_profit, 2),
        roi=round(total_profit / max(total_wagered, 1), 4),
        brier_score=round(brier, 4),
        log_loss=round(log_loss_val, 4),
        clv_avg=round(clv, 4),
        segments=segment_data,
    )


def _compute_brier(results: list[dict[str, Any]]) -> float:
    """Compute Brier score from prediction results."""
    scored = [
        r for r in results
        if r.get("result") in ("win", "loss")
        and r.get("win_probability") is not None
    ]
    if not scored:
        return 0.0

    total = 0.0
    for r in scored:
        prob = safe_float(r.get("win_probability"), 0.5)
        actual = 1.0 if r.get("result") == "win" else 0.0
        total += (prob - actual) ** 2

    return total / len(scored)


def _compute_log_loss(results: list[dict[str, Any]]) -> float:
    """Compute log loss from prediction results."""
    import math

    scored = [
        r for r in results
        if r.get("result") in ("win", "loss")
        and r.get("win_probability") is not None
    ]
    if not scored:
        return 0.0

    total = 0.0
    eps = 1e-7
    for r in scored:
        prob = max(eps, min(1 - eps, safe_float(r.get("win_probability"), 0.5)))
        actual = 1.0 if r.get("result") == "win" else 0.0
        total += -(actual * math.log(prob) + (1 - actual) * math.log(1 - prob))

    return total / len(scored)


def _compute_avg_clv(results: list[dict[str, Any]]) -> float:
    """Compute average closing line value."""
    clv_values = [
        safe_float(r.get("clv", r.get("closing_line_value")), None)
        for r in results
    ]
    valid = [v for v in clv_values if v is not None]
    if not valid:
        return 0.0
    return sum(valid) / len(valid)


def schedule_weekly_backtest() -> dict[str, Any]:
    """Return configuration for automated weekly backtest execution."""
    return {
        "frequency": "weekly",
        "day": "monday",
        "lookback_days": 14,
        "markets": ["moneyline", "totals"],
        "report_format": "json",
        "auto_run": True,
    }
