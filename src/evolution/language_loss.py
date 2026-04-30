"""Structured natural-language loss descriptions."""

from __future__ import annotations

import argparse
import hashlib
import json
from typing import Any

from ..utils import safe_float
from .memory_store import append_jsonl, read_jsonl
from .prediction_evaluator import evaluate_prediction


def _loss_id(game_id: Any, market: str, loss_type: str) -> str:
    digest = hashlib.sha1(f"{game_id}:{market}:{loss_type}".encode("utf-8")).hexdigest()[:10]
    return f"loss-{digest}"


def calculate_language_loss(trajectory: dict[str, Any], final_result: dict[str, Any]) -> dict[str, Any]:
    evaluation = final_result if "actual_total" in final_result and "result" in final_result else evaluate_prediction(trajectory, final_result)
    prediction = trajectory.get("prediction") or {}
    market = str(evaluation.get("market") or trajectory.get("market") or "moneyline").lower()
    confidence = str(evaluation.get("confidence") or "").lower()
    edge = safe_float(prediction.get("model_edge"), safe_float(evaluation.get("edge"), 0.0))
    projected_total = safe_float(prediction.get("projected_total") or prediction.get("projected_total_runs"), 0.0)
    market_total = safe_float(prediction.get("market_total"), 0.0)
    actual_total = safe_float(evaluation.get("actual_total"), 0.0)
    data_quality = safe_float(evaluation.get("data_quality"), safe_float((trajectory.get("input_snapshot") or {}).get("data_quality"), 0.0))
    lineup_status = str((trajectory.get("input_snapshot") or {}).get("lineup_status") or "").lower()
    weather_status = str((trajectory.get("input_snapshot") or {}).get("weather_status") or "").lower()

    loss_type = "correct_pick" if evaluation.get("result") == "win" else "wrong_pick"
    severity = "low"
    affected_factor = "general"
    summary = "The prediction result matched the final outcome."

    if evaluation.get("result") == "no_bet":
        loss_type = "good_no_bet" if evaluation.get("no_bet_appropriate") else "bad_no_bet"
        affected_factor = "no_bet_filter"
        summary = "The NO BET decision was supported by pre-game risk." if loss_type == "good_no_bet" else "The NO BET filter may have been too conservative."
    elif evaluation.get("overconfidence"):
        loss_type = "overconfidence"
        severity = "high" if confidence == "high" else "medium"
        affected_factor = "confidence_calibration"
        summary = f"The agent gave {confidence.title()} confidence to a losing {market} pick."
    elif evaluation.get("underconfidence"):
        loss_type = "underconfidence"
        affected_factor = "confidence_calibration"
        summary = "The agent had a winning pick but confidence was low."
    elif evaluation.get("result") == "loss" and abs(edge) < 2.5:
        loss_type = "weak_edge"
        severity = "medium"
        affected_factor = "market_edge"
        summary = "The agent acted on a weak model edge."
    elif evaluation.get("result") == "loss" and data_quality < 65:
        loss_type = "bad_data_quality"
        severity = "medium"
        affected_factor = "data_quality"
        summary = "The prediction lost with low data quality in the pre-game snapshot."
    elif evaluation.get("result") == "loss" and "projected" in lineup_status:
        loss_type = "lineup_misread"
        severity = "medium"
        affected_factor = "lineup"
        summary = "The pick did not sufficiently respect lineup uncertainty."
    elif evaluation.get("result") == "loss" and "missing" in weather_status and market == "totals":
        loss_type = "weather_misread"
        severity = "medium"
        affected_factor = "weather"
        summary = "The totals pick was made with missing weather context."
    elif market == "totals" and evaluation.get("result") == "loss" and abs(projected_total - actual_total) >= 2.0:
        loss_type = "totals_projection_error"
        severity = "medium"
        affected_factor = "totals_model"
        summary = "Projected total runs missed the final total by at least two runs."
    elif evaluation.get("result") == "win" and data_quality < 65:
        loss_type = "good_data_quality_warning"
        affected_factor = "data_quality"
        summary = "The pick won, but low data quality should still keep future confidence conservative."

    return {
        "loss_id": _loss_id(evaluation.get("game_id"), market, loss_type),
        "game_id": evaluation.get("game_id"),
        "market": market,
        "prediction": evaluation.get("prediction"),
        "actual_total": actual_total,
        "loss_type": loss_type,
        "loss_summary": summary,
        "severity": severity,
        "affected_factor": affected_factor,
        "numeric_context": {
            "projected_total": projected_total,
            "market_total": market_total,
            "actual_total": actual_total,
            "edge": edge,
            "data_quality": data_quality,
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate language losses from evaluated predictions.")
    parser.add_argument("--generate", action="store_true", help="Generate placeholder losses from stored evaluations when possible.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.generate:
        print("Nothing to do. Use --generate.")
        return
    print(json.dumps({"existing_losses": len(read_jsonl("language_losses"))}, indent=2))


if __name__ == "__main__":
    main()
