"""Conservative promotion gate for evolution candidates."""

from __future__ import annotations

from typing import Any

from ..utils import safe_float, safe_int
from .memory_store import read_json, record_evolution_event, utc_now, write_json

DEFAULT_MIN_SAMPLE_SIZE = 30


def _metric(metrics: dict[str, Any], *names: str, default: float = 0.0) -> float:
    for name in names:
        if name in metrics and metrics[name] not in (None, ""):
            return safe_float(metrics[name], default)
    return default


def _sample_size(candidate: dict[str, Any], after_metrics: dict[str, Any]) -> int:
    backtest = candidate.get("backtest_result") or {}
    return safe_int(
        after_metrics.get("sample_size")
        or after_metrics.get("bets")
        or backtest.get("sample_size")
        or backtest.get("bets")
        or candidate.get("sample_size"),
        0,
    )


def _unsafe_change(candidate: dict[str, Any]) -> str | None:
    text = " ".join(str(candidate.get(key) or "") for key in ["type", "rule", "update", "reason"]).lower()
    if any(token in text for token in ["remove no bet", "disable no bet", "bypass no bet", "ignore no bet"]):
        return "Change attempts to remove NO BET protections."
    if "increase high confidence" in text and "calibration" not in text:
        return "Change increases high-confidence picks without calibration evidence."
    if candidate.get("removes_safety_rule"):
        return "Change removes a safety rule."
    return None


def _store_decision(candidate: dict[str, Any], result: dict[str, Any]) -> None:
    file_key = "approved_rules" if result["status"] == "approved" else "rejected_rules"
    payload = read_json(file_key)
    bucket = "approved" if result["status"] == "approved" else "rejected"
    if result["status"] == "approved":
        previous = str(payload.get("active_rule_version") or "rules-v1.0")
        try:
            prefix, version = previous.rsplit("v", 1)
            major, minor = version.split(".", 1)
            payload["active_rule_version"] = f"{prefix}v{int(major)}.{int(minor) + 1}"
        except ValueError:
            payload["active_rule_version"] = f"{previous}-approved"
        result["rule_version"] = payload["active_rule_version"]

    payload.setdefault(bucket, []).append(
        {
            "candidate": candidate,
            "decision": result,
            "date": utc_now(),
            "rollback_supported": True,
        }
    )
    write_json(file_key, payload)
    record_evolution_event("promotion_gate", result)


def run_promotion_gate(
    candidate: dict[str, Any],
    before_metrics: dict[str, Any],
    after_metrics: dict[str, Any],
    *,
    min_sample_size: int = DEFAULT_MIN_SAMPLE_SIZE,
    persist: bool = True,
) -> dict[str, Any]:
    sample_size = _sample_size(candidate, after_metrics)
    reason_parts = []
    status = "approved"

    unsafe_reason = _unsafe_change(candidate)
    if unsafe_reason:
        status = "rejected"
        reason_parts.append(unsafe_reason)
    if sample_size < min_sample_size:
        status = "rejected"
        reason_parts.append(f"Sample size {sample_size} is below minimum {min_sample_size}.")

    before_roi = _metric(before_metrics, "roi")
    after_roi = _metric(after_metrics, "roi")
    before_loss = _metric(before_metrics, "loss", "log_loss", default=1.0)
    after_loss = _metric(after_metrics, "loss", "log_loss", default=1.0)
    roi_or_loss_ok = after_roi > before_roi or after_loss < before_loss
    if not roi_or_loss_ok:
        status = "rejected"
        reason_parts.append("ROI did not improve and loss did not decrease.")

    before_brier = _metric(before_metrics, "brier_score", default=1.0)
    after_brier = _metric(after_metrics, "brier_score", default=1.0)
    if after_brier > before_brier + 0.005:
        status = "rejected"
        reason_parts.append("Brier score degraded beyond tolerance.")

    before_log_loss = _metric(before_metrics, "log_loss", default=1.0)
    after_log_loss = _metric(after_metrics, "log_loss", default=1.0)
    if after_log_loss > before_log_loss + 0.01:
        status = "rejected"
        reason_parts.append("Log loss degraded beyond tolerance.")

    before_clv = _metric(before_metrics, "average_clv", "clv", default=0.0)
    after_clv = _metric(after_metrics, "average_clv", "clv", default=0.0)
    if after_clv < before_clv - 0.01:
        status = "rejected"
        reason_parts.append("CLV degraded beyond tolerance.")

    before_drawdown = abs(_metric(before_metrics, "max_drawdown", default=0.0))
    after_drawdown = abs(_metric(after_metrics, "max_drawdown", default=0.0))
    if before_drawdown and after_drawdown > before_drawdown * 1.1:
        status = "rejected"
        reason_parts.append("Max drawdown worsened too much.")

    before_no_bet = _metric(before_metrics, "no_bet_accuracy", default=0.0)
    after_no_bet = _metric(after_metrics, "no_bet_accuracy", default=before_no_bet)
    if after_no_bet < before_no_bet - 0.02:
        status = "rejected"
        reason_parts.append("NO BET decisions degraded.")

    if candidate.get("increases_high_confidence") and after_brier >= before_brier:
        status = "rejected"
        reason_parts.append("High-confidence volume increased without better calibration.")

    result = {
        "candidate_id": candidate.get("candidate_id"),
        "status": status,
        "reason": " ".join(reason_parts) if reason_parts else "Backtest metrics passed the conservative promotion gate.",
        "before_metrics": before_metrics,
        "after_metrics": after_metrics,
        "sample_size": sample_size,
    }
    if persist:
        _store_decision(candidate, result)
    return result
