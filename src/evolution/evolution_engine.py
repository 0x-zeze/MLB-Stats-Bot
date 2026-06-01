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
from ..probability_calibrator import retrain as retrain_calibration
from ..totals import poisson_total_probability
from ..utils import DATA_DIR, safe_float
from .calibration_auto_adjust import find_miscalibrated_buckets
from .language_gradient import generate_language_gradient
from .language_loss import calculate_language_loss
from .lesson_generator import attribute_prediction_result, generate_lesson
from .memory_store import (
    append_jsonl,
    append_prediction_outcome,
    path_for,
    read_json,
    read_jsonl,
    read_prediction_outcomes,
    record_evolution_event,
    rewrite_prediction_outcomes,
    write_json,
)
from .evolution_report import build_evolution_summary
from .time_decay import apply_time_decay_to_lessons
from .trajectory_logger import build_prediction_trajectory
from .prediction_evaluator import _predicted_probability, evaluate_prediction
from .promotion_gate import run_promotion_gate
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


def _read_line_snapshots(source: str | Path | None) -> dict[str, dict[str, float]]:
    """Read stored line snapshots per game from the bot's sqlite state.

    Keyed by game_pk, then by market name (e.g. "moneyline_home",
    "closing_home", "total"). Used to recover closing odds for CLV.
    """
    snapshots: dict[str, dict[str, float]] = {}
    if not source:
        return snapshots
    path = Path(source)
    if path.suffix.lower() not in {".sqlite", ".sqlite3", ".db"} or not path.exists():
        return snapshots
    try:
        with sqlite3.connect(path) as connection:
            connection.row_factory = sqlite3.Row
            for row in connection.execute("SELECT game_pk, market, value FROM line_snapshots"):
                value = safe_float(row["value"], None)
                if value is None:
                    continue
                snapshots.setdefault(str(row["game_pk"]), {})[str(row["market"])] = value
    except (sqlite3.DatabaseError, OSError):
        return snapshots
    return snapshots


def _plausible_moneyline(value: float | None) -> float | None:
    """Reject in-game/stale American odds that would corrupt CLV.

    Pre-game MLB moneylines are effectively always within +/-1000 and never
    inside the (-100, 100) dead zone. Snapshots outside this band are live or
    suspended-game prices, not closing lines.
    """
    if value is None:
        return None
    if abs(value) < 100 or abs(value) > 1000:
        return None
    return value


def _plausible_total(value: float | None) -> float | None:
    """Reject implausible total lines (live totals inflate after runs score)."""
    if value is None:
        return None
    if value < 4.0 or value > 14.0:
        return None
    return value


def _closing_odds_from_snapshots(game_snapshots: dict[str, float]) -> dict[str, Any]:
    """Map stored line snapshots to the closing-odds keys the evaluator reads.

    Prefers the dedicated closing_* snapshot captured near first pitch; falls
    back to the last-seen live moneyline_*/total snapshot the line monitor
    overwrites on every poll (the best closing proxy when no dedicated capture
    fired). Values that fail a plausibility check are dropped so CLV stays
    null rather than being computed from stale in-game prices.
    """
    if not game_snapshots:
        return {}
    pairs = (
        ("closing_home_moneyline", ("closing_home", "moneyline_home"), _plausible_moneyline),
        ("closing_away_moneyline", ("closing_away", "moneyline_away"), _plausible_moneyline),
        ("closing_total", ("closing_total", "total"), _plausible_total),
    )
    result: dict[str, Any] = {}
    for target_key, source_keys, validate in pairs:
        for source_key in source_keys:
            value = validate(game_snapshots.get(source_key))
            if value is not None:
                result[target_key] = value
                break
    return result


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
    confidence = str(pick.get("confidence") or total_runs.get("confidence") or "Low")
    if confidence.lower() not in ("low", "medium", "high"):
        confidence = "Low"
    pick_probability = safe_float(pick.get("winProbability"), 50.0)
    bet_decision = prediction.get("betDecision") or {}
    # True market edge = model probability - market-implied probability.
    # Falls back to a coinflip-distance proxy (prob - 50) only when no odds
    # were available; that proxy is NOT a betting edge and saturates at the
    # model's 70% probability clamp, so prefer the real edge whenever present.
    market_edge = bet_decision.get("edge")
    moneyline_edge = (
        round(safe_float(market_edge), 3)
        if market_edge not in (None, "")
        else round(pick_probability - 50.0, 3)
    )
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
            "edge": moneyline_edge,
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


def _build_totals_trajectory(prediction: dict[str, Any]) -> dict[str, Any] | None:
    total_runs = prediction.get("totalRuns") or {}
    best_lean = str(total_runs.get("bestLean") or "")
    if not best_lean or best_lean == "No clear lean":
        return None

    away = prediction.get("away") or {}
    home = prediction.get("home") or {}
    projected = safe_float(total_runs.get("projectedTotal"), 0.0)
    market_line = safe_float(total_runs.get("marketLine"), 8.5)
    confidence = str(total_runs.get("confidence") or "low")
    if confidence.lower() not in ("low", "medium", "high"):
        confidence = "Low"
    model_edge = safe_float(total_runs.get("modelEdge"), 0.0)

    # over/underMarketProbability are only populated when live odds were attached
    # (storage.js compaction). When absent, derive them from the projected total
    # so totals predictions carry a real probability instead of a flat 50%.
    over_prob = total_runs.get("overMarketProbability")
    under_prob = total_runs.get("underMarketProbability")
    if over_prob in (None, "") or under_prob in (None, ""):
        if projected > 0 and market_line > 0:
            over_prob = round(poisson_total_probability(projected, market_line, "over") * 100.0, 2)
            under_prob = round(100.0 - over_prob, 2)
        else:
            over_prob = under_prob = 50.0
    else:
        over_prob = safe_float(over_prob, 50.0)
        under_prob = safe_float(under_prob, 50.0)

    context = {
        "game_id": prediction.get("gamePk"),
        "date": prediction.get("dateYmd"),
        "market": "totals",
        "matchup": prediction.get("matchup") or f"{away.get('name')} @ {home.get('name')}",
        "away_team": away.get("name"),
        "home_team": home.get("name"),
        "game_time": prediction.get("start"),
        "venue": prediction.get("venue"),
        "data_quality_score": 65,
        "probable_pitcher_status": "stored",
        "lineup_status": "stored",
        "weather_status": "unknown",
        "odds_status": "unknown",
        "bullpen_status": "stored",
        "tool_usage": ["get_mlb_predictions", "total_run_projection"],
        "totals": {
            "projected_total": projected,
            "market_total": market_line,
            "best_lean": best_lean,
            "confidence": confidence,
            "model_edge": model_edge,
            "over_probability": over_prob,
            "under_probability": under_prob,
        },
        "main_factors": total_runs.get("factors") or [],
        "risk_factors": [],
    }
    output = {
        "final_lean": best_lean,
        "confidence": confidence,
        "totals": context["totals"],
        "main_factors": context["main_factors"],
        "risk_factors": [],
    }
    return build_prediction_trajectory(context, output)


def _build_yrfi_trajectory(prediction: dict[str, Any]) -> dict[str, Any] | None:
    first_inning = prediction.get("firstInning") or {}
    pick = first_inning.get("pick") or first_inning.get("baselinePick")
    if not pick:
        return None

    away = prediction.get("away") or {}
    home = prediction.get("home") or {}
    probability = safe_float(first_inning.get("probability") or first_inning.get("baselineProbability"), 50.0)
    confidence_label = str(first_inning.get("confidence") or ("medium" if abs(probability - 50) >= 5 else "low"))
    if confidence_label.lower() not in ("low", "medium", "high"):
        confidence_label = "Low"

    context = {
        "game_id": prediction.get("gamePk"),
        "date": prediction.get("dateYmd"),
        "market": "yrfi",
        "matchup": prediction.get("matchup") or f"{away.get('name')} @ {home.get('name')}",
        "away_team": away.get("name"),
        "home_team": home.get("name"),
        "game_time": prediction.get("start"),
        "venue": prediction.get("venue"),
        "data_quality_score": 60,
        "probable_pitcher_status": "stored",
        "lineup_status": "stored",
        "weather_status": "unknown",
        "odds_status": "unknown",
        "bullpen_status": "n/a",
        "tool_usage": ["get_mlb_predictions", "first_inning_projection"],
        "yrfi": {
            "pick": pick,
            "probability": probability,
            "confidence": confidence_label,
            "edge": round(abs(probability - 50.0), 3),
        },
        "main_factors": first_inning.get("reasons") or [],
        "risk_factors": [],
    }
    output = {
        "final_lean": pick,
        "confidence": confidence_label,
        "yrfi": context["yrfi"],
        "main_factors": context["main_factors"],
        "risk_factors": [],
    }
    return build_prediction_trajectory(context, output)


def _prediction_to_trajectories(prediction: dict[str, Any]) -> list[dict[str, Any]]:
    """Build all market trajectories (moneyline, totals, yrfi) from a stored prediction."""
    trajectories = [_prediction_to_trajectory(prediction)]

    totals = _build_totals_trajectory(prediction)
    if totals:
        trajectories.append(totals)

    yrfi = _build_yrfi_trajectory(prediction)
    if yrfi:
        trajectories.append(yrfi)

    return trajectories


def ingest_bot_history(state_path: str | Path | None = None) -> dict[str, Any]:
    """Import settled Telegram bot history into the Evolution Engine.

    The import is idempotent by game/market. It learns from games already
    settled in the bot memory log, but it still only creates auditable
    evolution artifacts; it never promotes production rule changes.
    """
    predictions, learning_log, source = _read_bot_history(state_path)
    line_snapshots = _read_line_snapshots(source)
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
        score = _score_from_learning_log(entry)
        if not score:
            skipped_missing_score += 1
            continue

        away_score, home_score = score
        total_score = away_score + home_score
        first_inning_actual = entry.get("firstInningActual")
        first_inning_run = first_inning_actual == "YES" if first_inning_actual in ("YES", "NO") else None

        trajectories = _prediction_to_trajectories(prediction)
        for trajectory in trajectories:
            market = str(trajectory.get("market") or "moneyline")
            if _outcome_key(game_pk, market) in existing:
                skipped_duplicates += 1
                continue

            final_result = {"away_score": away_score, "home_score": home_score}
            final_result.update(_closing_odds_from_snapshots(line_snapshots.get(game_pk, {})))
            if market == "totals":
                final_result["actual_total"] = total_score
            elif market == "yrfi":
                if first_inning_run is None:
                    continue
                final_result["first_inning_run"] = first_inning_run

            result = evaluate_completed_prediction(trajectory, final_result)
            if result.get("skipped_duplicate"):
                skipped_duplicates += 1
                continue
            existing.add(_outcome_key(game_pk, market))
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
    # Repair legacy flat-50% totals/yrfi rows before anything reads outcomes,
    # so calibration and metrics train on real signal instead of coinflip noise.
    backfill = backfill_flat_outcomes(state_path)
    ingest = ingest_bot_history(state_path)
    symbolic_candidates = propose_symbolic_updates(read_jsonl("language_gradients"))

    # Apply time-decay to lessons before generating rule candidates
    raw_lessons = read_jsonl("lessons")
    decayed_lessons = apply_time_decay_to_lessons(raw_lessons, min_weight=0.05)
    rule_candidates = generate_rule_candidates(decayed_lessons, read_jsonl("language_gradients"))

    # Check for persistent miscalibration
    calibration_history = read_jsonl("calibration_history")
    miscalibrated = find_miscalibrated_buckets(calibration_history)

    backtest = backtest_candidates()

    # Rebuild per-market calibration maps now that outcomes are clean + enriched.
    try:
        calibration = retrain_calibration()
    except Exception as error:  # calibration is best-effort, never block the cycle
        calibration = {"status": "error", "reason": str(error)}

    summary = build_evolution_summary(limit=10)
    record_evolution_event(
        "evolution_cycle_completed",
        {
            "backfill": backfill,
            "ingest": ingest,
            "symbolic_candidates": len(symbolic_candidates),
            "rule_candidates": len(rule_candidates),
            "backtest": backtest,
            "calibration": calibration.get("status"),
            "miscalibrated_buckets": len(miscalibrated),
            "lessons_after_decay": len(decayed_lessons),
            "lessons_before_decay": len(raw_lessons),
        },
    )
    return {
        "backfill": backfill,
        "ingest": ingest,
        "symbolic_candidates": len(symbolic_candidates),
        "rule_candidates": len(rule_candidates),
        "backtest": backtest,
        "calibration": calibration,
        "summary": summary.get("summary", {}),
        "miscalibrated_buckets": miscalibrated,
        "lessons_decayed": len(raw_lessons) - len(decayed_lessons),
        "safety": "Candidates are pending only. Production rules, prompts, and weights were not auto-promoted.",
    }


def backfill_flat_outcomes(state_path: str | Path | None = None) -> dict[str, Any]:
    """Recompute real probability + Brier for legacy flat-50% totals/yrfi rows.

    Rows ingested before the 2026-05-30 probability fix stored a flat
    predicted_probability of 50 (Brier 0.2500) — pure coinflip noise that
    dilutes every calibration/edge metric. The normal ingest path is
    append-only and deduped by game/market, so it can never correct them. This
    rebuilds the trajectory from the still-stored bot prediction (picks payload)
    and recomputes probability + Brier in place, leaving win/loss/profit
    untouched. Idempotent: once a row carries real signal it is no longer flat
    and is skipped on the next run.
    """
    predictions, _learning_log, source = _read_bot_history(state_path)
    rows = read_prediction_outcomes()
    updated = 0
    skipped_no_source = 0
    skipped_still_flat = 0
    by_market = {"totals": 0, "yrfi": 0}

    for row in rows:
        market = str(row.get("market") or "").lower()
        if market not in ("totals", "yrfi") or row.get("result") not in ("win", "loss"):
            continue
        brier = safe_float(row.get("brier_score"), None)
        if brier is None or abs(brier - 0.25) > 1e-9:
            continue  # only touch the flat coinflip rows

        prediction = predictions.get(str(row.get("game_id")))
        if not prediction:
            skipped_no_source += 1
            continue
        trajectory = (
            _build_totals_trajectory(prediction)
            if market == "totals"
            else _build_yrfi_trajectory(prediction)
        )
        if not trajectory:
            skipped_no_source += 1
            continue

        prob = _predicted_probability(trajectory, market, str(row.get("prediction") or ""))
        if abs(prob - 0.5) < 1e-9:
            skipped_still_flat += 1  # projected == market line; genuinely no signal
            continue

        outcome = 1.0 if row.get("result") == "win" else 0.0
        new_brier = round((prob - outcome) ** 2, 6)
        evaluation = _safe_json(row.get("evaluation_json"), {})
        evaluation["predicted_probability"] = round(prob * 100.0, 3)
        evaluation["brier_score"] = new_brier
        row["brier_score"] = new_brier
        row["evaluation_json"] = json.dumps(evaluation, sort_keys=True, default=str)
        updated += 1
        by_market[market] += 1

    if updated:
        rewrite_prediction_outcomes(rows)
        record_evolution_event(
            "flat_outcomes_backfilled",
            {"source": source, "updated": updated, "by_market": by_market},
        )

    return {
        "source": source or "not_found",
        "updated": updated,
        "totals_fixed": by_market["totals"],
        "yrfi_fixed": by_market["yrfi"],
        "skipped_no_source": skipped_no_source,
        "skipped_still_flat": skipped_still_flat,
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
    all_lessons = read_jsonl("lessons")
    recent = all_lessons[-5:] if all_lessons else []
    return {
        "lessons_count": len(all_lessons),
        "language_losses": len(read_jsonl("language_losses")),
        "language_gradients": len(read_jsonl("language_gradients")),
        "recent_lessons": [
            {
                "game_id": l.get("game_id"),
                "lesson_type": l.get("lesson_type"),
                "summary": l.get("summary", ""),
                "suggested_adjustment": l.get("suggested_adjustment", ""),
                "date": l.get("date", ""),
            }
            for l in recent
        ],
    }


def propose_rules() -> dict[str, Any]:
    candidates = generate_rule_candidates(read_jsonl("lessons"), read_jsonl("language_gradients"))
    all_candidates = read_jsonl("rule_candidates")
    return {
        "new_candidates": len(candidates),
        "total_candidates": len(all_candidates),
        "candidates": [
            {
                "candidate_id": c.get("candidate_id"),
                "type": c.get("type"),
                "rule": c.get("rule") or c.get("update", ""),
                "priority_score": c.get("priority_score", 0),
                "backtest_status": c.get("backtest_status", "pending"),
                "promotion_status": c.get("promotion_status", "pending"),
            }
            for c in all_candidates[-5:]
        ],
    }


def _compute_metrics_from_outcomes(outcomes: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute aggregate metrics from a list of prediction outcome rows."""
    if not outcomes:
        return {"sample_size": 0, "roi": 0.0, "brier_score": 1.0, "log_loss": 1.0, "accuracy": 0.0, "average_clv": 0.0, "max_drawdown": 0.0}

    wins = sum(1 for o in outcomes if o.get("result") == "win")
    total = len(outcomes)
    accuracy = wins / total if total else 0.0

    profit_losses = [safe_float(o.get("profit_loss"), 0.0) for o in outcomes]
    roi = sum(profit_losses) / total if total else 0.0

    brier_values = [safe_float(o.get("brier_score"), None) for o in outcomes]
    brier_valid = [b for b in brier_values if b is not None]
    brier_score = sum(brier_valid) / len(brier_valid) if brier_valid else 1.0

    import math
    log_loss_values = []
    for o in outcomes:
        bs = safe_float(o.get("brier_score"), None)
        if bs is not None:
            prob = 1.0 - math.sqrt(bs) if o.get("result") == "win" else math.sqrt(bs)
            prob = max(1e-15, min(1 - 1e-15, prob))
            outcome_val = 1.0 if o.get("result") == "win" else 0.0
            ll = -(outcome_val * math.log(prob) + (1 - outcome_val) * math.log(1 - prob))
            log_loss_values.append(ll)
    log_loss = sum(log_loss_values) / len(log_loss_values) if log_loss_values else 1.0

    clv_values = [safe_float(o.get("clv"), None) for o in outcomes]
    clv_valid = [c for c in clv_values if c is not None]
    average_clv = sum(clv_valid) / len(clv_valid) if clv_valid else 0.0

    cumulative = 0.0
    peak = 0.0
    max_drawdown = 0.0
    for pl in profit_losses:
        cumulative += pl
        peak = max(peak, cumulative)
        drawdown = peak - cumulative
        max_drawdown = max(max_drawdown, drawdown)

    return {
        "sample_size": total,
        "roi": roi,
        "brier_score": brier_score,
        "log_loss": log_loss,
        "accuracy": accuracy,
        "average_clv": average_clv,
        "max_drawdown": max_drawdown,
    }


def _matches_segment(outcome: dict[str, Any], segment: str) -> bool:
    """Check if an outcome matches a candidate's target segment."""
    segment_lower = segment.lower()
    market = str(outcome.get("market", "")).lower()
    confidence = str(outcome.get("confidence", "")).lower()
    if segment_lower in (market, confidence):
        return True
    if segment_lower in ("moneyline", "totals", "yrfi") and market == segment_lower:
        return True
    return False


def _write_candidates(candidates: list[dict[str, Any]]) -> None:
    """Overwrite rule_candidates.jsonl with updated candidates."""
    path = path_for("rule_candidates")
    with path.open("w", encoding="utf-8") as handle:
        for candidate in candidates:
            handle.write(json.dumps(candidate, sort_keys=True, default=str) + "\n")


def backtest_candidates() -> dict[str, Any]:
    """Run backtest on pending candidates and pass through promotion gate."""
    candidates = read_jsonl("rule_candidates")
    pending = [c for c in candidates if c.get("backtest_status") == "pending"]
    outcomes = read_prediction_outcomes()

    if not outcomes or not pending:
        return {"pending_candidates": len(pending), "processed": 0, "reason": "no data or no pending candidates"}

    results = []
    batch = pending[:10]

    for candidate in batch:
        created_at = str(candidate.get("created_at") or candidate.get("date") or "")
        if not created_at:
            candidate["backtest_status"] = "skipped"
            candidate["promotion_status"] = "skipped"
            continue

        before = [o for o in outcomes if str(o.get("date", "")) < created_at]
        after = [o for o in outcomes if str(o.get("date", "")) >= created_at]

        segment = candidate.get("segment") or candidate.get("market")
        if segment:
            before = [o for o in before if _matches_segment(o, segment)]
            after = [o for o in after if _matches_segment(o, segment)]

        if len(before) < 20 or len(after) < 20:
            candidate["backtest_status"] = "insufficient_data"
            candidate["promotion_status"] = "deferred"
            continue

        before_metrics = _compute_metrics_from_outcomes(before)
        after_metrics = _compute_metrics_from_outcomes(after)

        gate_result = run_promotion_gate(
            candidate, before_metrics, after_metrics,
            min_sample_size=20, persist=True,
        )
        candidate["backtest_status"] = "completed"
        candidate["promotion_status"] = gate_result["status"]
        results.append(gate_result)

    _write_candidates(candidates)
    return {
        "pending_candidates": len(pending),
        "processed": len(results),
        "approved": sum(1 for r in results if r["status"] == "approved"),
        "rejected": sum(1 for r in results if r["status"] == "rejected"),
        "results": results,
    }


def promote_approved() -> dict[str, Any]:
    """Apply approved candidates to production configuration."""
    candidates = read_jsonl("rule_candidates")
    approved = [c for c in candidates if c.get("promotion_status") == "approved"]

    if not approved:
        return {"promoted": 0, "message": "No approved candidates to promote."}

    weight_versions = read_json("weight_versions")
    promoted = []

    for candidate in approved:
        candidate_type = str(candidate.get("type", "")).lower()

        if candidate_type in ("weight_update", "weight_change"):
            current_weights = weight_versions.get("current_weights", {})
            target = candidate.get("target_weight") or candidate.get("weight_name")
            new_value = safe_float(candidate.get("new_value") or candidate.get("proposed_value"), None)
            if target and new_value is not None:
                current_weights[target] = new_value
                weight_versions["current_weights"] = current_weights

        candidate["promotion_status"] = "promoted"
        promoted.append(candidate.get("candidate_id"))

    if promoted:
        current_version = str(weight_versions.get("active_version", "weights-v1.0"))
        try:
            prefix, version = current_version.rsplit("v", 1)
            major, minor = version.split(".", 1)
            weight_versions["active_version"] = f"{prefix}v{major}.{int(minor) + 1}"
        except ValueError:
            weight_versions["active_version"] = f"{current_version}-promoted"
        write_json("weight_versions", weight_versions)

    _write_candidates(candidates)

    record_evolution_event("batch_promotion", {
        "promoted_count": len(promoted),
        "candidate_ids": promoted,
    })

    return {"promoted": len(promoted), "candidate_ids": promoted}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MLB Agent Evolution Engine.")
    parser.add_argument("--run-cycle", action="store_true")
    parser.add_argument("--ingest-bot-history", action="store_true")
    parser.add_argument("--backfill-flat", action="store_true")
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
    elif args.backfill_flat:
        print(json.dumps(backfill_flat_outcomes(state_path), indent=2))
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
