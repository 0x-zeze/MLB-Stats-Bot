"""CLI orchestration for the MLB Agent Evolution Engine."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from ..evaluate import load_prediction_log
from ..utils import DATA_DIR, safe_float
from .language_gradient import generate_language_gradient
from .language_loss import calculate_language_loss
from .lesson_generator import attribute_prediction_result, generate_lesson
from .memory_store import (
    append_jsonl,
    append_prediction_outcome,
    read_jsonl,
    read_prediction_outcomes,
    record_evolution_event,
)
from .evolution_report import build_evolution_summary
from .trajectory_logger import build_prediction_trajectory
from .prediction_evaluator import evaluate_prediction
from .rule_candidate_generator import generate_rule_candidates
from .symbolic_optimizer import propose_symbolic_updates
from .tool_usage_analyzer import analyze_tool_usage


def _outcome_key(game_id: Any, market: Any) -> tuple[str, str]:
    return (str(game_id or ""), str(market or "moneyline").lower())


def _existing_outcome_keys() -> set[tuple[str, str]]:
    return {
        _outcome_key(row.get("game_id"), row.get("market"))
        for row in read_prediction_outcomes()
        if row.get("game_id")
    }


def evaluate_completed_prediction(trajectory: dict[str, Any], final_result: dict[str, Any]) -> dict[str, Any]:
    """Run the full settled-game evolution chain for one trajectory."""
    key = _outcome_key(trajectory.get("game_id"), trajectory.get("market"))
    if key in _existing_outcome_keys():
        return {
            "skipped_duplicate": True,
            "game_id": key[0],
            "market": key[1],
        }

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


def _safe_json(value: Any, fallback: Any) -> Any:
    if value in (None, ""):
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except (TypeError, json.JSONDecodeError):
        return fallback


def _default_state_candidates(state_path: str | Path | None = None) -> list[Path]:
    if state_path:
        return [Path(state_path)]
    return [DATA_DIR / "state.sqlite", DATA_DIR / "state.json"]


def _read_bot_state_json(path: Path) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    payload = _safe_json(path.read_text(encoding="utf-8"), {})
    predictions = {
        str(game_pk): prediction
        for game_pk, prediction in (payload.get("predictions") or {}).items()
        if isinstance(prediction, dict)
    }
    learning_log = payload.get("memory", {}).get("learningLog") or []
    return predictions, [row for row in learning_log if isinstance(row, dict)]


def _read_bot_state_sqlite(path: Path) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        predictions = {
            str(row["game_pk"]): _safe_json(row["payload"], {})
            for row in connection.execute("SELECT game_pk, payload FROM picks")
        }
        row = connection.execute("SELECT learning_log FROM memory_summary WHERE id = 1").fetchone()
        learning_log = _safe_json(row["learning_log"], []) if row else []
    return predictions, [item for item in learning_log if isinstance(item, dict)]


def _read_bot_history(state_path: str | Path | None = None) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]], str | None]:
    for path in _default_state_candidates(state_path):
        if not path.exists():
            continue
        try:
            if path.suffix.lower() in {".sqlite", ".sqlite3", ".db"}:
                predictions, learning_log = _read_bot_state_sqlite(path)
            else:
                predictions, learning_log = _read_bot_state_json(path)
        except (OSError, sqlite3.DatabaseError, json.JSONDecodeError):
            continue
        if predictions or learning_log:
            return predictions, learning_log, str(path)
    return {}, [], None


def _score_from_learning_log(entry: dict[str, Any]) -> tuple[int, int] | None:
    score = str(entry.get("score") or "")
    match = re.search(r"\s(\d+)\s*-\s*(\d+)\s", f" {score} ")
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def _prediction_to_trajectory(prediction: dict[str, Any]) -> dict[str, Any]:
    away = prediction.get("away") or {}
    home = prediction.get("home") or {}
    pick = prediction.get("pick") or {}
    total_runs = prediction.get("totalRuns") or {}
    confidence = pick.get("confidence") or total_runs.get("confidence") or "Low"
    pick_probability = safe_float(pick.get("winProbability"), 50.0)
    context = {
        "game_id": prediction.get("gamePk"),
        "date": prediction.get("dateYmd"),
        "market": "moneyline",
        "matchup": prediction.get("matchup") or f"{away.get('name')} @ {home.get('name')}",
        "away_team": away.get("name"),
        "home_team": home.get("name"),
        "game_time": prediction.get("start"),
        "venue": prediction.get("venue"),
        "data_quality_score": 70,
        "probable_pitcher_status": "stored",
        "lineup_status": "stored",
        "weather_status": "unknown",
        "odds_status": "unknown",
        "bullpen_status": "stored",
        "tool_usage": ["get_mlb_predictions", "save_predictions", "postgame_memory"],
        "moneyline": {
            "model_probability": pick_probability,
            "home_probability": home.get("winProbability"),
            "away_probability": away.get("winProbability"),
            "confidence": confidence,
            "edge": round(pick_probability - 50.0, 3),
            "current_odds": prediction.get("currentOdds") or {},
        },
        "model_breakdown": prediction.get("modelBreakdown") or {},
        "model_breakdown_line": prediction.get("modelBreakdownLine") or "",
        "value_pick": prediction.get("valuePick") or {},
        "bet_decision": prediction.get("betDecision") or {},
        "main_factors": prediction.get("reasons") or [],
        "risk_factors": [prediction.get("agentRisk")] if prediction.get("agentRisk") else [],
    }
    output = {
        "final_lean": pick.get("name") or prediction.get("winner", {}).get("name") or "NO BET",
        "confidence": confidence,
        "moneyline": context["moneyline"],
        "model_breakdown": context["model_breakdown"],
        "value_pick": context["value_pick"],
        "bet_decision": context["bet_decision"],
        "main_factors": context["main_factors"],
        "risk_factors": context["risk_factors"],
    }
    return build_prediction_trajectory(context, output)


def ingest_bot_history(state_path: str | Path | None = None) -> dict[str, Any]:
    """Import settled Telegram bot history into the Evolution Engine.

    The import is idempotent by game/market. It learns from games already
    settled in the bot memory log, but it still only creates auditable
    evolution artifacts; it never promotes production rule changes.
    """
    predictions, learning_log, source = _read_bot_history(state_path)
    existing = _existing_outcome_keys()
    evaluated = 0
    skipped_duplicates = 0
    skipped_missing_prediction = 0
    skipped_missing_score = 0
    generated_losses = 0
    generated_gradients = 0
    generated_lessons = 0

    for entry in learning_log:
        game_pk = str(entry.get("gamePk") or "")
        prediction = predictions.get(game_pk)
        if not prediction:
            skipped_missing_prediction += 1
            continue
        if _outcome_key(game_pk, "moneyline") in existing:
            skipped_duplicates += 1
            continue
        score = _score_from_learning_log(entry)
        if not score:
            skipped_missing_score += 1
            continue

        away_score, home_score = score
        trajectory = _prediction_to_trajectory(prediction)
        result = evaluate_completed_prediction(
            trajectory,
            {
                "away_score": away_score,
                "home_score": home_score,
            },
        )
        if result.get("skipped_duplicate"):
            skipped_duplicates += 1
            continue
        existing.add(_outcome_key(game_pk, "moneyline"))
        evaluated += 1
        generated_losses += 1
        generated_gradients += 1
        generated_lessons += 1

    record_evolution_event(
        "bot_history_ingested",
        {
            "source": source,
            "history_rows": len(learning_log),
            "evaluated": evaluated,
            "skipped_duplicates": skipped_duplicates,
            "skipped_missing_prediction": skipped_missing_prediction,
            "skipped_missing_score": skipped_missing_score,
        },
    )
    return {
        "source": source or "not_found",
        "history_rows": len(learning_log),
        "evaluated": evaluated,
        "skipped_duplicates": skipped_duplicates,
        "skipped_missing_prediction": skipped_missing_prediction,
        "skipped_missing_score": skipped_missing_score,
        "language_losses": generated_losses,
        "language_gradients": generated_gradients,
        "lessons": generated_lessons,
    }


def run_evolution_cycle(state_path: str | Path | None = None) -> dict[str, Any]:
    ingest = ingest_bot_history(state_path)
    symbolic_candidates = propose_symbolic_updates(read_jsonl("language_gradients"))
    rule_candidates = generate_rule_candidates(read_jsonl("lessons"), read_jsonl("language_gradients"))
    backtest = backtest_candidates()
    summary = build_evolution_summary(limit=10)
    record_evolution_event(
        "evolution_cycle_completed",
        {
            "ingest": ingest,
            "symbolic_candidates": len(symbolic_candidates),
            "rule_candidates": len(rule_candidates),
            "backtest": backtest,
        },
    )
    return {
        "ingest": ingest,
        "symbolic_candidates": len(symbolic_candidates),
        "rule_candidates": len(rule_candidates),
        "backtest": backtest,
        "summary": summary.get("summary", {}),
        "safety": "Candidates are pending only. Production rules, prompts, and weights were not auto-promoted.",
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
    parser.add_argument("--run-cycle", action="store_true")
    parser.add_argument("--ingest-bot-history", action="store_true")
    parser.add_argument("--state-path", default="")
    parser.add_argument("--evaluate-yesterday", action="store_true")
    parser.add_argument("--generate-lessons", action="store_true")
    parser.add_argument("--propose-rules", action="store_true")
    parser.add_argument("--backtest-candidates", action="store_true")
    parser.add_argument("--promote-approved", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    state_path = args.state_path or None
    if args.run_cycle:
        print(json.dumps(run_evolution_cycle(state_path), indent=2))
    elif args.ingest_bot_history:
        print(json.dumps(ingest_bot_history(state_path), indent=2))
    elif args.evaluate_yesterday:
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
