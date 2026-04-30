"""Read-only report builder for the Evolution dashboard tab."""

from __future__ import annotations

import argparse
import json
from typing import Any

from .memory_store import current_versions, read_json, read_jsonl, read_prediction_outcomes


def _recent(file_key: str, limit: int) -> list[dict[str, Any]]:
    return list(reversed(read_jsonl(file_key, limit=limit)))


def _risk_warnings(losses: list[dict[str, Any]], lessons: list[dict[str, Any]]) -> list[dict[str, str]]:
    warnings: list[dict[str, str]] = []
    counts: dict[str, int] = {}
    for loss in losses:
        key = str(loss.get("affected_factor") or loss.get("loss_type") or "general")
        counts[key] = counts.get(key, 0) + 1
    for key, count in sorted(counts.items(), key=lambda item: item[1], reverse=True)[:5]:
        if count >= 2:
            warnings.append({"pattern": key, "severity": "medium", "note": f"{count} recent losses touched {key}."})
    no_bet_lessons = [lesson for lesson in lessons if lesson.get("category") == "no_bet"]
    if no_bet_lessons:
        warnings.append({"pattern": "no_bet", "severity": "low", "note": "NO BET lessons exist; preserve safety filters unless backtests prove otherwise."})
    return warnings


def build_evolution_summary(limit: int = 20) -> dict[str, Any]:
    trajectories = read_jsonl("trajectories")
    lessons = read_jsonl("lessons")
    losses = read_jsonl("language_losses")
    gradients = read_jsonl("language_gradients")
    candidates = read_jsonl("rule_candidates")
    symbolic = read_jsonl("symbolic_updates")
    approved = read_json("approved_rules").get("approved", [])
    rejected = read_json("rejected_rules").get("rejected", [])
    outcomes = read_prediction_outcomes()
    versions = current_versions()
    return {
        "summary": {
            "total_predictions_evaluated": len(outcomes),
            "lessons_generated": len(lessons),
            "language_losses_generated": len(losses),
            "language_gradients_generated": len(gradients),
            "candidates_proposed": len(candidates) + len(symbolic),
            "candidates_approved": len(approved),
            "candidates_rejected": len(rejected),
            "current_prompt_version": versions["prompt_version"],
            "current_rule_version": versions["rule_version"],
            "current_weight_version": versions["weight_version"],
        },
        "recent_trajectories": list(reversed(trajectories[-limit:])),
        "recent_lessons": _recent("lessons", limit),
        "language_losses": _recent("language_losses", limit),
        "language_gradients": _recent("language_gradients", limit),
        "symbolic_update_candidates": _recent("symbolic_updates", limit),
        "rule_candidates": _recent("rule_candidates", limit),
        "approved_changes": list(reversed(approved[-limit:])),
        "rejected_changes": list(reversed(rejected[-limit:])),
        "risk_warnings": _risk_warnings(losses[-limit:], lessons[-limit:]),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Print evolution summary.")
    parser.add_argument("--summary", action="store_true", help="Print JSON summary.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.summary:
        print("Nothing to do. Use --summary.")
        return
    print(json.dumps(build_evolution_summary(), indent=2))


if __name__ == "__main__":
    main()
