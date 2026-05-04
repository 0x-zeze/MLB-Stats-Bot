"""Generate safe symbolic rule candidates from repeated lessons."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from typing import Any

from .memory_store import append_jsonl, read_jsonl


def _candidate_id(kind: str, key: str) -> str:
    digest = hashlib.sha1(f"{kind}:{key}".encode("utf-8")).hexdigest()[:10]
    return f"cand-{digest}"


def _candidate_type(target: str, lesson_type: str) -> str:
    if "no_bet" in target or lesson_type in {"weak_edge", "bad_data_quality"}:
        return "no_bet_rule"
    if "confidence" in target or lesson_type in {"overconfidence", "lineup_misread"}:
        return "confidence_cap"
    if "prompt" in target:
        return "prompt_update"
    if "tool" in target or "weather" in target:
        return "tool_order_update"
    return "symbolic_update"


def generate_rule_candidates(
    lessons: list[dict[str, Any]],
    language_gradients: list[dict[str, Any]],
    min_repeats: int = 5,
    persist: bool = True,
) -> list[dict[str, Any]]:
    existing_ids = set()
    if persist:
        existing_ids = {
            str(candidate.get("candidate_id"))
            for candidate in read_jsonl("rule_candidates")
            if candidate.get("candidate_id")
        }
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for lesson in lessons:
        key = f"{lesson.get('lesson_type')}|{lesson.get('suggested_adjustment')}"
        grouped[key].append(lesson)
    for gradient in language_gradients:
        key = f"{gradient.get('target')}|{gradient.get('gradient')}"
        grouped[key].append(gradient)

    candidates = []
    for key, records in grouped.items():
        if len(records) < min_repeats:
            continue
        first = records[0]
        target = str(first.get("target") or first.get("category") or "")
        lesson_type = str(first.get("lesson_type") or first.get("suggested_update_type") or "")
        update_text = first.get("gradient") or first.get("suggested_adjustment")
        candidate = {
            "candidate_id": _candidate_id("rule", key),
            "type": _candidate_type(target, lesson_type),
            "rule": update_text,
            "reason": f"Repeated pattern appeared {len(records)} times.",
            "source_lessons": [record.get("lesson_id") for record in records if record.get("lesson_id")],
            "source_losses": [record.get("source_loss_id") for record in records if record.get("source_loss_id")],
            "required_backtest": True,
            "backtest_status": "pending",
            "status": "pending",
            "production_update_allowed": False,
        }
        if candidate["candidate_id"] in existing_ids:
            continue
        candidates.append(candidate)
        if persist:
            append_jsonl("rule_candidates", candidate)
            existing_ids.add(candidate["candidate_id"])
    return candidates


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate evolution rule candidates.")
    parser.add_argument("--propose", action="store_true", help="Generate rule candidates from stored lessons and gradients.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.propose:
        print("Nothing to do. Use --propose.")
        return
    candidates = generate_rule_candidates(read_jsonl("lessons"), read_jsonl("language_gradients"))
    print(json.dumps({"candidates": len(candidates)}, indent=2))


if __name__ == "__main__":
    main()
