"""Aggregate audit and weakness diagnosis for the Evolution Engine."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from statistics import mean
from typing import Any

from ..utils import safe_float
from .memory_store import append_jsonl, read_json, read_jsonl, read_prediction_outcomes, record_evolution_event, utc_now, write_json


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

NON_ACTIONABLE_LOSS_TYPES = {
    "correct_pick",
    "wrong_pick",
    "good_risk_handling",
    "good_data_quality_warning",
    "good_no_bet",
}

SAFE_APPLY_MIN_SAMPLE = 5
SAFE_APPLY_MAX_WEIGHT_DELTA = 0.05
SAFE_APPLY_MIN_LOSS_RATE = 55.0

CONFIDENCE_PROBABILITY_FALLBACK = {
    "low": 54.0,
    "medium": 60.0,
    "high": 65.0,
    "model": 55.0,
}

REASON_PATTERNS = {
    "starting_pitcher": ("sp", "starter", "pitcher", "era", "whip", "k-bb", "hr/9"),
    "offense": ("offense", "ops", "iso", "r/g", "run creation", "bat", "hitter"),
    "bullpen": ("bullpen", "reliever", "late-game", "back-to-back", "fatigue"),
    "lineup": ("lineup", "confirmed", "projected", "batting order"),
    "injury": ("injury", "injured", "il ", "availability", "absent"),
    "market_edge": ("market", "odds", "value", "implied", "edge", "clv", "line movement"),
    "record_recent_form": ("record", "h2h", "l10", "recent", "streak", "form", "series"),
    "weather": ("weather", "wind", "temperature", "roof"),
    "park_factor": ("park", "venue", "ballpark"),
    "data_quality": ("quality", "missing", "stale", "unavailable"),
    "opener_bulk": ("opener", "bulk", "piggyback"),
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


def _is_decided(row: dict[str, Any]) -> bool:
    return row.get("result") in {"win", "loss"}


def _predicted_probability(row: dict[str, Any]) -> float | None:
    for key in ["predicted_probability", "model_probability", "moneyline_probability", "probability"]:
        if row.get(key) not in (None, ""):
            parsed = safe_float(row.get(key), 0.0)
            if parsed > 0:
                return parsed * 100.0 if parsed <= 1 else parsed

    value_pick = _parse_json(row.get("value_pick"), row.get("value_pick") or {})
    if isinstance(value_pick, dict) and value_pick.get("modelProbability") not in (None, ""):
        return safe_float(value_pick.get("modelProbability"), 0.0)

    confidence = str(row.get("confidence") or "").lower()
    fallback = CONFIDENCE_PROBABILITY_FALLBACK.get(confidence)
    return fallback


def _probability_bucket(probability: float | None) -> str:
    if probability is None or probability <= 0:
        return "probability:unknown"
    if probability < 55:
        return "probability:50-55"
    if probability < 60:
        return "probability:55-60"
    if probability < 65:
        return "probability:60-65"
    if probability < 70:
        return "probability:65-70"
    return "probability:70+"


def _classify_reason(text: Any) -> str | None:
    normalized = str(text or "").lower()
    if not normalized:
        return None
    for label, tokens in REASON_PATTERNS.items():
        if any(token in normalized for token in tokens):
            return label
    return "other"


def _reason_tags(row: dict[str, Any]) -> list[str]:
    explicit = row.get("reason_tags")
    if isinstance(explicit, list):
        return [str(item) for item in explicit if item]
    if isinstance(explicit, str) and explicit.strip():
        parsed = _parse_json(explicit, [])
        if isinstance(parsed, list):
            return [str(item) for item in parsed if item]
        return [item.strip() for item in explicit.split(",") if item.strip()]

    factors = row.get("main_factors") or row.get("reasons") or []
    if isinstance(factors, str):
        factors = _parse_json(factors, [factors])
    if not isinstance(factors, list):
        factors = []
    tags = [_classify_reason(item) for item in factors]
    return sorted({tag for tag in tags if tag})


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
        _probability_bucket(_predicted_probability(row)),
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


def calibration_buckets(rows: list[dict[str, Any]], min_sample: int = 1) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if not _is_decided(row):
            continue
        grouped[_probability_bucket(_predicted_probability(row))].append(row)

    records: list[dict[str, Any]] = []
    for bucket, items in grouped.items():
        if len(items) < min_sample:
            continue
        wins = sum(1 for row in items if row.get("result") == "win")
        losses = sum(1 for row in items if row.get("result") == "loss")
        probabilities = [value for value in (_predicted_probability(row) for row in items) if value is not None]
        avg_probability = _avg(probabilities) or 0.0
        observed = _pct(wins, wins + losses)
        error = round(observed - avg_probability, 1)
        if error <= -7.5:
            verdict = "overconfident"
        elif error >= 7.5:
            verdict = "underconfident"
        else:
            verdict = "calibrated"
        records.append(
            {
                "bucket": bucket,
                "sample_size": len(items),
                "wins": wins,
                "losses": losses,
                "avg_predicted_probability": round(avg_probability, 1),
                "observed_win_rate": observed,
                "calibration_error": error,
                "verdict": verdict,
            }
        )
    return sorted(records, key=lambda item: item["bucket"])


def clv_report(rows: list[dict[str, Any]]) -> dict[str, Any]:
    values = [safe_float(row.get("clv"), 0.0) for row in rows if row.get("clv") not in (None, "")]
    positives = sum(1 for value in values if value > 0.01)
    negatives = sum(1 for value in values if value < -0.01)
    flats = len(values) - positives - negatives
    return {
        "sample_size": len(values),
        "average_clv": _avg(values),
        "positive": positives,
        "negative": negatives,
        "flat": flats,
        "positive_rate": _pct(positives, len(values)),
        "status": "tracking" if values else "missing_closing_line_data",
        "note": "Positive CLV means the market moved toward the agent's side after the pick."
        if values
        else "No closing line data yet. Keep storing opening/pick odds and closing odds before judging market edge.",
    }


def reason_quality(rows: list[dict[str, Any]], losses: list[dict[str, Any]], min_sample: int = 1) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, int]] = defaultdict(lambda: {"wins": 0, "losses": 0, "loss_mentions": 0})
    for row in rows:
        if not _is_decided(row):
            continue
        tags = _reason_tags(row) or ["unknown"]
        for tag in tags:
            if row.get("result") == "win":
                grouped[tag]["wins"] += 1
            elif row.get("result") == "loss":
                grouped[tag]["losses"] += 1

    for loss in losses:
        tag = _classify_reason(loss.get("affected_factor") or loss.get("loss_type"))
        if tag:
            grouped[tag]["loss_mentions"] += 1

    records: list[dict[str, Any]] = []
    for factor, counts in grouped.items():
        sample = counts["wins"] + counts["losses"]
        if sample < min_sample and counts["loss_mentions"] == 0:
            continue
        accuracy = _pct(counts["wins"], sample)
        if sample and accuracy < 45:
            verdict = "weak_signal"
        elif sample and accuracy >= 58:
            verdict = "useful_signal"
        elif counts["loss_mentions"] >= 3:
            verdict = "needs_review"
        else:
            verdict = "neutral"
        records.append(
            {
                "factor": factor,
                "sample_size": sample,
                "wins": counts["wins"],
                "losses": counts["losses"],
                "accuracy": accuracy,
                "loss_mentions": counts["loss_mentions"],
                "verdict": verdict,
            }
        )
    return sorted(records, key=lambda item: (item["verdict"] == "weak_signal", item["loss_mentions"], item["losses"]), reverse=True)


def confidence_cap_candidates(rows: list[dict[str, Any]], calibration: list[dict[str, Any]], segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for bucket in calibration:
        if bucket.get("sample_size", 0) < 3 or bucket.get("verdict") != "overconfident":
            continue
        candidates.append(
            {
                "candidate_id": f"audit-confidence-cap-{bucket['bucket'].replace(':', '-').replace('+', 'plus')}",
                "type": "confidence_cap",
                "target": bucket["bucket"],
                "update": f"Cap confidence one level lower for {bucket['bucket']} until calibration improves.",
                "reason": f"Observed win rate {bucket['observed_win_rate']}% vs avg predicted {bucket['avg_predicted_probability']}%.",
                "required_backtest": True,
                "status": "audit_candidate_only",
            }
        )

    for segment in segments:
        label = str(segment.get("segment") or "")
        if not label.startswith("confidence:") or segment.get("decided", 0) < 3 or segment.get("loss_rate", 0) < 55:
            continue
        confidence = label.split(":", 1)[1]
        candidates.append(
            {
                "candidate_id": f"audit-confidence-cap-{confidence}",
                "type": "confidence_cap",
                "target": label,
                "update": f"Cap {confidence} confidence picks when Tier 1 signals do not agree.",
                "reason": f"{segment.get('wins')}-{segment.get('losses')} with {segment.get('loss_rate')}% loss rate.",
                "required_backtest": True,
                "status": "audit_candidate_only",
            }
        )

    unique: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        unique[str(candidate["candidate_id"])] = candidate
    return list(unique.values())[:8]


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
        if key in NON_ACTIONABLE_LOSS_TYPES:
            continue
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
        if key in NON_ACTIONABLE_LOSS_TYPES:
            continue
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


def _next_minor_version(current: str, default_prefix: str) -> str:
    match = re.match(r"(.+v)(\d+)\.(\d+)$", str(current or ""))
    if not match:
        return f"{default_prefix}v1.1"
    prefix, major, minor = match.groups()
    return f"{prefix}{int(major)}.{int(minor) + 1}"


def _rule_candidate_from_entry(entry: dict[str, Any]) -> dict[str, Any]:
    if isinstance(entry.get("candidate"), dict):
        return entry["candidate"]
    return entry


def _active_rule_keys(payload: dict[str, Any]) -> set[str]:
    keys: set[str] = set()
    for entry in [*payload.get("active_controls", []), *payload.get("approved", [])]:
        if not isinstance(entry, dict):
            continue
        candidate = _rule_candidate_from_entry(entry)
        key = candidate.get("rule_key") or candidate.get("candidate_id")
        if key:
            keys.add(str(key))
    return keys


def _safe_rule_candidates_from_audit(audit: dict[str, Any]) -> list[dict[str, Any]]:
    generated_at = audit.get("summary", {}).get("generated_at") or utc_now()
    candidates: list[dict[str, Any]] = []

    weak_edge = next((item for item in audit.get("weakest_segments", []) if item.get("segment") == "edge:weak <2"), None)
    if (
        weak_edge
        and weak_edge.get("decided", 0) >= SAFE_APPLY_MIN_SAMPLE
        and safe_float(weak_edge.get("loss_rate"), 0.0) >= SAFE_APPLY_MIN_LOSS_RATE
    ):
        candidates.append(
            {
                "candidate_id": "audit-safe-no-bet-weak-edge",
                "rule_key": "audit:no_bet:weak_edge",
                "type": "no_bet_rule",
                "target": "moneyline",
                "rule": "Return NO BET when moneyline value/model edge is weak and no stronger Tier 1 signal confirms the side.",
                "parameters": {
                    "max_value_edge": 2.0,
                    "max_probability_edge": 5.0,
                    "max_matchup_edge": 0.08,
                },
                "reason": f"Audit found edge:weak <2 at {weak_edge.get('wins')}-{weak_edge.get('losses')} with {weak_edge.get('loss_rate')}% loss rate.",
                "evidence": weak_edge,
                "status": "active",
                "promotion_status": "approved_conservative_guardrail",
                "backtest_status": "audit_min_sample_gate",
                "source": "evolution_audit",
                "date_created": generated_at,
                "rollback_supported": True,
                "production_update_allowed": True,
            }
        )

    record_bias = next((item for item in audit.get("root_causes", []) if item.get("loss_type") == "record_bias"), None)
    if record_bias and record_bias.get("count", 0) >= 2:
        candidates.append(
            {
                "candidate_id": "audit-safe-confidence-cap-record-bias",
                "rule_key": "audit:confidence_cap:record_bias",
                "type": "confidence_cap",
                "target": "moneyline",
                "rule": "Cap to LEAN ONLY/NO BET when record, H2H, or recent form dominates weak game-specific matchup edge.",
                "parameters": {
                    "record_context_multiplier": 1.25,
                    "max_matchup_edge": 0.18,
                },
                "reason": f"Audit found record_bias {record_bias.get('count')} times.",
                "evidence": record_bias,
                "status": "active",
                "promotion_status": "approved_conservative_guardrail",
                "backtest_status": "audit_repeated_pattern_gate",
                "source": "evolution_audit",
                "date_created": generated_at,
                "rollback_supported": True,
                "production_update_allowed": True,
            }
        )

    for bucket in audit.get("calibration_buckets", []):
        if bucket.get("verdict") != "overconfident" or bucket.get("sample_size", 0) < SAFE_APPLY_MIN_SAMPLE:
            continue
        bucket_id = str(bucket.get("bucket") or "unknown").replace(":", "-").replace("+", "plus")
        candidates.append(
            {
                "candidate_id": f"audit-safe-confidence-cap-{bucket_id}",
                "rule_key": f"audit:confidence_cap:{bucket_id}",
                "type": "confidence_cap",
                "target": bucket.get("bucket"),
                "rule": f"Cap confidence one level lower for {bucket.get('bucket')} until calibration improves.",
                "parameters": {
                    "probability_bucket": bucket.get("bucket"),
                    "cap_one_level": True,
                },
                "reason": f"Observed win rate {bucket.get('observed_win_rate')}% vs predicted {bucket.get('avg_predicted_probability')}%.",
                "evidence": bucket,
                "status": "active",
                "promotion_status": "approved_conservative_guardrail",
                "backtest_status": "audit_calibration_gate",
                "source": "evolution_audit",
                "date_created": generated_at,
                "rollback_supported": True,
                "production_update_allowed": True,
            }
        )

    return candidates


def _apply_safe_rule_candidates(audit: dict[str, Any]) -> list[dict[str, Any]]:
    payload = read_json("approved_rules")
    existing = _active_rule_keys(payload)
    new_rules = [candidate for candidate in _safe_rule_candidates_from_audit(audit) if candidate.get("rule_key") not in existing]
    if not new_rules:
        return []

    next_version = _next_minor_version(str(payload.get("active_rule_version") or "rules-v1.0"), "rules-")
    payload["active_rule_version"] = next_version
    payload.setdefault("rollback_supported", True)
    payload.setdefault("approved", [])
    active_controls = [_rule_candidate_from_entry(entry) for entry in payload.get("active_controls", []) if isinstance(entry, dict)]

    for rule in new_rules:
        rule["rule_version"] = next_version
        decision = {
            "candidate_id": rule.get("candidate_id"),
            "status": "approved",
            "reason": "Conservative audit guardrail only reduces risk; it does not increase confidence.",
            "sample_size": rule.get("evidence", {}).get("decided") or rule.get("evidence", {}).get("sample_size") or rule.get("evidence", {}).get("count") or 0,
            "rule_version": next_version,
        }
        payload["approved"].append(
            {
                "candidate": rule,
                "decision": decision,
                "date": utc_now(),
                "rollback_supported": True,
            }
        )
        active_controls.append(rule)
        record_evolution_event("audit_safe_rule_applied", {"rule": rule, "decision": decision})

    deduped: dict[str, dict[str, Any]] = {}
    for rule in active_controls:
        key = str(rule.get("rule_key") or rule.get("candidate_id") or rule)
        deduped[key] = rule
    payload["active_controls"] = list(deduped.values())
    write_json("approved_rules", payload)
    return new_rules


def _normalize_weights(weights: dict[str, Any]) -> dict[str, float]:
    total = sum(max(0.0, safe_float(value, 0.0)) for value in weights.values()) or 1.0
    return {key: round(max(0.0, safe_float(value, 0.0)) / total, 4) for key, value in weights.items()}


def _active_weight_version(store: dict[str, Any]) -> dict[str, Any]:
    active_version = store.get("active_version")
    versions = store.get("versions", [])
    return next((item for item in versions if item.get("version") == active_version), versions[0] if versions else {})


def _apply_safe_weight_update(audit: dict[str, Any]) -> list[dict[str, Any]]:
    pitcher_reason = next((item for item in audit.get("reason_quality", []) if item.get("factor") == "starting_pitcher"), None)
    if not pitcher_reason:
        return []

    enough_evidence = pitcher_reason.get("loss_mentions", 0) >= 10 or (
        pitcher_reason.get("sample_size", 0) >= SAFE_APPLY_MIN_SAMPLE and safe_float(pitcher_reason.get("accuracy"), 100.0) < 45.0
    )
    if pitcher_reason.get("verdict") not in {"weak_signal", "needs_review"} or not enough_evidence:
        return []

    store = read_json("weight_versions")
    active = _active_weight_version(store)
    previous_keys = set(active.get("audit_adjustment_keys") or [])
    adjustment_key = "audit:weight:starting_pitcher:needs_review"
    if adjustment_key in previous_keys:
        return []

    active_weights = active.get("weights", {})
    moneyline = dict(active_weights.get("moneyline", {}))
    current_sp = safe_float(moneyline.get("starting_pitcher"), 0.0)
    if current_sp <= SAFE_APPLY_MAX_WEIGHT_DELTA:
        return []

    delta = min(SAFE_APPLY_MAX_WEIGHT_DELTA, current_sp)
    moneyline["starting_pitcher"] = round(current_sp - delta, 4)
    moneyline["offense"] = round(safe_float(moneyline.get("offense"), 0.0) + delta * 0.4, 4)
    moneyline["bullpen"] = round(safe_float(moneyline.get("bullpen"), 0.0) + delta * 0.2, 4)
    moneyline["data_quality"] = round(safe_float(moneyline.get("data_quality"), 0.0) + delta * 0.4, 4)
    moneyline = _normalize_weights(moneyline)

    if max(moneyline.values(), default=0.0) > 0.35:
        return []

    previous_version = str(store.get("active_version") or active.get("version") or "weights-v1.0")
    next_version = _next_minor_version(previous_version, "weights-")
    for version in store.get("versions", []):
        if version.get("status") == "active":
            version["status"] = "archived"

    new_version = {
        "version": next_version,
        "date_created": audit.get("summary", {}).get("generated_at") or utc_now(),
        "reason": "Audit found repeated starting-pitcher signal misses; reduce SP weight by a conservative 5 percentage points.",
        "previous_version": previous_version,
        "status": "active",
        "weights": {**active_weights, "moneyline": moneyline},
        "audit_adjustment_keys": sorted([*previous_keys, adjustment_key]),
        "source_reason_quality": pitcher_reason,
        "rollback_supported": True,
        "production_update_allowed": True,
        "promotion_status": "approved_conservative_weight_reduction",
        "backtest_status": "audit_min_sample_gate",
    }
    store["active_version"] = next_version
    store.setdefault("versions", []).append(new_version)
    write_json("weight_versions", store)
    record_evolution_event("audit_safe_weight_applied", new_version)
    return [new_version]


def apply_safe_audit_updates(audit: dict[str, Any]) -> dict[str, Any]:
    """Apply only conservative, versioned guardrails derived from audit evidence."""

    applied_rules = _apply_safe_rule_candidates(audit)
    applied_weights = _apply_safe_weight_update(audit)
    result = {
        "rules_added": [
            {
                "candidate_id": rule.get("candidate_id"),
                "type": rule.get("type"),
                "rule": rule.get("rule"),
                "rule_version": rule.get("rule_version"),
                "reason": rule.get("reason"),
            }
            for rule in applied_rules
        ],
        "weight_versions_added": [
            {
                "version": version.get("version"),
                "previous_version": version.get("previous_version"),
                "reason": version.get("reason"),
                "moneyline_weights": version.get("weights", {}).get("moneyline", {}),
            }
            for version in applied_weights
        ],
        "note": "Only conservative risk-reducing updates were eligible. No confidence-increasing or safety-removing change is applied.",
    }
    record_evolution_event("audit_safe_apply_summary", result)
    return result


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
    apply_safe: bool = False,
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
    calibration = calibration_buckets(rows)
    clv = clv_report(rows)
    reasons = reason_quality(rows, losses)
    cap_candidates = confidence_cap_candidates(rows, calibration, segments)

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
        "calibration_buckets": calibration,
        "clv_report": clv,
        "reason_quality": reasons,
        "confidence_cap_candidates": cap_candidates,
        "risk_warnings": _risk_warnings(causes, weakest),
        "segment_performance": segments[:30],
        "applied_updates": None,
        "safety": "Audit can apply only conservative, versioned risk guardrails when --apply-safe is used. It never increases confidence or removes NO BET protections.",
    }
    if apply_safe:
        audit["applied_updates"] = apply_safe_audit_updates(audit)
    if persist:
        append_jsonl("audit_reports", audit)
    return audit


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Evolution audit diagnostics.")
    parser.add_argument("--summary", action="store_true", help="Print audit summary JSON.")
    parser.add_argument("--min-segment-sample", type=int, default=3)
    parser.add_argument("--candidate-limit", type=int, default=10)
    parser.add_argument("--apply-safe", action="store_true", help="Apply conservative versioned guardrails derived from audit evidence.")
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
                apply_safe=args.apply_safe,
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
