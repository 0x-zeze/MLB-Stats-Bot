"""Explanation layer for final MLB prediction outputs."""

from __future__ import annotations

from typing import Any

from .utils import format_probability, safe_float


def _join(values: list[str]) -> str:
    return ", ".join(values or ["none"])


def _overall_decision(moneyline: dict[str, Any]) -> str:
    if moneyline.get("decision") == "BET":
        return "BET"
    if moneyline.get("decision") == "LEAN":
        return "LEAN"
    return "NO BET"


def _overall_confidence(moneyline: dict[str, Any]) -> str:
    if _overall_decision(moneyline) == "NO BET":
        return "Low"
    levels = {"Low": 0, "Medium": 1, "High": 2}
    confidence = max(
        (moneyline.get("confidence", "Low"),),
        key=lambda item: levels.get(item, 0),
    )
    return confidence


def _risk_factors(
    market: dict[str, Any],
    quality_report: dict[str, Any],
    moneyline: dict[str, Any],
) -> list[str]:
    risks: list[str] = []
    if moneyline.get("decision") == "NO BET":
        risks.append(f"Moneyline no-bet: {moneyline.get('decision_reason')}")
    if quality_report.get("missing_fields"):
        risks.append(f"Missing data: {_join(quality_report['missing_fields'])}")
    if quality_report.get("stale_fields"):
        risks.append(f"Stale data: {_join(quality_report['stale_fields'])}")
    if not market.get("available"):
        risks.append("Market odds unavailable")
    framework = moneyline.get("risk_framework") or {}
    for warning in framework.get("warnings") or []:
        risks.append(f"Moneyline risk control: {warning}")
    return risks or ["Normal MLB variance; no model output is guaranteed"]

def _fatigue_context(pipeline_result: dict[str, Any]) -> list[str]:
    moneyline_features = pipeline_result.get("features", {}).get("moneyline", {})
    rest = moneyline_features.get("pitcher_rest_adjustment", {})
    team_fatigue = moneyline_features.get("team_fatigue_adjustment", {})
    notes: list[str] = []

    for side in ("away", "home"):
        pitcher = rest.get(side, {})
        rest_days = pitcher.get("rest_days")
        if rest_days is not None and rest_days < 4 and pitcher.get("pitcher"):
            notes.append(f"⚠️ {pitcher['pitcher']} on short rest ({rest_days} days)")

    for side in ("away", "home"):
        fatigue = team_fatigue.get(side, {})
        if fatigue.get("fatigue_level") == "high":
            team = fatigue.get("team") or side
            road_streak = fatigue.get("road_streak", 0)
            if road_streak >= 7:
                notes.append(f"⚠️ {team} showing schedule fatigue ({road_streak}-game road trip)")
            else:
                notes.append(f"⚠️ {team} showing schedule fatigue")

    return notes


def build_prediction_explanation(
    pipeline_result: dict[str, Any],
) -> str:
    """Render the conservative final output in a fixed order."""
    context = pipeline_result["context"]
    moneyline = pipeline_result["moneyline"]
    market = pipeline_result["market"]
    quality = pipeline_result["quality_report"]
    market_comparison = pipeline_result["market_comparison"]
    decision = _overall_decision(moneyline)
    confidence = _overall_confidence(moneyline)
    missing = _join(quality.get("missing_fields", []))
    stale = _join(quality.get("stale_fields", []))
    adjustments = _join(quality.get("confidence_adjustments", []))
    home_team = context["home_team"]["team"]
    away_team = context["away_team"]["team"]
    moneyline_edge = market_comparison.get("moneyline", {}).get("pick_edge")
    final_lean = moneyline.get("raw_lean") or moneyline.get("predicted_winner")
    if decision == "NO BET":
        final_lean = "NO BET"
    risk_factors = _risk_factors(market, quality, moneyline) + _fatigue_context(pipeline_result)
    risk_warning = (
        (moneyline.get("risk_framework") or {}).get("risk_warning")
        or "Model probabilities are estimates, not guarantees."
    )
    stake_units = safe_float((moneyline.get("risk_framework") or {}).get("stake_units"))

    lines = [
        "MLB Game Analysis:",
        "",
        "1. Prediction Summary",
        f"- Matchup: {context['matchup']}",
        f"- Game time: {context['date']}",
        f"- Final lean: {final_lean}",
        "",
        "2. Moneyline Probability",
        "Moneyline prediction:",
        f"- {home_team}: {format_probability(moneyline['home_win_probability'])}",
        f"- {away_team}: {format_probability(moneyline['away_win_probability'])}",
        f"- Predicted winner: {moneyline['predicted_winner']}",
        f"- Moneyline decision: {moneyline['decision']}",
        "",
        "3. Market Comparison",
        f"- Home moneyline: {market.get('home_moneyline', '-')}",
        f"- Away moneyline: {market.get('away_moneyline', '-')}",
        f"- Moneyline edge: {moneyline_edge * 100:+.1f}%" if moneyline_edge is not None else "- Moneyline edge: unavailable",
        "",
        "4. Data Quality Report",
        f"- Score: {quality.get('score', 0)}/100",
        f"- Missing: {missing}",
        f"- Stale: {stale}",
        f"- Confidence adjustments: {adjustments}",
        "",
        "5. Main Supporting Factors",
        *[f"- {factor}" for factor in pipeline_result.get("supporting_factors", [])[:5]],
        "",
        "6. Risk Factors",
        *[f"- {factor}" for factor in risk_factors],
        f"- Risk warning: {risk_warning}",
        "",
        f"7. Final Decision: {decision}",
        f"8. Confidence: {confidence}",
        f"Suggested stake: {stake_units:.2f} units",
        f"No-bet flag: {'YES' if decision == 'NO BET' else 'NO'}",
    ]
    return "\n".join(lines)
