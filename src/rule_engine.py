"""Declarative rule evaluator for the moneyline confidence engine (Python side).

The rule catalog lives in data/rules/moneyline_rules.json -- the single source
of truth shared with the JavaScript evaluator (src/rule_engine.js). This module
owns ONLY the per-language predicate logic (the ``handler`` functions); every
threshold, message, ordering, engine-scope and tier lives in the JSON.

Behavior contract: evaluate_moneyline() must reproduce the exact reason and
adjustment strings, the running-confidence mutations, and the ordering that the
old inline middle block of apply_confidence_downgrade() produced in
src/quality_control.py. Rules fire in ascending ``order`` (which mirrors the
original source line sequence); ``tier`` is descriptive metadata only and does
NOT affect ordering.

Numeric formatting stays in the handlers because JS (.toFixed) and Python
(:.0f) format differently, so it cannot live in the shared JSON.
"""

from __future__ import annotations

import functools
import json
import os
from typing import Any, Callable

from .utils import data_path

# Confidence ladder + helpers are duplicated here (rather than imported from
# quality_control) so the engine has no import cycle back into its host. They
# must stay byte-identical with quality_control._CONFIDENCE_LEVELS etc.
_CONFIDENCE_LEVELS = ("Low", "Medium", "High")


def _rules_path():
    override = os.environ.get("MLB_RULES_FILE")
    if override:
        from pathlib import Path

        return Path(override)
    return data_path("rules/moneyline_rules.json")


@functools.lru_cache(maxsize=1)
def _load_rules_cached(path_str: str) -> dict[str, Any]:
    with open(path_str, "r", encoding="utf-8") as handle:
        return json.load(handle)


def load_moneyline_rules() -> dict[str, Any]:
    """Return the parsed rule catalog (cached per resolved path)."""
    return _load_rules_cached(str(_rules_path()))


def _reset_rules_cache() -> None:
    """Test-only: drop the cache so a different MLB_RULES_FILE can be loaded."""
    _load_rules_cached.cache_clear()


def _normalize_confidence(value: Any) -> str:
    text = str(value or "Low").strip().title()
    return text if text in _CONFIDENCE_LEVELS else "Low"


def _cap_confidence(confidence: str, cap: str) -> str:
    current_index = _CONFIDENCE_LEVELS.index(_normalize_confidence(confidence))
    cap_index = _CONFIDENCE_LEVELS.index(_normalize_confidence(cap))
    return _CONFIDENCE_LEVELS[min(current_index, cap_index)]


def _downgrade(confidence: str) -> str:
    index = _CONFIDENCE_LEVELS.index(_normalize_confidence(confidence))
    return _CONFIDENCE_LEVELS[max(0, index - 1)]


# ---------------------------------------------------------------------------
# Handlers. Each mirrors one check from the original middle block of
# apply_confidence_downgrade() (src/quality_control.py:394-466). A handler
# receives (state, ctx, params) and mutates ``state`` in place:
#   state["no_bet"]      -> bool
#   state["confidence"]  -> str (running confidence, threaded across CAP/ADJUST)
#   state["reasons"]     -> list[str] (NO_BET reason strings)
#   state["adjustments"] -> list[str] (downgrade/cap adjustment strings)
# ctx carries the resolved inputs the host computed (quality_report fields,
# edge, market_type, edge threshold, sharp adjustment classification).
# ---------------------------------------------------------------------------

MISSING = "Missing"
PROJECTED = "Projected"
STALE = "Stale"


def _format_edge_threshold(value: float) -> str:
    return f"{value * 100:.0f}%"


def _probable_pitcher_missing(state, ctx, params, rule) -> None:
    if ctx.get("probable_pitchers") == MISSING:
        state["no_bet"] = True
        state["reasons"].append(rule["message"])


def _opener_consideration(state, ctx, params, rule) -> None:
    if "opener_situation" in (ctx.get("no_bet_considerations") or []):
        state["adjustments"].append(rule["message"])


def _edge_unavailable(state, ctx, params, rule) -> None:
    if ctx.get("edge_value") is None:
        state["no_bet"] = True
        state["reasons"].append(rule["message"])


def _yrfi_edge_floor(state, ctx, params, rule) -> None:
    edge_value = ctx.get("edge_value")
    threshold = params.get("threshold", 0.06)
    if edge_value is not None and ctx.get("market_type") == "yrfi" and abs(edge_value) < threshold:
        state["no_bet"] = True
        state["reasons"].append(rule["message"])


def _edge_floor(state, ctx, params, rule) -> None:
    edge_value = ctx.get("edge_value")
    threshold = ctx.get("edge_threshold")
    if (
        edge_value is not None
        and ctx.get("market_type") != "yrfi"
        and abs(edge_value) < threshold
    ):
        state["no_bet"] = True
        state["reasons"].append(
            rule["message"].format(threshold_pct=_format_edge_threshold(threshold))
        )


def _data_quality_floor(state, ctx, params, rule) -> None:
    if int(ctx.get("score", 0)) < params.get("min_score", 60):
        state["no_bet"] = True
        state["reasons"].append(rule["message"])


def _sharp_downgrade(state, ctx, params, rule) -> None:
    sharp_adj = ctx.get("sharp_adj", "no_change")
    if sharp_adj == "downgrade_two":
        state["confidence"] = _downgrade(_downgrade(state["confidence"]))
        state["adjustments"].append(
            "sharp money strongly against pick: confidence downgraded x2"
        )
    elif sharp_adj == "downgrade_one":
        state["confidence"] = _downgrade(state["confidence"])
        state["adjustments"].append("sharp money against pick: confidence downgraded")


def _odds_stale_downgrade(state, ctx, params, rule) -> None:
    if ctx.get("odds") == STALE:
        state["confidence"] = _downgrade(state["confidence"])
        state["adjustments"].append(rule["message"])


def _weather_stale_downgrade(state, ctx, params, rule) -> None:
    if ctx.get("weather") == STALE and ctx.get("weather_outdoor"):
        state["confidence"] = _downgrade(state["confidence"])
        state["adjustments"].append(rule["message"])


def _lineup_cap(state, ctx, params, rule) -> None:
    if ctx.get("lineup") in {PROJECTED, MISSING}:
        new_confidence = _cap_confidence(state["confidence"], rule["cap"])
        if new_confidence != state["confidence"]:
            state["adjustments"].append(rule["message"])
        state["confidence"] = new_confidence


def _pitcher_projected_cap(state, ctx, params, rule) -> None:
    if ctx.get("probable_pitchers") == PROJECTED:
        new_confidence = _cap_confidence(state["confidence"], rule["cap"])
        if new_confidence != state["confidence"]:
            state["adjustments"].append(rule["message"])
        state["confidence"] = new_confidence


def _score_band_cap(state, ctx, params, rule) -> None:
    score = int(ctx.get("score", 0))
    for band in params.get("bands", []):
        if band["min"] <= score < band["max"]:
            if band.get("requires_calibration"):
                # 85+ band: only fires for High confidence lacking calibration
                # support, and unconditionally sets (not caps) to the band cap.
                if state["confidence"] == "High" and not ctx.get(
                    "calibration_supports_high"
                ):
                    state["confidence"] = band["cap"]
                    state["adjustments"].append(band["message"])
            else:
                new_confidence = _cap_confidence(state["confidence"], band["cap"])
                if new_confidence != state["confidence"]:
                    state["adjustments"].append(band["message"])
                state["confidence"] = new_confidence
            # elif chain: at most one band applies (ranges are disjoint).
            return


PY_HANDLERS: dict[str, Callable[..., None]] = {
    "probablePitcherMissing": _probable_pitcher_missing,
    "openerConsideration": _opener_consideration,
    "edgeUnavailable": _edge_unavailable,
    "yrfiEdgeFloor": _yrfi_edge_floor,
    "edgeFloor": _edge_floor,
    "dataQualityFloor": _data_quality_floor,
    "sharpDowngrade": _sharp_downgrade,
    "oddsStaleDowngrade": _odds_stale_downgrade,
    "weatherStaleDowngrade": _weather_stale_downgrade,
    "lineupCap": _lineup_cap,
    "pitcherProjectedCap": _pitcher_projected_cap,
    "scoreBandCap": _score_band_cap,
}


def evaluate_moneyline(ctx: dict[str, Any]) -> dict[str, Any]:
    """Evaluate all py-scoped rules against ``ctx`` in ascending ``order``.

    ``ctx`` must supply: confidence, probable_pitchers, no_bet_considerations,
    edge_value, market_type, edge_threshold, score, sharp_adj, odds, weather,
    weather_outdoor, lineup, calibration_supports_high.

    Returns {no_bet, reasons, adjustments, confidence}. The running confidence
    is threaded across CAP/ADJUST handlers so they compound in source order,
    exactly as the old inline middle block did.
    """
    rules = sorted(
        (rule for rule in load_moneyline_rules()["rules"] if "py" in rule["engines"]),
        key=lambda rule: rule["order"],
    )

    state: dict[str, Any] = {
        "no_bet": False,
        "confidence": _normalize_confidence(ctx.get("confidence")),
        "reasons": [],
        "adjustments": [],
    }

    for rule in rules:
        handler = PY_HANDLERS.get(rule["handler"])
        if handler is None:
            raise ValueError(
                f"No Python handler registered for rule {rule['id']} "
                f"(handler: {rule['handler']})"
            )
        handler(state, ctx, rule.get("params") or {}, rule)

    return state
