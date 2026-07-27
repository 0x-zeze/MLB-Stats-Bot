"""Text report helpers for backtest and evaluation outputs."""

from __future__ import annotations

from typing import Any

from .utils import safe_float


def market_total_range(value: float | int | str | None) -> str:
    """Bucket market totals for performance reports."""
    total = safe_float(value, 0.0)
    if 6.5 <= total <= 7.5:
        return "6.5 to 7.5"
    if 8.0 <= total <= 8.5:
        return "8.0 to 8.5"
    if 9.0 <= total <= 9.5:
        return "9.0 to 9.5"
    if total >= 10.0:
        return "10.0+"
    return "other"


def pct(value: float) -> str:
    """Format a decimal as percent."""
    return f"{safe_float(value) * 100:.1f}%"


def signed_pct(value: float) -> str:
    """Format a signed decimal as percent points."""
    return f"{safe_float(value) * 100:+.1f}%"


def _metric_or_na(value: Any, formatter) -> str:
    """Format a metric, or n/a when unavailable (None)."""
    if value is None:
        return "n/a"
    return formatter(value)


def format_metrics(metrics: dict[str, Any], title: str = "MLB Evaluation Report") -> str:
    """Render a minimal evaluation report."""
    lines = [
        title,
        f"Bets: {metrics.get('bets', 0)}",
        f"Accuracy: {_metric_or_na(metrics.get('accuracy'), pct)}",
        f"Win rate: {_metric_or_na(metrics.get('win_rate'), pct)}",
        f"ROI: {_metric_or_na(metrics.get('roi'), signed_pct)}",
        f"Avg edge: {_metric_or_na(metrics.get('average_edge'), signed_pct)}",
        f"Avg CLV: {_metric_or_na(metrics.get('average_clv'), lambda v: f'{safe_float(v, 0.0):+.2f}')}",
        f"Brier: {_metric_or_na(metrics.get('brier_score'), lambda v: f'{safe_float(v, 0.0):.4f}')}",
        f"Log loss: {_metric_or_na(metrics.get('log_loss'), lambda v: f'{safe_float(v, 0.0):.4f}')}",
    ]
    if metrics.get("total_units_staked") is not None:
        lines.append(f"Units staked: {safe_float(metrics.get('total_units_staked'), 0.0):.2f}")
    if metrics.get("clv_coverage") is not None:
        lines.append(f"CLV coverage: {metrics.get('clv_coverage')}/{metrics.get('bets', 0)}")
    return "\n".join(lines)


def format_group_report(groups: dict[str, dict[str, Any]], title: str) -> list[str]:
    """Render compact grouped metrics."""
    lines = [title]
    for key, metrics in groups.items():
        lines.append(
            f"- {key}: {metrics.get('wins', 0)}/{metrics.get('bets', 0)} "
            f"ROI {signed_pct(metrics.get('roi', 0.0))}"
        )
    return lines


def format_calibration_report(rows: list[dict[str, Any]], title: str = "Calibration") -> list[str]:
    """Render calibration table rows."""
    lines = [title]
    for row in rows:
        label = row.get("bucket") or row.get("confidence")
        lines.append(
            f"- {label}: n={row.get('count', 0)} "
            f"pred {pct(row.get('avg_probability', 0.0))} "
            f"actual {pct(row.get('actual_rate', 0.0))} "
            f"err {signed_pct(row.get('calibration_error', 0.0))}"
        )
    return lines

