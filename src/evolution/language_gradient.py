"""Convert language losses into structured improvement gradients."""

from __future__ import annotations

import argparse
import hashlib
import json
from typing import Any

from .memory_store import append_jsonl, read_jsonl


GRADIENT_MAP = {
    "overconfidence": (
        "confidence_rules",
        "Do not increase confidence when edge is small or key pre-game inputs are incomplete.",
        "confidence_cap",
    ),
    "underconfidence": (
        "confidence_rules",
        "Review low-confidence wins for repeatable signals before changing confidence caps.",
        "calibration_review",
    ),
    "weak_edge": (
        "market_edge_threshold",
        "Require a stronger edge or return NO BET when market difference is marginal.",
        "threshold_update",
    ),
    "record_bias": (
        "no_bet_rules",
        "Return NO BET or cap confidence when record, recent form, H2H, or previous-series context dominates weak game-specific matchup signals.",
        "no_bet_rule",
    ),
    "lineup_misread": (
        "lineup_adjustment",
        "Cap totals confidence when lineups are projected or missing.",
        "confidence_cap",
    ),
    "weather_misread": (
        "weather_adjustment",
        "Require fresh weather context before confident outdoor totals picks.",
        "tool_order_update",
    ),
    "bad_data_quality": (
        "data_quality_scoring",
        "Lower confidence or return NO BET when data quality falls below the safe threshold.",
        "data_quality_update",
    ),
    "bad_no_bet": (
        "no_bet_rules",
        "Audit whether the NO BET filter is too strict for this segment before changing production rules.",
        "rule_review",
    ),
    "good_no_bet": (
        "no_bet_rules",
        "Preserve NO BET protection when weak edge, low confidence, or poor data quality is present.",
        "safety_rule",
    ),
    "totals_projection_error": (
        "totals_model",
        "Review totals projection features when final total misses projection by multiple runs.",
        "weighting_update",
    ),
}


def _gradient_id(loss: dict[str, Any]) -> str:
    digest = hashlib.sha1(str(loss.get("loss_id") or loss).encode("utf-8")).hexdigest()[:10]
    return f"grad-{digest}"


def generate_language_gradient(language_loss: dict[str, Any], trajectory: dict[str, Any] | None = None) -> dict[str, Any]:
    loss_type = str(language_loss.get("loss_type") or "wrong_pick")
    target, gradient, update_type = GRADIENT_MAP.get(
        loss_type,
        (
            "analyst_prompt",
            "Make the explanation explicitly state whether the lean is model-driven, market-driven, or data-quality-limited.",
            "prompt_update",
        ),
    )
    reason = language_loss.get("loss_summary") or "Generated from structured post-game language loss."
    return {
        "gradient_id": _gradient_id(language_loss),
        "source_loss_id": language_loss.get("loss_id"),
        "game_id": language_loss.get("game_id"),
        "market": language_loss.get("market"),
        "target": target,
        "gradient": gradient,
        "reason": reason,
        "suggested_update_type": update_type,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate language gradients from language losses.")
    parser.add_argument("--generate", action="store_true", help="Generate gradients for stored language losses.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.generate:
        print("Nothing to do. Use --generate.")
        return
    losses = read_jsonl("language_losses")
    gradients = [append_jsonl("language_gradients", generate_language_gradient(loss)) for loss in losses]
    print(json.dumps({"generated": len(gradients)}, indent=2))


if __name__ == "__main__":
    main()
