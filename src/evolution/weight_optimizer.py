"""Small-step, non-production weight optimizer."""

from __future__ import annotations

import hashlib
from typing import Any

from ..utils import safe_float, safe_int
from .memory_store import read_json, record_evolution_event, utc_now, write_json
from .promotion_gate import run_promotion_gate

MAX_WEIGHT_DELTA = 0.05
MAX_FACTOR_WEIGHT = 0.35
MIN_SAMPLE_SIZE = 50


def _normalize(weights: dict[str, float]) -> dict[str, float]:
    total = sum(max(0.0, safe_float(value)) for value in weights.values()) or 1.0
    return {key: round(max(0.0, safe_float(value)) / total, 4) for key, value in weights.items()}


def _validate_delta(current: dict[str, float], proposed: dict[str, float]) -> str | None:
    for key, current_value in current.items():
        if abs(safe_float(proposed.get(key), current_value) - safe_float(current_value)) > MAX_WEIGHT_DELTA:
            return f"Weight change for {key} exceeds {MAX_WEIGHT_DELTA:.2f}."
    if max((safe_float(value) for value in proposed.values()), default=0.0) > MAX_FACTOR_WEIGHT:
        return f"One factor exceeds dominance cap {MAX_FACTOR_WEIGHT:.2f}."
    return None


def _version_id(payload: dict[str, Any]) -> str:
    digest = hashlib.sha1(str(payload).encode("utf-8")).hexdigest()[:8]
    return f"weights-candidate-{digest}"


def optimize_weights_safely(backtest_data: dict[str, Any]) -> dict[str, Any]:
    store = read_json("weight_versions")
    active_version = store.get("active_version", "weights-v1.0")
    active = next((item for item in store.get("versions", []) if item.get("version") == active_version), store.get("versions", [{}])[0])
    active_weights = active.get("weights", {})
    proposed_weights = backtest_data.get("proposed_weights") or {}
    market = backtest_data.get("market", "moneyline")
    current_market_weights = active_weights.get(market, {})
    proposed_market_weights = _normalize(proposed_weights.get(market, proposed_weights))
    sample_size = safe_int(backtest_data.get("sample_size"), 0)

    rejection = None
    if sample_size < MIN_SAMPLE_SIZE:
        rejection = f"Sample size {sample_size} is below minimum {MIN_SAMPLE_SIZE}."
    if not rejection:
        rejection = _validate_delta(current_market_weights, proposed_market_weights)

    candidate = {
        "version": _version_id(backtest_data),
        "date_created": utc_now(),
        "reason": backtest_data.get("reason", "Small-step candidate from backtest data."),
        "previous_version": active_version,
        "status": "rejected" if rejection else "candidate",
        "market": market,
        "weights": {**active_weights, market: proposed_market_weights},
        "backtest_result": backtest_data.get("after_metrics"),
        "rollback_supported": True,
        "production_update_allowed": False,
    }

    if not rejection:
        gate = run_promotion_gate(
            {"candidate_id": candidate["version"], "type": "weight_adjustment", "backtest_result": backtest_data},
            backtest_data.get("before_metrics", {}),
            backtest_data.get("after_metrics", {}),
            min_sample_size=MIN_SAMPLE_SIZE,
            persist=False,
        )
        if gate["status"] != "approved":
            rejection = gate["reason"]
            candidate["status"] = "rejected"
        else:
            candidate["promotion_gate"] = gate

    if rejection:
        candidate["rejection_reason"] = rejection
    store.setdefault("versions", []).append(candidate)
    write_json("weight_versions", store)
    record_evolution_event("weight_candidate_created", candidate)
    return candidate
