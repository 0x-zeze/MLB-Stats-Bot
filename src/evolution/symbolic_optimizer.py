"""Turn language gradients into symbolic update candidates."""

from __future__ import annotations

import argparse
import hashlib
import json
from typing import Any

from .memory_store import append_jsonl, read_jsonl

TYPE_BY_TARGET = {
    "analyst_prompt": "prompt_update",
    "no_bet_rules": "no_bet_rule",
    "confidence_rules": "confidence_cap",
    "data_quality_scoring": "data_quality_update",
    "totals_model": "weighting_update",
    "moneyline_model": "weighting_update",
    "market_edge_threshold": "threshold_update",
    "weather_adjustment": "tool_order_update",
    "lineup_adjustment": "confidence_cap",
    "bullpen_adjustment": "weighting_update",
    "pitcher_weighting": "weighting_update",
    "recent_form_weighting": "weighting_update",
    "tool_usage_order": "tool_order_update",
    "explanation_style": "explanation_update",
}


def _candidate_id(gradient: dict[str, Any]) -> str:
    digest = hashlib.sha1(str(gradient).encode("utf-8")).hexdigest()[:10]
    return f"cand-{digest}"


def propose_symbolic_updates(language_gradients: list[dict[str, Any]], persist: bool = True) -> list[dict[str, Any]]:
    candidates = []
    for gradient in language_gradients:
        target = str(gradient.get("target") or "analyst_prompt")
        candidate = {
            "candidate_id": _candidate_id(gradient),
            "type": TYPE_BY_TARGET.get(target, "symbolic_update"),
            "target": target,
            "update": gradient.get("gradient"),
            "reason": gradient.get("reason"),
            "source_losses": [gradient.get("source_loss_id")] if gradient.get("source_loss_id") else [],
            "source_gradients": [gradient.get("gradient_id")] if gradient.get("gradient_id") else [],
            "required_backtest": True,
            "backtest_status": "pending",
            "promotion_status": "pending",
            "status": "pending",
            "production_update_allowed": False,
        }
        candidates.append(candidate)
        if persist:
            append_jsonl("symbolic_updates", candidate)
            append_jsonl("rule_candidates", candidate)
    return candidates


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Propose symbolic update candidates.")
    parser.add_argument("--propose-updates", action="store_true", help="Propose updates from stored language gradients.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.propose_updates:
        print("Nothing to do. Use --propose-updates.")
        return
    candidates = propose_symbolic_updates(read_jsonl("language_gradients"))
    print(json.dumps({"candidates": len(candidates)}, indent=2))


if __name__ == "__main__":
    main()
