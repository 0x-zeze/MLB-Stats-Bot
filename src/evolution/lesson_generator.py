"""Lesson and attribution generation for evaluated MLB predictions."""

from __future__ import annotations

import hashlib
from typing import Any

from ..utils import safe_float


LESSON_CATEGORIES = {
    "overconfidence": "confidence",
    "underconfidence": "confidence",
    "weak_edge": "market_movement",
    "record_bias": "confidence",
    "lineup_misread": "lineup",
    "weather_misread": "weather",
    "bad_data_quality": "data_quality",
    "good_data_quality_warning": "data_quality",
    "bad_no_bet": "no_bet",
    "good_no_bet": "no_bet",
    "totals_projection_error": "totals",
    "correct_pick": "moneyline",
    "wrong_pick": "moneyline",
}


def _lesson_id(evaluation: dict[str, Any], loss: dict[str, Any]) -> str:
    digest = hashlib.sha1(f"{evaluation.get('game_id')}:{loss.get('loss_type')}".encode("utf-8")).hexdigest()[:10]
    return f"lesson-{digest}"


def generate_self_questions(evaluation_context: dict[str, Any]) -> list[dict[str, str]]:
    result = str(evaluation_context.get("result") or "").lower()
    confidence = str(evaluation_context.get("confidence") or "").lower()
    market = str(evaluation_context.get("market") or "").lower()
    questions = [
        "Was the confidence level calibrated correctly?",
        "Should this game have been NO BET?",
        "Did market movement warn against the pick?",
        "Was the data quality score too generous?",
        "Did the explanation communicate risk clearly?",
    ]
    if market == "totals":
        questions.extend(
            [
                "Did lineup uncertainty matter?",
                "Did weather adjustment help or hurt?",
                "Did the model perform differently on this total line range?",
            ]
        )
    if result == "loss":
        questions.extend(
            [
                "Did the model overvalue recent form?",
                "Did the model ignore bullpen fatigue?",
                "Did the model overweight ERA instead of FIP or WHIP?",
                "Did the agent miss a required tool call?",
            ]
        )
    if confidence == "high":
        questions.append("Was high confidence supported by enough independent evidence?")
    return [{"question": question, "answer": "pending_review"} for question in questions]


def attribute_prediction_result(trajectory: dict[str, Any], evaluation: dict[str, Any]) -> dict[str, Any]:
    result = str(evaluation.get("result") or "").lower()
    prediction = trajectory.get("prediction") or {}
    snapshot = trajectory.get("input_snapshot") or {}
    factors: list[dict[str, str]] = []
    positive = result == "win" or (result == "no_bet" and evaluation.get("no_bet_appropriate"))
    baseline_impact = "positive" if positive else "negative"

    data_quality = safe_float(snapshot.get("data_quality"), 0.0)
    edge = abs(safe_float(prediction.get("model_edge"), 0.0))
    lineup_status = str(snapshot.get("lineup_status") or "").lower()
    weather_status = str(snapshot.get("weather_status") or "").lower()
    bullpen_status = str(snapshot.get("bullpen_status") or "").lower()
    model_breakdown = trajectory.get("model_breakdown") or trajectory.get("modelBreakdown") or {}
    if not isinstance(model_breakdown, dict):
        model_breakdown = {}
    matchup_edge = abs(safe_float(model_breakdown.get("matchupEdge") or model_breakdown.get("matchup_edge"), 0.0))
    record_context_edge = abs(safe_float(model_breakdown.get("recordContextEdge") or model_breakdown.get("record_context_edge"), 0.0))
    starter_edge = abs(safe_float(model_breakdown.get("starterEdge") or model_breakdown.get("starter_edge"), 0.0))
    lineup_edge = abs(safe_float(model_breakdown.get("lineupEdge") or model_breakdown.get("lineup_edge"), 0.0))
    bullpen_edge = abs(safe_float(model_breakdown.get("bullpenEdge") or model_breakdown.get("bullpen_edge"), 0.0))

    factors.append(
        {
            "factor": "confidence_calibration",
            "impact": baseline_impact,
            "reason": "Confidence aligned with the result." if positive else "Confidence did not align with the result.",
        }
    )
    factors.append(
        {
            "factor": "market_edge",
            "impact": "neutral" if edge < 2.5 else baseline_impact,
            "reason": f"Model edge was {edge:.1f}, which is {'small' if edge < 2.5 else 'meaningful'} for this market.",
        }
    )
    if "projected" in lineup_status or "missing" in lineup_status:
        factors.append({"factor": "lineup", "impact": "negative", "reason": "Lineup was not confirmed before the prediction."})
    if "missing" in weather_status and str(evaluation.get("market")) == "totals":
        factors.append({"factor": "weather", "impact": "negative", "reason": "Weather context was missing for a totals decision."})
    if "missing" in bullpen_status or "stale" in bullpen_status:
        factors.append({"factor": "bullpen", "impact": "negative", "reason": "Bullpen context was missing or stale."})
    if data_quality < 65:
        factors.append({"factor": "data_quality", "impact": "negative", "reason": "Data quality was below the conservative threshold."})
    if record_context_edge > matchup_edge * 1.35 and matchup_edge < 0.2:
        factors.append(
            {
                "factor": "record_context",
                "impact": "negative" if result == "loss" else "neutral",
                "reason": "Record, recent form, H2H, or previous-series context was larger than the game-specific matchup edge.",
            }
        )
    if starter_edge >= 0.25:
        factors.append(
            {
                "factor": "starting_pitcher",
                "impact": baseline_impact,
                "reason": "Starting pitcher quality was a meaningful model component for this pick.",
            }
        )
    if lineup_edge >= 0.04:
        factors.append(
            {
                "factor": "lineup",
                "impact": baseline_impact if "projected" not in lineup_status and "missing" not in lineup_status else "negative",
                "reason": "Lineup/player availability created a meaningful model component.",
            }
        )
    if bullpen_edge >= 0.04:
        factors.append(
            {
                "factor": "bullpen",
                "impact": baseline_impact if "missing" not in bullpen_status and "stale" not in bullpen_status else "negative",
                "reason": "Bullpen availability created a meaningful model component.",
            }
        )
    if result == "no_bet":
        factors.append(
            {
                "factor": "no_bet_filter",
                "impact": "positive" if evaluation.get("no_bet_appropriate") else "negative",
                "reason": "NO BET filter matched pre-game risk." if evaluation.get("no_bet_appropriate") else "NO BET filter may have been too conservative.",
            }
        )
    return {
        "game_id": evaluation.get("game_id"),
        "market": evaluation.get("market"),
        "result": result,
        "attribution": factors,
    }


def generate_lesson(evaluation: dict[str, Any], language_loss: dict[str, Any], language_gradient: dict[str, Any]) -> dict[str, Any]:
    lesson_type = str(language_loss.get("loss_type") or "general")
    numeric = language_loss.get("numeric_context") or {}
    suggested_adjustment = language_gradient.get("gradient") or "Review this segment before changing production behavior."
    return {
        "lesson_id": _lesson_id(evaluation, language_loss),
        "date": evaluation.get("date"),
        "game_id": evaluation.get("game_id"),
        "market": evaluation.get("market"),
        "prediction": evaluation.get("prediction"),
        "result": evaluation.get("result"),
        "lesson_type": lesson_type,
        "category": LESSON_CATEGORIES.get(lesson_type, "tool_usage"),
        "summary": language_loss.get("loss_summary"),
        "suggested_adjustment": suggested_adjustment,
        "supporting_data": {
            "projected_total": numeric.get("projected_total"),
            "market_total": numeric.get("market_total"),
            "actual_total": numeric.get("actual_total"),
            "edge": numeric.get("edge"),
            "data_quality": numeric.get("data_quality"),
            "confidence": evaluation.get("confidence"),
        },
        "self_questions": generate_self_questions(evaluation),
        "production_update_allowed": False,
    }
