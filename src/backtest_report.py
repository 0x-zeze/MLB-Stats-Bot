"""Automated performance report generation for backtests."""

from __future__ import annotations

from typing import Any

from .utils import safe_float


def generate_performance_report(
    window: Any,
    include_clv: bool = True,
) -> dict[str, Any]:
    """Generate structured performance report with segment breakdowns."""
    report: dict[str, Any] = {
        "period": {
            "start": window.start_date,
            "end": window.end_date,
        },
        "overall": {
            "games": window.games,
            "wins": window.wins,
            "losses": window.losses,
            "no_bets": window.no_bets,
            "win_rate": round(window.wins / max(window.wins + window.losses, 1), 4),
            "total_profit_loss": window.total_profit_loss,
            "roi": window.roi,
            "brier_score": window.brier_score,
            "log_loss": window.log_loss,
        },
        "segments": window.segments,
        "health": _assess_health(window),
    }

    if include_clv:
        report["overall"]["clv_avg"] = window.clv_avg
        report["clv_analysis"] = _analyze_clv(window.clv_avg, window.games)

    return report


def _assess_health(window: Any) -> dict[str, Any]:
    """Assess overall model health from backtest metrics."""
    issues: list[str] = []
    status = "healthy"

    total_decided = window.wins + window.losses
    if total_decided > 0:
        win_rate = window.wins / total_decided
        if win_rate < 0.48:
            issues.append(f"Win rate below 48% ({win_rate:.1%})")
            status = "degraded"
        if win_rate < 0.44:
            status = "critical"

    if window.brier_score > 0.26:
        issues.append(f"Brier score elevated ({window.brier_score:.4f})")
        if status == "healthy":
            status = "degraded"

    if window.roi < -0.10:
        issues.append(f"Negative ROI ({window.roi:.1%})")
        if status == "healthy":
            status = "degraded"

    no_bet_rate = window.no_bets / max(window.games, 1)
    if no_bet_rate > 0.60:
        issues.append(f"High NO BET rate ({no_bet_rate:.1%})")

    return {
        "status": status,
        "issues": issues,
        "recommendations": _generate_recommendations(issues, window),
    }


def _generate_recommendations(issues: list[str], window: Any) -> list[str]:
    """Generate actionable recommendations from health issues."""
    recs: list[str] = []

    if any("Win rate" in i for i in issues):
        recs.append("Review confidence calibration — model may be overconfident")

    if any("Brier" in i for i in issues):
        recs.append("Check probability calibration by bucket for systematic bias")

    if any("ROI" in i for i in issues):
        recs.append("Review edge thresholds — minimum edge may need increasing")

    if any("NO BET" in i for i in issues):
        recs.append("Data quality may be degraded — check data source freshness")

    if not recs:
        recs.append("Model performing within expected parameters")

    return recs


def _analyze_clv(clv_avg: float, games: int) -> dict[str, Any]:
    """Analyze closing line value performance."""
    if games < 10:
        return {"status": "insufficient_data", "games": games}

    if clv_avg > 0.01:
        assessment = "positive"
        note = "Model consistently beats closing line — strong edge signal"
    elif clv_avg > -0.005:
        assessment = "neutral"
        note = "Model tracks closing line — edge is marginal"
    else:
        assessment = "negative"
        note = "Model trails closing line — edge may be illusory"

    return {
        "status": assessment,
        "clv_avg": round(clv_avg, 4),
        "note": note,
        "games": games,
    }


def format_report_text(report: dict[str, Any]) -> str:
    """Format report as human-readable text for Telegram or CLI."""
    overall = report["overall"]
    health = report["health"]
    period = report["period"]

    lines = [
        f"Performance Report: {period['start']} to {period['end']}",
        "",
        f"Games: {overall['games']} | W: {overall['wins']} | L: {overall['losses']} | NB: {overall['no_bets']}",
        f"Win Rate: {overall['win_rate']:.1%} | ROI: {overall['roi']:.1%}",
        f"Brier: {overall['brier_score']:.4f} | Log Loss: {overall['log_loss']:.4f}",
    ]

    if "clv_avg" in overall:
        lines.append(f"CLV Avg: {overall['clv_avg']:+.4f}")

    lines.extend(["", f"Health: {health['status'].upper()}"])
    if health["issues"]:
        for issue in health["issues"]:
            lines.append(f"  - {issue}")

    return "\n".join(lines)
