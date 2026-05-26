"""Risk and staking controls for betting-facing prediction output."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .utils import clamp, safe_float


RISK_WARNING = (
    "This is model output for analysis only and is not guaranteed betting advice. "
    "Use small stakes, respect exposure limits, and skip picks when data is weak."
)

DEFAULT_RISK_SETTINGS: dict[str, Any] = {
    "stake_mode": "flat",
    "flat_stake_units": 1.0,
    "bankroll_units": 100.0,
    "kelly_fraction": 0.25,
    "max_stake_units": 1.0,
    "max_daily_exposure_units": 3.0,
    "current_daily_exposure_units": 0.0,
    "max_pick_confidence": 0.64,
    "minimum_data_quality_score": 60,
    "no_bet_on_stale_fields": ("lineup", "probable_pitchers", "odds"),
}


def _merge_settings(settings: dict[str, Any] | None) -> dict[str, Any]:
    merged = dict(DEFAULT_RISK_SETTINGS)
    if settings:
        merged.update(settings)
    return merged


def american_odds_to_profit_multiple(odds: Any) -> float | None:
    """Return net profit per 1 unit staked for American odds."""
    value = safe_float(odds, 0.0)
    if value == 0:
        return None
    if value > 0:
        return value / 100.0
    return 100.0 / abs(value)


def _prediction_probability(prediction: dict[str, Any]) -> float | None:
    for key in ("model_probability", "win_probability", "probability"):
        if prediction.get(key) not in (None, ""):
            parsed = safe_float(prediction.get(key), 0.0)
            return parsed / 100.0 if parsed > 1.0 else parsed

    home = prediction.get("home_win_probability")
    away = prediction.get("away_win_probability")
    if home not in (None, "") or away not in (None, ""):
        home_prob = safe_float(home, 0.0)
        away_prob = safe_float(away, 0.0)
        probability = max(home_prob, away_prob)
        return probability / 100.0 if probability > 1.0 else probability
    return None


def _status_is_stale(quality_report: dict[str, Any], field: str) -> bool:
    if str(quality_report.get(field, "")).strip().lower() == "stale":
        return True
    stale_fields = {str(item).strip().lower().replace(" ", "_") for item in quality_report.get("stale_fields", [])}
    aliases = {
        "lineup": {"lineup", "lineups"},
        "probable_pitchers": {"probable_pitchers", "probable_pitcher", "probable pitchers"},
        "odds": {"odds", "market_odds", "market odds"},
    }
    return bool(stale_fields.intersection(aliases.get(field, {field})))


def _append_reason(existing: str | None, reason: str) -> str:
    text = str(existing or "").strip()
    if not text or text == "quality checks passed":
        return reason
    if reason.lower() in text.lower():
        return text
    return f"{text}; {reason}"


def _available_exposure(settings: dict[str, Any]) -> float:
    max_daily = safe_float(settings.get("max_daily_exposure_units"), 0.0)
    used = safe_float(settings.get("current_daily_exposure_units"), 0.0)
    if max_daily <= 0:
        return 0.0
    return max(0.0, max_daily - used)


def _flat_stake(settings: dict[str, Any]) -> float:
    return safe_float(settings.get("flat_stake_units"), 1.0)


def _kelly_stake_units(prediction: dict[str, Any], probability: float | None, settings: dict[str, Any]) -> float:
    if probability is None:
        return 0.0
    odds = prediction.get("american_odds") or prediction.get("odds") or prediction.get("current_odds")
    profit_multiple = american_odds_to_profit_multiple(odds)
    if not profit_multiple:
        return 0.0

    probability = clamp(probability, 0.0, 1.0)
    loss_probability = 1.0 - probability
    full_kelly = ((profit_multiple * probability) - loss_probability) / profit_multiple
    if full_kelly <= 0:
        return 0.0
    fraction = clamp(safe_float(settings.get("kelly_fraction"), 0.25), 0.0, 1.0)
    bankroll_units = max(0.0, safe_float(settings.get("bankroll_units"), 100.0))
    return bankroll_units * full_kelly * fraction


def _stake_units(prediction: dict[str, Any], probability: float | None, settings: dict[str, Any]) -> float:
    mode = str(settings.get("stake_mode", "flat")).strip().lower()
    if mode == "fractional_kelly":
        raw_stake = _kelly_stake_units(prediction, probability, settings)
    else:
        raw_stake = _flat_stake(settings)

    capped = min(
        raw_stake,
        safe_float(settings.get("max_stake_units"), 1.0),
        _available_exposure(settings),
    )
    return round(max(0.0, capped), 3)


def apply_risk_framework(
    prediction: dict[str, Any],
    quality_report: dict[str, Any],
    settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Apply no-bet, confidence-cap, and staking controls to a prediction."""
    config = _merge_settings(settings)
    output = deepcopy(prediction)
    warnings: list[str] = []
    reasons: list[str] = []

    score = safe_float(quality_report.get("score"), 0.0)
    minimum_quality = safe_float(config.get("minimum_data_quality_score"), 60.0)
    if score < minimum_quality:
        reasons.append(f"data quality below minimum ({int(score)}/{int(minimum_quality)})")

    stale_fields = []
    for field in config.get("no_bet_on_stale_fields", ()):
        if _status_is_stale(quality_report, str(field)):
            stale_fields.append(str(field).replace("_", " "))
    if stale_fields:
        reasons.append(f"stale required data: {', '.join(stale_fields)}")

    raw_probability = _prediction_probability(output)
    max_confidence = safe_float(config.get("max_pick_confidence"), 0.64)
    capped_probability = None
    if raw_probability is not None:
        capped_probability = round(min(raw_probability, max_confidence), 4)
        if raw_probability > max_confidence:
            warnings.append(f"Model probability above confidence cap; capped at {max_confidence:.0%} for staking")

    original_decision = str(output.get("decision") or "").upper()
    if original_decision == "NO BET":
        reasons.append(str(output.get("decision_reason") or "upstream no-bet rule"))

    decision = "NO BET" if reasons else (original_decision or "LEAN")
    if decision == "VALUE":
        decision = "BET"

    if decision == "NO BET":
        stake = 0.0
    elif decision == "BET":
        stake = _stake_units(output, capped_probability, config)
        if stake <= 0:
            decision = "NO BET"
            reasons.append("staking framework produced zero stake")
    else:
        stake = 0.0

    output["decision"] = decision
    if reasons:
        reason_text = "; ".join(dict.fromkeys(reason for reason in reasons if reason))
        output["decision_reason"] = _append_reason(output.get("decision_reason"), reason_text)

    output["risk_framework"] = {
        "stake_mode": str(config.get("stake_mode", "flat")),
        "stake_units": stake,
        "flat_stake_units": safe_float(config.get("flat_stake_units"), 1.0),
        "kelly_fraction": safe_float(config.get("kelly_fraction"), 0.25),
        "max_stake_units": safe_float(config.get("max_stake_units"), 1.0),
        "max_daily_exposure_units": safe_float(config.get("max_daily_exposure_units"), 3.0),
        "current_daily_exposure_units": safe_float(config.get("current_daily_exposure_units"), 0.0),
        "raw_model_probability": round(raw_probability, 4) if raw_probability is not None else None,
        "capped_model_probability": capped_probability,
        "warnings": warnings,
        "risk_warning": RISK_WARNING,
    }
    output["risk_warning"] = RISK_WARNING
    return output
