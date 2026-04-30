"""Prediction quality-control checks for betting-facing MLB outputs."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .data_freshness import check_data_freshness
from .utils import safe_float


CONFIRMED = "Confirmed"
PROJECTED = "Projected"
AVAILABLE = "Available"
MISSING = "Missing"
FRESH = "Fresh"
STALE = "Stale"
STABLE = "Stable"
MOVED_HEAVILY = "Moved heavily"

_CONFIDENCE_LEVELS = ("Low", "Medium", "High")


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y", "confirmed"}


def _available(value: Any) -> bool:
    return bool(value) and not (isinstance(value, dict) and value.get("available") is False)


def _field(value: Any, key: str, default: Any = None) -> Any:
    return value.get(key, default) if isinstance(value, dict) else default


def _pair_status(pair: dict[str, Any] | None, required_available: bool = True) -> bool:
    if not isinstance(pair, dict):
        return False
    home = pair.get("home")
    away = pair.get("away")
    if required_available:
        return _available(home) and _available(away)
    return home is not None and away is not None


def _timestamp_status(payload: dict[str, Any] | None, max_age_minutes: int) -> str:
    if not _available(payload):
        return MISSING
    timestamp = _field(payload, "data_timestamp") or _field(payload, "timestamp") or _field(payload, "updated_at")
    return check_data_freshness(timestamp, max_age_minutes).title()


def _probable_pitcher_status(game_context: dict[str, Any]) -> str:
    pitchers = game_context.get("probable_pitchers")
    if not _pair_status(pitchers, required_available=False):
        return MISSING

    values = [pitchers.get("home"), pitchers.get("away")]
    if any(not _available(item) for item in values):
        return MISSING
    if any(_as_bool(_field(item, "projected")) or str(_field(item, "status", "")).lower() == "projected" for item in values):
        return PROJECTED
    return CONFIRMED


def _lineup_status(game_context: dict[str, Any]) -> str:
    lineups = game_context.get("lineup") or game_context.get("lineups")
    if not _pair_status(lineups, required_available=False):
        return MISSING

    values = [lineups.get("home"), lineups.get("away")]
    if any(not _available(item) for item in values):
        return MISSING
    if all(_as_bool(_field(item, "confirmed")) for item in values):
        return CONFIRMED
    return PROJECTED


def _weather_status(game_context: dict[str, Any]) -> str:
    return _timestamp_status(game_context.get("weather"), 90)


def _odds_status(game_context: dict[str, Any]) -> str:
    market = game_context.get("market") or game_context.get("odds")
    if not _available(market):
        return MISSING
    has_odds = any(
        _field(market, key) not in (None, "")
        for key in ("home_moneyline", "away_moneyline", "over_odds", "under_odds")
    )
    if not has_odds:
        return MISSING
    return _timestamp_status(market, 15)


def _bullpen_status(game_context: dict[str, Any]) -> str:
    bullpens = game_context.get("bullpen") or game_context.get("bullpen_usage")
    return AVAILABLE if _pair_status(bullpens) else MISSING


def _park_status(game_context: dict[str, Any]) -> str:
    return AVAILABLE if _available(game_context.get("park") or game_context.get("park_factor")) else MISSING


def _market_total_status(game_context: dict[str, Any]) -> str:
    market = game_context.get("market") or game_context.get("odds")
    return AVAILABLE if _available(market) and safe_float(_field(market, "market_total"), 0.0) > 0 else MISSING


def _market_odds_status(game_context: dict[str, Any]) -> str:
    return AVAILABLE if _odds_status(game_context) in {FRESH, STALE} else MISSING


def _market_movement_status(game_context: dict[str, Any]) -> str:
    market = game_context.get("market") or game_context.get("odds")
    if not _available(market):
        return MISSING
    opening = safe_float(_field(market, "opening_total"), 0.0)
    current = safe_float(_field(market, "current_total"), 0.0) or safe_float(_field(market, "market_total"), 0.0)
    if opening <= 0 or current <= 0:
        return MISSING
    return MOVED_HEAVILY if abs(current - opening) >= 0.75 else STABLE


def _injury_news_status(game_context: dict[str, Any]) -> str:
    news = game_context.get("injury_news") or game_context.get("injuries")
    return AVAILABLE if _available(news) else MISSING


def _is_outdoor(game_context: dict[str, Any]) -> bool:
    weather = game_context.get("weather") or {}
    roof = str(_field(weather, "roof", "open")).strip().lower()
    return roof not in {"closed", "dome", "retractable closed"}


def _calibration_supports_high(game_context: dict[str, Any]) -> bool:
    calibration = game_context.get("calibration") or {}
    return _as_bool(_field(calibration, "supports_high_confidence"))


def _opener_entries(game_context: dict[str, Any]) -> list[dict[str, Any]]:
    situation = game_context.get("opener_situation") or game_context.get("opener")
    if not isinstance(situation, dict):
        return []
    if "is_opener" in situation:
        return [situation]
    return [item for item in situation.values() if isinstance(item, dict)]


def _opener_confidence(game_context: dict[str, Any]) -> str:
    confidences = {
        str(item.get("confidence", "")).strip().lower()
        for item in _opener_entries(game_context)
        if _as_bool(item.get("is_opener"))
    }
    if "high" in confidences:
        return "high"
    if "medium" in confidences:
        return "medium"
    if "low" in confidences:
        return "low"
    return ""


def _opener_quality_penalty(game_context: dict[str, Any]) -> int:
    confidence = _opener_confidence(game_context)
    if confidence == "high":
        return 10
    if confidence == "medium":
        return 5
    return 0


def check_prediction_inputs(game_context: dict[str, Any]) -> dict[str, str]:
    """Classify every required prediction input as available, missing, or stale."""
    return {
        "probable_pitchers": _probable_pitcher_status(game_context),
        "lineup": _lineup_status(game_context),
        "weather": _weather_status(game_context),
        "odds": _odds_status(game_context),
        "bullpen_usage": _bullpen_status(game_context),
        "park_factor": _park_status(game_context),
        "market_total": _market_total_status(game_context),
        "market_odds": _market_odds_status(game_context),
        "market_movement": _market_movement_status(game_context),
        "injury_news": _injury_news_status(game_context),
    }


def calculate_data_quality_score(game_context: dict[str, Any]) -> int:
    """Return a 0-100 data-quality score for the pre-game context."""
    checks = check_prediction_inputs(game_context)
    score = 0
    if checks["probable_pitchers"] == CONFIRMED:
        score += 20
    elif checks["probable_pitchers"] == PROJECTED:
        score += 10

    if checks["lineup"] == CONFIRMED:
        score += 15
    elif checks["lineup"] == PROJECTED:
        score += 7

    if checks["weather"] == FRESH:
        score += 10
    if checks["odds"] == FRESH:
        score += 15
    if checks["bullpen_usage"] == AVAILABLE:
        score += 15
    if checks["park_factor"] == AVAILABLE:
        score += 10
    if checks["market_total"] == AVAILABLE:
        score += 10
    if checks["injury_news"] == AVAILABLE:
        score += 5

    score -= _opener_quality_penalty(game_context)

    return max(0, min(100, score))


def generate_quality_report(game_context: dict[str, Any]) -> dict[str, Any]:
    """Build a compact quality report consumed by predictions and Telegram output."""
    checks = check_prediction_inputs(game_context)
    score = calculate_data_quality_score(game_context)
    missing_fields = [
        label
        for key, label in {
            "probable_pitchers": "probable pitchers",
            "lineup": "lineup",
            "weather": "weather",
            "odds": "odds",
            "bullpen_usage": "bullpen usage",
            "park_factor": "park factor",
            "market_total": "market total",
            "market_odds": "market odds",
            "injury_news": "injury/news context",
        }.items()
        if checks.get(key) == MISSING
    ]
    stale_fields = [
        label
        for key, label in {"weather": "weather", "odds": "odds"}.items()
        if checks.get(key) == STALE
    ]

    projected_fields = [
        label
        for key, label in {"probable_pitchers": "probable pitchers", "lineup": "lineup"}.items()
        if checks.get(key) == PROJECTED
    ]
    opener_confidence = _opener_confidence(game_context)
    no_bet_considerations = []
    if opener_confidence in {"high", "medium"}:
        no_bet_considerations.append("opener_situation")

    return {
        **checks,
        "score": score,
        "missing_fields": missing_fields,
        "stale_fields": stale_fields,
        "projected_fields": projected_fields,
        "opener_situation": opener_confidence or "none",
        "no_bet_considerations": no_bet_considerations,
        "weather_outdoor": _is_outdoor(game_context),
        "calibration_supports_high": _calibration_supports_high(game_context),
        "confidence_adjustments": [],
    }


def _normalize_confidence(value: Any) -> str:
    text = str(value or "Low").strip().title()
    return text if text in _CONFIDENCE_LEVELS else "Low"


def _cap_confidence(confidence: str, cap: str) -> str:
    current_index = _CONFIDENCE_LEVELS.index(_normalize_confidence(confidence))
    cap_index = _CONFIDENCE_LEVELS.index(_normalize_confidence(cap))
    return _CONFIDENCE_LEVELS[min(current_index, cap_index)]


def _downgrade(confidence: str) -> str:
    index = _CONFIDENCE_LEVELS.index(_normalize_confidence(confidence))
    return _CONFIDENCE_LEVELS[max(0, index - 1)]


def _total_difference(prediction: dict[str, Any]) -> float | None:
    projected = prediction.get("projected_total_runs")
    market = prediction.get("market_total")
    if projected is None or market is None:
        return None
    return abs(safe_float(projected) - safe_float(market))


def apply_confidence_downgrade(
    prediction: dict[str, Any],
    quality_report: dict[str, Any],
) -> dict[str, Any]:
    """Apply no-bet and confidence downgrade rules before final output."""
    output = deepcopy(prediction)
    original_confidence = _normalize_confidence(output.get("confidence"))
    confidence = original_confidence
    adjustments: list[str] = []
    reasons: list[str] = []
    no_bet = False

    edge = output.get("model_edge")
    edge_value = safe_float(edge, None)
    market_type = str(output.get("market_type", "")).lower()

    if quality_report.get("probable_pitchers") == MISSING:
        no_bet = True
        reasons.append("probable pitcher missing")

    consideration_notes = list(quality_report.get("no_bet_considerations") or [])
    if "opener_situation" in consideration_notes:
        adjustments.append("opener situation: SP role unclear")

    if edge_value is None:
        no_bet = True
        reasons.append("model edge unavailable")
    elif abs(edge_value) < 0.02:
        no_bet = True
        reasons.append("model edge below 2%")

    if market_type == "totals":
        total_diff = _total_difference(output)
        if total_diff is None:
            no_bet = True
            reasons.append("market total unavailable")
        elif total_diff < 0.4:
            no_bet = True
            reasons.append("projected total difference below 0.4 runs")

    score = int(quality_report.get("score", 0))
    if score < 60:
        no_bet = True
        reasons.append("data quality score below 60")

    if quality_report.get("odds") == STALE:
        confidence = _downgrade(confidence)
        adjustments.append("odds stale: confidence downgraded")

    if quality_report.get("weather") == STALE and quality_report.get("weather_outdoor"):
        confidence = _downgrade(confidence)
        adjustments.append("outdoor weather stale: confidence downgraded")

    if quality_report.get("lineup") in {PROJECTED, MISSING}:
        new_confidence = _cap_confidence(confidence, "Medium")
        if new_confidence != confidence:
            adjustments.append("lineup not confirmed: confidence capped at Medium")
        confidence = new_confidence

    if quality_report.get("probable_pitchers") == PROJECTED:
        new_confidence = _cap_confidence(confidence, "Medium")
        if new_confidence != confidence:
            adjustments.append("probable pitcher projected: confidence capped at Medium")
        confidence = new_confidence

    if 60 <= score < 75:
        new_confidence = _cap_confidence(confidence, "Low")
        if new_confidence != confidence:
            adjustments.append("data quality 60-74: confidence capped at Low")
        confidence = new_confidence
    elif 75 <= score < 85:
        new_confidence = _cap_confidence(confidence, "Medium")
        if new_confidence != confidence:
            adjustments.append("data quality 75-84: confidence capped at Medium")
        confidence = new_confidence
    elif score >= 85 and confidence == "High" and not quality_report.get("calibration_supports_high"):
        confidence = "Medium"
        adjustments.append("calibration does not support High: confidence capped at Medium")

    raw_lean = output.get("final_lean") or output.get("predicted_winner") or output.get("best_total_lean")
    if no_bet:
        decision = "NO BET"
        final_lean = "NO BET"
    elif confidence == "High" and edge_value is not None and abs(edge_value) >= 0.04:
        decision = "BET"
        final_lean = raw_lean
    else:
        decision = "LEAN"
        final_lean = raw_lean

    quality_report = deepcopy(quality_report)
    quality_report["confidence_adjustments"] = adjustments

    output.update(
        {
            "original_confidence": original_confidence,
            "confidence": confidence,
            "raw_lean": raw_lean,
            "final_lean": final_lean,
            "decision": decision,
            "decision_reason": "; ".join(reasons) if reasons else "quality checks passed",
            "confidence_adjustments": adjustments,
            "no_bet_considerations": consideration_notes,
            "data_quality_score": score,
            "quality_report": quality_report,
            "no_bet": decision == "NO BET",
        }
    )
    return output


def format_quality_report(quality_report: dict[str, Any]) -> str:
    """Render a short human-readable data quality report."""
    missing = ", ".join(quality_report.get("missing_fields") or ["none"])
    stale = ", ".join(quality_report.get("stale_fields") or ["none"])
    considerations = ", ".join(quality_report.get("no_bet_considerations") or ["none"])
    adjustments = ", ".join(quality_report.get("confidence_adjustments") or ["none"])
    return "\n".join(
        [
            "Data Quality Report:",
            f"- Probable pitchers: {quality_report.get('probable_pitchers', MISSING)}",
            f"- Lineup: {quality_report.get('lineup', MISSING)}",
            f"- Weather: {quality_report.get('weather', MISSING)}",
            f"- Odds: {quality_report.get('odds', MISSING)}",
            f"- Bullpen usage: {quality_report.get('bullpen_usage', MISSING)}",
            f"- Park factor: {quality_report.get('park_factor', MISSING)}",
            f"- Market movement: {quality_report.get('market_movement', MISSING)}",
            f"- Opener situation: {quality_report.get('opener_situation', 'none')}",
            f"- Data quality score: {quality_report.get('score', 0)}/100",
            f"- Missing: {missing}",
            f"- Stale: {stale}",
            f"- No-bet considerations: {considerations}",
            f"- Confidence adjustments: {adjustments}",
        ]
    )
