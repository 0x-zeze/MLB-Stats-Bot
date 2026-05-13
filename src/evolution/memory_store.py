"""Storage helpers for the auditable evolution engine."""

from __future__ import annotations

import csv
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..utils import DATA_DIR, safe_float

JSONL_FILES = {
    "lessons": "lessons.jsonl",
    "rule_candidates": "rule_candidates.jsonl",
    "evolution_log": "evolution_log.jsonl",
    "trajectories": "trajectories.jsonl",
    "language_losses": "language_losses.jsonl",
    "language_gradients": "language_gradients.jsonl",
    "tool_usage_reports": "tool_usage_reports.jsonl",
    "symbolic_updates": "symbolic_updates.jsonl",
    "audit_reports": "audit_reports.jsonl",
}

JSON_FILES = {
    "approved_rules": "approved_rules.json",
    "rejected_rules": "rejected_rules.json",
    "weight_versions": "weight_versions.json",
    "prompt_versions": "prompt_versions.json",
    "audit_memory": "audit_memory.json",
}

PREDICTION_OUTCOME_FIELDS = [
    "game_id",
    "date",
    "market",
    "prediction",
    "confidence",
    "result",
    "actual_score",
    "actual_total",
    "profit_loss",
    "clv",
    "brier_score",
    "calibration_bucket",
    "evaluation_json",
]

DEFAULT_MONEYLINE_WEIGHTS = {
    "starting_pitcher": 0.24,
    "offense": 0.22,
    "bullpen": 0.14,
    "home_advantage": 0.08,
    "recent_form": 0.10,
    "market_odds": 0.12,
    "data_quality": 0.10,
}

DEFAULT_TOTALS_WEIGHTS = {
    "starting_pitcher_run_prevention": 0.22,
    "offense_splits": 0.20,
    "bullpen_fatigue": 0.13,
    "weather": 0.10,
    "park_factor": 0.10,
    "lineup": 0.10,
    "recent_form": 0.07,
    "market_total": 0.05,
    "data_quality": 0.03,
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def evolution_data_dir() -> Path:
    override = os.environ.get("MLB_EVOLUTION_DATA_DIR") or os.environ.get("EVOLUTION_DATA_DIR")
    return Path(override) if override else DATA_DIR / "evolution"


def path_for(file_key: str) -> Path:
    files = {**JSONL_FILES, **JSON_FILES, "prediction_outcomes": "prediction_outcomes.csv"}
    if file_key not in files:
        raise KeyError(f"Unknown evolution storage file: {file_key}")
    return evolution_data_dir() / files[file_key]


def _default_json(file_key: str) -> dict[str, Any]:
    if file_key == "approved_rules":
        return {"active_rule_version": "rules-v1.0", "approved": [], "rollback_supported": True}
    if file_key == "rejected_rules":
        return {"rejected": []}
    if file_key == "weight_versions":
        return {
            "active_version": "weights-v1.0",
            "versions": [
                {
                    "version": "weights-v1.0",
                    "date_created": utc_now(),
                    "reason": "Initial conservative baseline weights.",
                    "status": "active",
                    "weights": {
                        "moneyline": DEFAULT_MONEYLINE_WEIGHTS,
                        "totals": DEFAULT_TOTALS_WEIGHTS,
                    },
                    "previous_version": None,
                    "rollback_supported": True,
                }
            ],
        }
    if file_key == "prompt_versions":
        return {
            "active_version": "mlb-analyst-v1.0",
            "versions": [
                {
                    "version": "mlb-analyst-v1.0",
                    "date_created": utc_now(),
                    "reason": "Initial analyst prompt version.",
                    "changes": [],
                    "previous_version": None,
                    "status": "active",
                    "source_losses": [],
                    "source_gradients": [],
                    "backtest_result": None,
                    "rollback_supported": True,
                }
            ],
        }
    if file_key == "audit_memory":
        return {
            "version": "audit-memory-v1.0",
            "updated_at": utc_now(),
            "mistake_patterns": [],
            "next_game_cautions": [],
            "production_authority": "advisory_memory_only",
            "rollback_supported": True,
        }
    return {}


def ensure_evolution_storage() -> Path:
    root = evolution_data_dir()
    root.mkdir(parents=True, exist_ok=True)

    outcome_path = path_for("prediction_outcomes")
    if not outcome_path.exists():
        with outcome_path.open("w", encoding="utf-8", newline="") as handle:
            csv.DictWriter(handle, fieldnames=PREDICTION_OUTCOME_FIELDS).writeheader()

    for file_key in JSONL_FILES:
        path_for(file_key).touch(exist_ok=True)

    for file_key in JSON_FILES:
        path = path_for(file_key)
        if not path.exists():
            write_json(file_key, _default_json(file_key))
    return root


def _json_default(value: Any) -> str:
    return str(value)


def append_jsonl(file_key: str, record: dict[str, Any]) -> dict[str, Any]:
    ensure_evolution_storage()
    payload = dict(record)
    payload.setdefault("created_at", utc_now())
    with path_for(file_key).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, sort_keys=True, default=_json_default) + "\n")
    return payload


def read_jsonl(file_key: str, limit: int | None = None) -> list[dict[str, Any]]:
    ensure_evolution_storage()
    path = path_for(file_key)
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            rows.append(json.loads(text))
    return rows[-limit:] if limit else rows


def read_json(file_key: str) -> dict[str, Any]:
    ensure_evolution_storage()
    with path_for(file_key).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(file_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    evolution_data_dir().mkdir(parents=True, exist_ok=True)
    with path_for(file_key).open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True, default=_json_default)
    return payload


def append_prediction_outcome(evaluation: dict[str, Any]) -> dict[str, Any]:
    ensure_evolution_storage()
    row = {field: "" for field in PREDICTION_OUTCOME_FIELDS}
    for field in PREDICTION_OUTCOME_FIELDS:
        if field == "evaluation_json":
            row[field] = json.dumps(evaluation, sort_keys=True, default=_json_default)
        else:
            row[field] = evaluation.get(field, "")
    with path_for("prediction_outcomes").open("a", encoding="utf-8", newline="") as handle:
        csv.DictWriter(handle, fieldnames=PREDICTION_OUTCOME_FIELDS).writerow(row)
    return row


def read_prediction_outcomes() -> list[dict[str, Any]]:
    ensure_evolution_storage()
    with path_for("prediction_outcomes").open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def current_versions() -> dict[str, str]:
    prompts = read_json("prompt_versions")
    weights = read_json("weight_versions")
    rules = read_json("approved_rules")
    return {
        "prompt_version": prompts.get("active_version", "mlb-analyst-v1.0"),
        "rule_version": rules.get("active_rule_version", "rules-v1.0"),
        "weight_version": weights.get("active_version", "weights-v1.0"),
        "model_version": "baseline-model-v1.0",
    }


def record_evolution_event(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return append_jsonl("evolution_log", {"event_type": event_type, "payload": payload})


def _context_value(context: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in context:
            return context.get(key)
    return None


def _lesson_similarity(context: dict[str, Any], lesson: dict[str, Any]) -> float:
    score = 0.0
    supporting = lesson.get("supporting_data") or {}
    if str(context.get("market") or "").lower() == str(lesson.get("market") or "").lower():
        score += 4.0
    if str(context.get("confidence") or "").lower() == str(supporting.get("confidence") or "").lower():
        score += 1.0
    if abs(safe_float(context.get("market_total"), -99) - safe_float(supporting.get("market_total"), 99)) <= 1.0:
        score += 1.5
    if abs(safe_float(context.get("projected_total_difference"), -99) - safe_float(supporting.get("projected_total_difference"), 99)) <= 0.5:
        score += 1.5
    if abs(safe_float(context.get("data_quality"), -99) - safe_float(supporting.get("data_quality"), 99)) <= 10:
        score += 1.0
    for key in ["lineup_status", "weather_status", "bullpen_status", "no_bet_reason"]:
        if _context_value(context, key) and str(_context_value(context, key)).lower() == str(supporting.get(key) or "").lower():
            score += 1.0
    return score


def retrieve_similar_lessons(game_context: dict[str, Any], top_k: int = 5) -> dict[str, Any]:
    """Return similar lessons as advisory context only.

    Memory is intentionally non-authoritative: callers should use these notes
    as caution context, never as an override for current validated data.
    """
    lessons = read_jsonl("lessons")
    ranked = sorted(
        ((lesson, _lesson_similarity(game_context, lesson)) for lesson in lessons),
        key=lambda item: item[1],
        reverse=True,
    )
    selected = [lesson for lesson, score in ranked if score > 0][:top_k]
    pattern_counts: dict[str, int] = {}
    for lesson in selected:
        key = str(lesson.get("lesson_type") or lesson.get("category") or "general")
        pattern_counts[key] = pattern_counts.get(key, 0) + 1
    repeated = [key for key, count in pattern_counts.items() if count >= 2]
    caution = [f"Repeated past lesson pattern: {key}" for key in repeated]
    if selected and not caution:
        caution.append("Similar lessons found; use as caution context, not as an override.")
    return {
        "lessons": selected,
        "repeated_risk_patterns": repeated,
        "recommended_caution_notes": caution,
    }


def _recency_weight(created_at: str | None, half_life_days: float = 14.0) -> float:
    """Exponential decay weight based on how recent the record is.

    half_life_days controls how fast old records lose influence.
    14-day half-life means a 2-week-old lesson has 50% weight, 4-week-old has 25%, etc.
    """
    if not created_at:
        return 0.3  # unknown date gets low base weight
    try:
        created = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
        age_days = max(0.0, (datetime.now(timezone.utc) - created).total_seconds() / 86400.0)
        return max(0.05, 2.0 ** (-age_days / half_life_days))
    except (ValueError, TypeError):
        return 0.3


def _market_regimen(context: dict[str, Any]) -> str:
    """Classify the market regime for matching."""
    market = str(context.get("market") or "moneyline").lower()
    if market == "totals":
        total = safe_float(context.get("market_total"), 8.5)
        if total >= 10.0:
            return "totals_high"
        if total >= 8.5:
            return "totals_moderate"
        return "totals_low"
    return "moneyline"


def _weighted_lesson_similarity(context: dict[str, Any], lesson: dict[str, Any]) -> dict[str, float]:
    """Compute multi-dimensional weighted similarity between context and lesson.

    Returns individual dimension scores and a composite weighted score.
    """
    # Base similarity from existing function
    base_sim = _lesson_similarity(context, lesson)

    # Recency weight
    created_at = lesson.get("created_at")
    recency = _recency_weight(created_at)

    # Market regime match
    context_regime = _market_regimen(context)
    supporting = lesson.get("supporting_data") or {}
    lesson_context = {**lesson, **supporting}
    lesson_regime = _market_regimen(lesson_context)
    regime_match = 1.0 if context_regime == lesson_regime else 0.3

    # Confidence tier match
    context_conf = str(context.get("confidence") or "").lower()
    lesson_conf = str(supporting.get("confidence") or lesson.get("confidence") or "").lower()
    conf_match = 1.0 if context_conf == lesson_conf else 0.5

    # Sample size bonus: lessons derived from more outcomes are more reliable
    sample_size = safe_float(lesson.get("sample_size") or supporting.get("sample_size"), 1.0)
    sample_weight = min(1.0, 0.5 + sample_size * 0.1)  # 1.0 at 5+ samples, 0.5 at 1

    # Composite weighted score
    composite = (
        base_sim * 0.40
        + recency * 8.0 * 0.25
        + regime_match * 4.0 * 0.15
        + conf_match * 3.0 * 0.10
        + sample_weight * 3.0 * 0.10
    )

    return {
        "base_similarity": round(base_sim, 3),
        "recency_weight": round(recency, 4),
        "regime_match": round(regime_match, 3),
        "confidence_match": round(conf_match, 3),
        "sample_weight": round(sample_weight, 3),
        "composite_score": round(composite, 3),
    }


def retrieve_weighted_memory(
    game_context: dict[str, Any],
    top_k: int = 8,
    min_composite: float = 1.0,
) -> dict[str, Any]:
    """Return weighted memory with recency, similarity, sample size, and market regime.

    Unlike retrieve_similar_lessons, this function produces a weighted
    influence score for each memory entry and aggregates risk patterns
    with confidence-weighted frequencies.

    Memory is advisory only — it adjusts risk framing, never raw probabilities.
    """
    lessons = read_jsonl("lessons")
    outcomes = read_prediction_outcomes()

    # Build outcome lookup for sample size enrichment
    outcome_by_market: dict[str, int] = {}
    for row in outcomes:
        mkt = str(row.get("market") or "moneyline").lower()
        outcome_by_market[mkt] = outcome_by_market.get(mkt, 0) + 1

    scored: list[dict[str, Any]] = []
    for lesson in lessons:
        dims = _weighted_lesson_similarity(game_context, lesson)
        if dims["composite_score"] < min_composite:
            continue
        scored.append({
            "lesson": lesson,
            "dimensions": dims,
        })

    scored.sort(key=lambda x: x["dimensions"]["composite_score"], reverse=True)
    selected = scored[:top_k]

    # Aggregate risk patterns with confidence weighting
    pattern_scores: dict[str, float] = {}
    pattern_counts: dict[str, int] = {}
    for entry in selected:
        lesson = entry["lesson"]
        weight = entry["dimensions"]["composite_score"]
        key = str(lesson.get("lesson_type") or lesson.get("category") or "general")
        pattern_scores[key] = pattern_scores.get(key, 0.0) + weight
        pattern_counts[key] = pattern_counts.get(key, 0) + 1

    # Risk patterns that appear multiple times AND have high composite scores
    repeated = [
        key for key, count in pattern_counts.items()
        if count >= 2 or pattern_scores.get(key, 0) >= 5.0
    ]

    # Build caution notes with weighted confidence
    caution: list[str] = []
    for pattern in sorted(repeated, key=lambda k: pattern_scores.get(k, 0), reverse=True):
        score = pattern_scores.get(pattern, 0)
        count = pattern_counts.get(pattern, 0)
        if score >= 8.0:
            caution.append(f"⚠ Strong signal: {pattern} (weight: {score:.1f}, seen {count}x)")
        elif score >= 4.0:
            caution.append(f"⚡ Moderate signal: {pattern} (weight: {score:.1f}, seen {count}x)")
        else:
            caution.append(f"• Weak signal: {pattern} (weight: {score:.1f}, seen {count}x)")

    if selected and not caution:
        caution.append("Similar lessons found; use as caution context, not as an override.")

    # Compute overall memory confidence
    total_composite = sum(e["dimensions"]["composite_score"] for e in selected)
    avg_composite = total_composite / len(selected) if selected else 0.0
    memory_confidence = "high" if avg_composite >= 5.0 and len(selected) >= 3 else \
                        "medium" if avg_composite >= 2.5 else "low"

    return {
        "weighted_lessons": [
            {
                "lesson": e["lesson"],
                "similarity_dimensions": e["dimensions"],
            }
            for e in selected
        ],
        "risk_patterns": repeated,
        "pattern_scores": {k: round(v, 2) for k, v in sorted(pattern_scores.items(), key=lambda x: -x[1])},
        "caution_notes": caution,
        "memory_confidence": memory_confidence,
        "sample_context": {
            "total_lessons_available": len(lessons),
            "total_outcomes_recorded": len(outcomes),
            "lessons_selected": len(selected),
            "market_regime": _market_regimen(game_context),
        },
    }
