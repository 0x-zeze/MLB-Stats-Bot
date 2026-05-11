"""Numeric post-game evaluation for saved prediction trajectories."""

from __future__ import annotations

import re
from typing import Any

from ..utils import clamp, safe_float


def american_profit(odds: Any, won: bool, stake: float = 1.0) -> float:
    if not won:
        return -stake
    value = safe_float(odds, 0.0)
    if value == 0:
        return stake
    return stake * value / 100.0 if value > 0 else stake * 100.0 / abs(value)


def probability(value: Any, default: float = 0.5) -> float:
    parsed = safe_float(value, default)
    if parsed > 1:
        parsed /= 100.0
    return clamp(parsed, 0.001, 0.999)


def _score(final_result: dict[str, Any]) -> tuple[int, int]:
    home = int(safe_float(final_result.get("home_score", final_result.get("actual_home_score")), 0))
    away = int(safe_float(final_result.get("away_score", final_result.get("actual_away_score")), 0))
    return home, away


def _actual_winner(trajectory: dict[str, Any], home_score: int, away_score: int) -> str | None:
    if home_score == away_score:
        return None
    return trajectory.get("home_team") if home_score > away_score else trajectory.get("away_team")


def _total_line(lean: str, fallback: Any = None) -> float | None:
    match = re.search(r"(\d+(?:\.\d+)?)", lean or "")
    if match:
        return safe_float(match.group(1))
    if fallback not in (None, ""):
        return safe_float(fallback)
    return None


def _predicted_probability(trajectory: dict[str, Any], market: str, lean: str) -> float:
    prediction = trajectory.get("prediction") or {}
    if market == "totals":
        if lean.lower().startswith("under"):
            return probability(prediction.get("under_probability"), 0.5)
        return probability(prediction.get("over_probability"), 0.5)
    return probability(prediction.get("moneyline_probability"), 0.5)


def _market_odds(trajectory: dict[str, Any], lean: str) -> Any:
    odds = (trajectory.get("prediction") or {}).get("market_odds")
    if isinstance(odds, dict):
        lean_text = str(lean or "").lower()
        if lean_text.startswith("under"):
            return odds.get("under")
        if lean_text.startswith("over"):
            return odds.get("over")
        away_team = str(trajectory.get("away_team") or "").lower()
        home_team = str(trajectory.get("home_team") or "").lower()
        if away_team and away_team in lean_text:
            return odds.get("awayMoneyline") or odds.get("away_moneyline") or odds.get("away")
        if home_team and home_team in lean_text:
            return odds.get("homeMoneyline") or odds.get("home_moneyline") or odds.get("home")
        return odds.get("moneyline") or odds.get("odds")
    return odds


def _closing_moneyline(final_result: dict[str, Any], trajectory: dict[str, Any], lean: str) -> Any:
    away_team = str(trajectory.get("away_team") or "").lower()
    home_team = str(trajectory.get("home_team") or "").lower()
    lean_text = str(lean or "").lower()
    if away_team and away_team in lean_text:
        return final_result.get("closing_away_moneyline") or final_result.get("closing_away_odds")
    if home_team and home_team in lean_text:
        return final_result.get("closing_home_moneyline") or final_result.get("closing_home_odds")
    return final_result.get("closing_moneyline") or final_result.get("closing_odds")


def _american_implied(value: Any) -> float | None:
    odds = safe_float(value, 0.0)
    if odds == 0:
        return None
    if odds > 0:
        return 100.0 / (odds + 100.0)
    return abs(odds) / (abs(odds) + 100.0)


def _clv(trajectory: dict[str, Any], final_result: dict[str, Any], lean: str) -> float | None:
    market = str(trajectory.get("market") or "moneyline").lower()
    if market == "moneyline":
        opening_odds = _market_odds(trajectory, lean)
        closing_odds = _closing_moneyline(final_result, trajectory, lean)
        opening_implied = _american_implied(opening_odds)
        closing_implied = _american_implied(closing_odds)
        if opening_implied is None or closing_implied is None:
            return None
        return round((closing_implied - opening_implied) * 100.0, 3)

    closing_total = final_result.get("closing_total") or final_result.get("closing_line")
    market_total = (trajectory.get("prediction") or {}).get("market_total")
    if closing_total in (None, "") or market_total in (None, ""):
        return None
    closing = safe_float(closing_total)
    market = safe_float(market_total)
    if lean.lower().startswith("under"):
        return round(market - closing, 3)
    if lean.lower().startswith("over"):
        return round(closing - market, 3)
    return None


def evaluate_prediction(trajectory: dict[str, Any], final_result: dict[str, Any]) -> dict[str, Any]:
    home_score, away_score = _score(final_result)
    actual_total = home_score + away_score
    market = str(trajectory.get("market") or "moneyline").lower()
    prediction = trajectory.get("prediction") or {}
    lean = str(prediction.get("final_lean") or prediction.get("lean") or "NO BET")
    confidence = str(prediction.get("confidence") or trajectory.get("confidence") or "Low").lower()
    actual_winner = _actual_winner(trajectory, home_score, away_score)
    no_bet = lean.upper() == "NO BET" or str(trajectory.get("no_bet_reason") or "").strip()
    status = "no_bet"
    correct: bool | None = None
    push = False

    if not no_bet and market == "totals":
        line = _total_line(lean, prediction.get("market_total"))
        if line is not None and actual_total == line:
            push = True
            status = "push"
        elif lean.lower().startswith("over"):
            correct = line is not None and actual_total > line
            status = "win" if correct else "loss"
        elif lean.lower().startswith("under"):
            correct = line is not None and actual_total < line
            status = "win" if correct else "loss"
    elif not no_bet:
        predicted_winner = lean
        correct = bool(actual_winner and actual_winner.lower() in predicted_winner.lower())
        status = "win" if correct else "loss"

    probability_value = _predicted_probability(trajectory, market, lean)
    outcome = 1 if status == "win" else 0
    brier = None if status in {"no_bet", "push"} else round((probability_value - outcome) ** 2, 6)
    odds = _market_odds(trajectory, lean)
    profit_loss = 0.0 if status in {"no_bet", "push"} else round(american_profit(odds, status == "win"), 4)
    edge = safe_float(prediction.get("model_edge"), 0.0)
    data_quality = safe_float((trajectory.get("input_snapshot") or {}).get("data_quality"), 0.0)
    no_bet_appropriate = None
    if no_bet:
        no_bet_appropriate = data_quality < 65 or abs(edge) < 2.0 or confidence == "low"

    notes = []
    if status == "loss" and confidence in {"medium", "high"}:
        notes.append("Potential overconfidence.")
    if status == "win" and confidence == "low":
        notes.append("Potential underconfidence.")
    if no_bet and no_bet_appropriate:
        notes.append("NO BET was supported by weak edge, low confidence, or data quality risk.")
    if no_bet and no_bet_appropriate is False:
        notes.append("NO BET may have been too conservative.")

    return {
        "game_id": trajectory.get("game_id"),
        "date": trajectory.get("date"),
        "market": market,
        "prediction": lean,
        "confidence": confidence,
        "result": status,
        "actual_score": f"{away_score}-{home_score}",
        "actual_home_score": home_score,
        "actual_away_score": away_score,
        "actual_winner": actual_winner,
        "actual_total": actual_total,
        "moneyline_correct": correct if market == "moneyline" else None,
        "total_lean_correct": correct if market == "totals" else None,
        "yrfi_nrfi_correct": None,
        "no_bet_appropriate": no_bet_appropriate,
        "profit_loss": profit_loss,
        "clv": _clv(trajectory, final_result, lean),
        "predicted_probability": round(probability_value * 100.0, 3),
        "opening_odds": odds,
        "closing_odds": _closing_moneyline(final_result, trajectory, lean)
        if market == "moneyline"
        else final_result.get("closing_total") or final_result.get("closing_line"),
        "brier_score": brier,
        "confidence_calibration_bucket": confidence,
        "calibration_bucket": confidence,
        "edge": edge,
        "data_quality": data_quality,
        "overconfidence": status == "loss" and confidence in {"medium", "high"},
        "underconfidence": status == "win" and confidence == "low",
        "main_factors": trajectory.get("main_factors") or [],
        "risk_factors": trajectory.get("risk_factors") or [],
        "bet_decision": trajectory.get("bet_decision") or {},
        "value_pick": trajectory.get("value_pick") or {},
        "evaluation_notes": notes,
    }
