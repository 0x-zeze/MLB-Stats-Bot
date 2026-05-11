"""Aggregate audit and weakness diagnosis for the Evolution Engine."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from statistics import mean
from typing import Any

from ..utils import safe_float
from .memory_store import append_jsonl, read_json, read_jsonl, read_prediction_outcomes, utc_now


RECOMMENDATION_MAP = {
    "record_bias": "Cap confidence or return NO BET when record/H2H/recent-form context dominates weak game-specific matchup edge.",
    "weak_edge": "Raise the required edge or return NO BET when model edge is marginal.",
    "overconfidence": "Tighten confidence caps; do not allow Medium/High confidence without multiple independent Tier 1 signals.",
    "lineup_misread": "Downgrade confidence when lineup is projected, missing, or key lineup slots are unclear.",
    "weather_misread": "Require fresh weather context before confident outdoor totals or YRFI decisions.",
    "bad_data_quality": "Lower confidence or return NO BET when data quality falls below the safe threshold.",
    "totals_projection_error": "Review totals weights for starter run prevention, bullpen fatigue, park, weather, and lineup impact.",
    "market_misread": "Compare model probability against implied odds and closing line before treating a lean as value.",
    "pitcher_misread": "Increase review of starter K-BB%, WHIP, HR/9, handedness split, and opener/bulk risk.",
    "bullpen_misread": "Increase penalty for tired bullpen, back-to-back relievers, and short-start risk.",
    "bad_no_bet": "Audit whether NO BET filters are too strict before changing production rules.",
    "tool_usage_error": "Require the missing tool or stale-data refresh before final confidence is assigned.",
}

TYPE_PRIORITY = {
    "no_bet_rule": 5,
    "confidence_cap": 5,
    "threshold_update": 4,
    "data_quality_update": 4,
    "tool_order_update": 3,
    "weighting_update": 3,
    "prompt_update": 2,
    "explanation_update": 1,
}


def _parse_json(value: Any, fallback: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if value in (None, ""):
        return fallback
    try:
        return json.loads(str(value))
    except (TypeError, json.JSONDecodeError):
        return fallback


def _evaluation_rows() -> list[dict[str, Any]]:
    rows = []
    for row in read_prediction_outcomes():
        evaluation = _parse_json(row.get("evaluation_json"), {})
        merged = {**row, **evaluation}
        merged["result"] = str(merged.get("result") or "").lower()
        merged["market"] = str(merged.get("market") or "moneyline").lower()
        merged["confidence"] = str(merged.get("confidence") or "unknown").lower()
        rows.append(merged)
    return rows


def _pct(numerator: float, denominator: float) -> float:
    return round((numerator / denominator) * 100.0, 1) if denominator else 0.0


def _avg(values: list[float]) -> float | None:
    clean = [value for value in values if isinstance(value, (int, float))]
    return round(mean(clean), 4) if clean else None


def _bucket_edge(row: dict[str, Any]) -> str:
    edge = abs(safe_float(row.get("edge"), 0.0))
    if edge < 2.0:
        return "edge:weak <2"
    if edge < 5.0:
        return "edge:moderate 2-5"
    return "edge:strong 5+"


def _bucket_data_quality(row: dict[str, Any]) -> str:
    quality = safe_float(row.get("data_quality"), 0.0)
    if quality <= 0:
        return "data_quality:unknown"
    if quality < 65:
        return "data_quality:low"
    if quality < 80:
        return "data_quality:medium"
    return "data_quality:high"


def _bucket_clv(row: dict[str, Any]) -> str | None:
    clv = row.get("clv")
    if clv in (None, ""):
        return None
    parsed = safe_float(clv, 0.0)
    if parsed > 0.01:
        return "clv:positive"
    if parsed < -0.01:
        return "clv:negative"
    return "clv:flat"


def _bet_status(row: dict[str, Any]) -> str:
    result = str(row.get("result") or "").lower()
    if result == "no_bet":
        return "decision:no_bet"
    return "decision:bet_or_lean"


def _prediction_side(row: dict[str, Any]) -> str:
    prediction = str(row.get("prediction") or "").lower()
    if prediction.startswith("over"):
        return "side:over"
    if prediction.startswith("under"):
        return "side:under"
    if prediction == "no bet":
        return "side:no_bet"
    return "side:moneyline"


def _segment_labels(row: dict[str, Any]) -> list[str]:
    labels = [
        f"market:{row.get('market') or 'unknown'}",
        f"confidence:{row.get('confidence') or 'unknown'}",
        _bet_status(row),
        _prediction_side(row),
        _bucket_edge(row),
        _bucket_data_quality(row),
    ]
    clv = _bucket_clv(row)
    if clv:
        labels.append(clv)
    if row.get("overconfidence"):
        labels.append("calibration:overconfidence")
    if row.get("underconfidence"):
        labels.append("calibration:underconfidence")
    return labels


def _segment_record(label: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    wins = sum(1 for row in rows if row.get("result") == "win")
    losses = sum(1 for row in rows if row.get("result") == "loss")
    pushes = sum(1 for row in rows if row.get("result") == "push")
    no_bets = sum(1 for row in rows if row.get("result") == "no_bet")
    decided = wins + losses
    briers = [safe_float(row.get("brier_score"), 0.0) for row in rows if row.get("brier_score") not in (None, "")]
    clvs = [safe_float(row.get("clv"), 0.0) for row in rows if row.get("clv") not in (None, "")]
    no_bet_good = sum(1 for row in rows if row.get("result") == "no_bet" and str(row.get("no_bet_appropriate")).lower() == "true")
    return {
        "segment": label,
        "sample_size": len(rows),
        "decided": decided,
        "wins": wins,
        "losses": losses,
        "pushes": pushes,
        "no_bets": no_bets,
        "accuracy": _pct(wins, decided),
        "loss_rate": _pct(losses, decided),
        "no_bet_quality": _pct(no_bet_good, no_bets),
        "average_brier": _avg(briers),
        "average_clv": _avg(clvs),
    }


def segment_performance(rows: list[dict[str, Any]], min_sample: int = 3) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        for label in _segment_labels(row):
            grouped[label].append(row)
    records = [_segment_record(label, items) for label, items in grouped.items() if len(items) >= min_sample]
    return sorted(records, key=lambda item: (item["loss_rate"], item["losses"], item["sample_size"]), reverse=True)


def _severity_weight(value: Any) -> int:
    severity = str(value or "").lower()
    if severity == "high":
        return 3
    if severity == "medium":
        return 2
    return 1


def root_causes(losses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for loss in losses:
        key = str(loss.get("loss_type") or loss.get("affected_factor") or "general")
        grouped[key].append(loss)
    records = []
    for key, items in grouped.items():
        affected = Counter(str(item.get("affected_factor") or "general") for item in items).most_common(1)
        markets = Counter(str(item.get("market") or "unknown") for item in items).most_common(2)
        records.append(
            {
                "loss_type": key,
                "count": len(items),
                "severity_score": sum(_severity_weight(item.get("severity")) for item in items),
                "primary_factor": affected[0][0] if affected else "general",
                "markets": [market for market, _count in markets],
                "latest_summary": str(items[-1].get("loss_summary") or ""),
            }
        )
    return sorted(records, key=lambda item: (item["severity_score"], item["count"]), reverse=True)


def recommendations(causes: list[dict[str, Any]], segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for cause in causes:
        key = str(cause.get("loss_type") or "")
        text = RECOMMENDATION_MAP.get(key)
        if not text:
            factor = str(cause.get("primary_factor") or "general")
            text = RECOMMENDATION_MAP.get(factor, f"Review repeated {key or factor} losses before changing production behavior.")
        if text in seen:
            continue
        seen.add(text)
        items.append(
            {
                "priority": "high" if cause.get("count", 0) >= 5 or cause.get("severity_score", 0) >= 10 else "medium",
                "target": cause.get("primary_factor") or cause.get("loss_type"),
                "recommendation": text,
                "evidence": f"{cause.get('count', 0)} losses; markets: {', '.join(cause.get('markets') or [])}",
            }
        )
    for segment in segments[:3]:
        if segment.get("loss_rate", 0) < 55 or segment.get("decided", 0) < 3:
            continue
        text = f"Audit {segment['segment']} before increasing confidence; this segment is losing {segment['loss_rate']}% of decided picks."
        if text not in seen:
            seen.add(text)
            items.append(
                {
                    "priority": "medium",
                    "target": segment["segment"],
                    "recommendation": text,
                    "evidence": f"{segment['wins']}-{segment['losses']} over {segment['decided']} decided picks.",
                }
            )
    return items[:8]


def _source_count(candidate: dict[str, Any]) -> int:
    total = 0
    for key in ["source_losses", "source_lessons", "source_gradients"]:
        value = candidate.get(key)
        if isinstance(value, list):
            total += len([item for item in value if item])
    reason = str(candidate.get("reason") or "")
    match = re.search(r"(\d+)\s+times", reason)
    if match:
        total = max(total, int(match.group(1)))
    return total


def candidate_priorities(limit: int = 10) -> list[dict[str, Any]]:
    candidates_by_id: dict[str, dict[str, Any]] = {}
    for candidate in [*read_jsonl("rule_candidates"), *read_jsonl("symbolic_updates")]:
        candidate_id = str(candidate.get("candidate_id") or candidate)
        existing = candidates_by_id.get(candidate_id)
        if existing and _source_count(existing) >= _source_count(candidate):
            continue
        candidates_by_id[candidate_id] = candidate

    records = []
    for candidate in candidates_by_id.values():
        status = str(candidate.get("promotion_status") or candidate.get("status") or "pending").lower()
        if status not in {"pending", "candidate"}:
            continue
        source_count = _source_count(candidate)
        candidate_type = str(candidate.get("type") or "symbolic_update")
        score = source_count * 2 + TYPE_PRIORITY.get(candidate_type, 1)
        records.append(
            {
                "candidate_id": candidate.get("candidate_id"),
                "type": candidate_type,
                "priority_score": score,
                "source_count": source_count,
                "update": candidate.get("update") or candidate.get("rule"),
                "reason": candidate.get("reason"),
                "backtest_status": candidate.get("backtest_status") or "pending",
                "promotion_status": candidate.get("promotion_status") or candidate.get("status") or "pending",
            }
        )
    return sorted(records, key=lambda item: item["priority_score"], reverse=True)[:limit]


def _risk_warnings(causes: list[dict[str, Any]], weakest: list[dict[str, Any]]) -> list[dict[str, str]]:
    warnings: list[dict[str, str]] = []
    for cause in causes[:5]:
        if cause.get("count", 0) >= 2:
            warnings.append(
                {
                    "pattern": str(cause.get("loss_type")),
                    "severity": "high" if cause.get("severity_score", 0) >= 10 else "medium",
                    "note": f"{cause.get('count')} losses touched {cause.get('primary_factor')}.",
                }
            )
    for segment in weakest[:3]:
        if segment.get("decided", 0) >= 3 and segment.get("loss_rate", 0) >= 55:
            warnings.append(
                {
                    "pattern": str(segment.get("segment")),
                    "severity": "medium",
                    "note": f"{segment.get('wins')}-{segment.get('losses')} with {segment.get('loss_rate')}% loss rate.",
                }
            )
    return warnings[:8]


def build_evolution_audit(
    *,
    min_segment_sample: int = 3,
    candidate_limit: int = 10,
    persist: bool = False,
) -> dict[str, Any]:
    rows = _evaluation_rows()
    losses = read_jsonl("language_losses")
    lessons = read_jsonl("lessons")
    gradients = read_jsonl("language_gradients")
    candidates = [*read_jsonl("rule_candidates"), *read_jsonl("symbolic_updates")]
    approved = read_json("approved_rules").get("approved", [])
    rejected = read_json("rejected_rules").get("rejected", [])

    wins = sum(1 for row in rows if row.get("result") == "win")
    lost = sum(1 for row in rows if row.get("result") == "loss")
    pushes = sum(1 for row in rows if row.get("result") == "push")
    no_bets = sum(1 for row in rows if row.get("result") == "no_bet")
    decided = wins + lost
    briers = [safe_float(row.get("brier_score"), 0.0) for row in rows if row.get("brier_score") not in (None, "")]
    clvs = [safe_float(row.get("clv"), 0.0) for row in rows if row.get("clv") not in (None, "")]

    segments = segment_performance(rows, min_sample=min_segment_sample)
    decided_segments = [segment for segment in segments if segment.get("decided", 0) >= min_segment_sample]
    weakest = sorted(decided_segments, key=lambda item: (item["loss_rate"], item["losses"], item["sample_size"]), reverse=True)[:8]
    strongest = sorted(decided_segments, key=lambda item: (item["accuracy"], item["wins"], item["sample_size"]), reverse=True)[:8]
    causes = root_causes(losses)
    priorities = candidate_priorities(limit=candidate_limit)
    fixes = recommendations(causes, weakest)

    audit = {
        "summary": {
            "generated_at": utc_now(),
            "evaluated": len(rows),
            "decided": decided,
            "wins": wins,
            "losses": lost,
            "pushes": pushes,
            "no_bets": no_bets,
            "accuracy": _pct(wins, decided),
            "average_brier": _avg(briers),
            "average_clv": _avg(clvs),
            "lessons": len(lessons),
            "language_losses": len(losses),
            "language_gradients": len(gradients),
            "candidates": len({str(candidate.get("candidate_id") or candidate) for candidate in candidates}),
            "approved": len(approved),
            "rejected": len(rejected),
        },
        "weakest_segments": weakest,
        "strongest_segments": strongest,
        "root_causes": causes[:10],
        "priority_recommendations": fixes,
        "candidate_priorities": priorities,
        "risk_warnings": _risk_warnings(causes, weakest),
        "segment_performance": segments[:30],
        "safety": "Audit only. It does not auto-promote candidates or change production behavior.",
    }
    if persist:
        append_jsonl("audit_reports", audit)
    return audit


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Evolution audit diagnostics.")
    parser.add_argument("--summary", action="store_true", help="Print audit summary JSON.")
    parser.add_argument("--min-segment-sample", type=int, default=3)
    parser.add_argument("--candidate-limit", type=int, default=10)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.summary:
        print("Nothing to do. Use --summary.")
        return
    print(
        json.dumps(
            build_evolution_audit(
                min_segment_sample=max(1, args.min_segment_sample),
                candidate_limit=max(1, args.candidate_limit),
                persist=True,
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
