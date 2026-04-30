"""CLI orchestration for the MLB Agent Evolution Engine."""

from __future__ import annotations

import argparse
import json
from datetime import date, timedelta
from typing import Any

from ..evaluate import load_prediction_log
from .language_gradient import generate_language_gradient
from .language_loss import calculate_language_loss
from .lesson_generator import attribute_prediction_result, generate_lesson
from .memory_store import (
    append_jsonl,
    append_prediction_outcome,
    read_jsonl,
    record_evolution_event,
)
from .prediction_evaluator import evaluate_prediction
from .rule_candidate_generator import generate_rule_candidates
from .symbolic_optimizer import propose_symbolic_updates
from .tool_usage_analyzer import analyze_tool_usage


def evaluate_completed_prediction(trajectory: dict[str, Any], final_result: dict[str, Any]) -> dict[str, Any]:
    """Run the full settled-game evolution chain for one trajectory."""
    evaluation = evaluate_prediction(trajectory, final_result)
    append_prediction_outcome(evaluation)

    language_loss = append_jsonl("language_losses", calculate_language_loss(trajectory, evaluation))
    language_gradient = append_jsonl("language_gradients", generate_language_gradient(language_loss, trajectory))
    lesson = append_jsonl("lessons", generate_lesson(evaluation, language_loss, language_gradient))
    attribution = attribute_prediction_result(trajectory, evaluation)
    tool_report = append_jsonl("tool_usage_reports", analyze_tool_usage(trajectory))
    record_evolution_event(
        "prediction_evaluated",
        {
            "game_id": evaluation.get("game_id"),
            "evaluation": evaluation,
            "language_loss_id": language_loss.get("loss_id"),
            "language_gradient_id": language_gradient.get("gradient_id"),
            "lesson_id": lesson.get("lesson_id"),
            "attribution": attribution,
            "tool_usage_quality": tool_report.get("tool_usage_quality"),
        },
    )
    return {
        "evaluation": evaluation,
        "language_loss": language_loss,
        "language_gradient": language_gradient,
        "lesson": lesson,
        "attribution": attribution,
        "tool_usage": tool_report,
    }


def _row_by_game_id() -> dict[str, dict[str, Any]]:
    rows = load_prediction_log()
    return {str(row.get("game_id")): row for row in rows if row.get("game_id")}


def _final_result_from_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "home_score": row.get("actual_home_score"),
        "away_score": row.get("actual_away_score"),
        "closing_line": row.get("closing_line"),
    }


def evaluate_yesterday() -> dict[str, Any]:
    target = (date.today() - timedelta(days=1)).isoformat()
    rows = _row_by_game_id()
    evaluated = 0
    skipped = 0
    for trajectory in read_jsonl("trajectories"):
        if trajectory.get("date") != target:
            continue
        row = rows.get(str(trajectory.get("game_id")))
        if not row:
            skipped += 1
            continue
        evaluate_completed_prediction(trajectory, _final_result_from_row(row))
        evaluated += 1
    return {"date": target, "evaluated": evaluated, "skipped_without_final": skipped}


def generate_lessons_from_existing_losses() -> dict[str, Any]:
    # The full chain creates lessons during evaluation. This command is kept
    # for compatibility and reports current state without mutating rules.
    return {
        "lessons": len(read_jsonl("lessons")),
        "language_losses": len(read_jsonl("language_losses")),
        "language_gradients": len(read_jsonl("language_gradients")),
    }


def propose_rules() -> dict[str, Any]:
    candidates = generate_rule_candidates(read_jsonl("lessons"), read_jsonl("language_gradients"))
    return {"candidates": len(candidates)}


def backtest_candidates() -> dict[str, Any]:
    # Lightweight placeholder: candidates are marked as requiring explicit
    # backtest evidence before promotion. No production rule is modified here.
    candidates = read_jsonl("rule_candidates")
    pending = [candidate for candidate in candidates if candidate.get("backtest_status") == "pending"]
    for candidate in pending:
        record_evolution_event(
            "candidate_backtest_required",
            {
                "candidate_id": candidate.get("candidate_id"),
                "status": "requires_manual_backtest",
                "reason": "Rule candidates require before/after metrics before promotion.",
            },
        )
    return {"pending_candidates": len(pending), "backtest_status": "requires_metrics"}


def promote_approved() -> dict[str, Any]:
    # Promotion decisions are recorded by promotion_gate.run_promotion_gate.
    # This command intentionally does not infer approval from candidate text.
    return {"message": "Use promotion_gate with validated before/after metrics to approve candidates."}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MLB Agent Evolution Engine.")
    parser.add_argument("--evaluate-yesterday", action="store_true")
    parser.add_argument("--generate-lessons", action="store_true")
    parser.add_argument("--propose-rules", action="store_true")
    parser.add_argument("--backtest-candidates", action="store_true")
    parser.add_argument("--promote-approved", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.evaluate_yesterday:
        print(json.dumps(evaluate_yesterday(), indent=2))
    elif args.generate_lessons:
        print(json.dumps(generate_lessons_from_existing_losses(), indent=2))
    elif args.propose_rules:
        print(json.dumps(propose_rules(), indent=2))
    elif args.backtest_candidates:
        print(json.dumps(backtest_candidates(), indent=2))
    elif args.promote_approved:
        print(json.dumps(promote_approved(), indent=2))
    else:
        gradients = read_jsonl("language_gradients")
        candidates = propose_symbolic_updates(gradients)
        print(json.dumps({"symbolic_candidates": len(candidates)}, indent=2))


if __name__ == "__main__":
    main()
