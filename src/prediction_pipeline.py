"""Clear modular MLB prediction pipeline.

Pipeline order:
1. Data collection
2. Feature engineering
2b. Dynamic weights + player contribution (NEW)
3. Prediction (uses dynamic weights)
4. Market comparison
5. Quality control
6. Explanation
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .data_collection import collect_game_data
from .dynamic_weights import calculate_dynamic_weights
from .explanation_layer import build_prediction_explanation
from .feature_engineering_layer import build_game_features
from .market_comparison import compare_markets
from .player_contribution import calculate_team_player_score
from .prediction_layer import build_predictions
from .probability_calibrator import calibrate
from .prediction_tier import (
    apply_tier_confidence_cap,
    determine_prediction_tier,
)
from .quality_control import apply_confidence_downgrade, generate_quality_report
from .risk_management import apply_risk_framework
from .utils import clamp, safe_float


def _apply_market_to_moneyline(
    prediction: dict[str, Any],
    market_comparison: dict[str, Any],
) -> dict[str, Any]:
    output = deepcopy(prediction)
    moneyline_market = market_comparison.get("moneyline", {})
    output.update(
        {
            "home_market_implied_probability": moneyline_market.get("home_market_implied_probability"),
            "away_market_implied_probability": moneyline_market.get("away_market_implied_probability"),
            "home_edge": moneyline_market.get("home_edge"),
            "away_edge": moneyline_market.get("away_edge"),
            "model_edge": moneyline_market.get("pick_edge"),
        }
    )
    return output


def _supporting_factors(moneyline: dict[str, Any], first_inning: dict[str, Any]) -> list[str]:
    factors = []
    factors.extend(moneyline.get("main_factors", []))
    factors.extend(first_inning.get("main_factors", []))
    unique: list[str] = []
    for factor in factors:
        if factor not in unique:
            unique.append(factor)
    return unique


# ---------------------------------------------------------------------------
# Bridge helpers — translate collected data into the shapes our new modules
# expect.  These functions are purely structural; they never fetch new data.
# ---------------------------------------------------------------------------

def _build_game_context(collected: dict[str, Any], features: dict[str, Any]) -> dict[str, Any]:
    """Build a game_context dict for dynamic_weights.calculate_dynamic_weights."""
    home_pitcher = collected.get("home_pitcher")
    away_pitcher = collected.get("away_pitcher")
    park = collected.get("park")
    weather = collected.get("weather")
    home_lineup = collected.get("home_lineup")
    away_lineup = collected.get("away_lineup")
    home_bullpen = collected.get("home_bullpen")
    away_bullpen = collected.get("away_bullpen")

    # SP confirmed?
    pitcher_ctx = collected.get("context", {}).get("probable_pitchers", {})
    sp_home_confirmed = pitcher_ctx.get("home") is not None
    sp_away_confirmed = pitcher_ctx.get("away") is not None

    # SP scores: reuse the pitcher feature scores already computed by
    # feature_engineering_layer if available, else approximate from ERA/FIP.
    moneyline_features = features.get("moneyline", {})
    components = moneyline_features.get("components", {})
    sp_home_score = clamp(0.5 + safe_float(components.get("starting_pitcher"), 0.0) * 0.5, 0.0, 1.0)
    sp_away_score = clamp(0.5 - safe_float(components.get("starting_pitcher"), 0.0) * 0.5, 0.0, 1.0)

    # Bullpen fatigue — classify from raw usage data
    def _bp_fatigue(bp: Any) -> str:
        if bp is None:
            return "low"
        innings_3d = safe_float(getattr(bp, "bullpen_innings_last_3_days", None), 0)
        relievers_yday = safe_float(getattr(bp, "relievers_used_yesterday", None), 0)
        back_to_back = safe_float(getattr(bp, "back_to_back_usage", None), 0)
        if innings_3d > 12 or relievers_yday > 5 or back_to_back > 2:
            return "high"
        if innings_3d > 9 or relievers_yday > 3 or back_to_back > 0:
            return "medium"
        return "low"

    # Park factor
    park_factor = safe_float(getattr(park, "run_factor", None), 1.0) if park else 1.0
    # Normalise: if stored as percentage (e.g. 105 = +5%), convert
    if park_factor > 10:
        park_factor = park_factor / 100.0

    # Wind
    weather_wind_out = False
    if weather and hasattr(weather, "wind_direction"):
        wd = str(getattr(weather, "wind_direction", "") or "").lower()
        weather_wind_out = "out" in wd

    # Lineup confirmed
    lineup_home_confirmed = home_lineup is not None and getattr(home_lineup, "confirmed", False)
    lineup_away_confirmed = away_lineup is not None and getattr(away_lineup, "confirmed", False)

    # IL count — count injured players in the lineup data
    def _il_count(lineup: Any) -> int:
        if lineup is None:
            return 0
        injured_hitters = getattr(lineup, "injured_hitters", None)
        if injured_hitters is not None:
            return int(safe_float(injured_hitters, 0))
        players = getattr(lineup, "players", None) or getattr(lineup, "batters", None) or []
        if isinstance(players, list):
            return sum(1 for p in players if isinstance(p, dict) and p.get("is_il"))
        return 0

    return {
        "sp_home_confirmed": sp_home_confirmed,
        "sp_away_confirmed": sp_away_confirmed,
        "sp_home_score": sp_home_score,
        "sp_away_score": sp_away_score,
        "bullpen_home_fatigue": _bp_fatigue(home_bullpen),
        "bullpen_away_fatigue": _bp_fatigue(away_bullpen),
        "park_factor_runs": park_factor,
        "weather_wind_out": weather_wind_out,
        "lineup_home_confirmed": lineup_home_confirmed,
        "lineup_away_confirmed": lineup_away_confirmed,
        "il_home_count": _il_count(home_lineup),
        "il_away_count": _il_count(away_lineup),
    }


def _build_player_score_inputs(
    collected: dict[str, Any],
) -> dict[str, Any]:
    """Extract player-level inputs for calculate_team_player_score."""
    home_pitcher = collected.get("home_pitcher")
    away_pitcher = collected.get("away_pitcher")
    game = collected.get("game")

    def _sp_dict(p: Any) -> dict[str, Any] | None:
        if p is None:
            return None
        return {
            "era": safe_float(getattr(p, "era", None), 4.20),
            "fip": safe_float(getattr(p, "fip", None), 4.20),
            "xfip": safe_float(getattr(p, "xfip", None), None),
            "k_per_9": safe_float(getattr(p, "k_rate", None), 8.0),
            "bb_per_9": safe_float(getattr(p, "bb_rate", None), 3.2),
            "whip": safe_float(getattr(p, "whip", None), 1.30),
            "last_5_era": safe_float(getattr(p, "recent_3_start_era", None), None),
            "innings_pitched_avg": safe_float(getattr(p, "innings_pitched_avg", None), 5.5),
            "throws": str(getattr(p, "throws", "R") or "R"),
        }

    def _lineup_list(lineup: Any) -> list[dict[str, Any]] | None:
        if lineup is None:
            return None
        players = getattr(lineup, "players", None) or getattr(lineup, "batters", None) or []
        if isinstance(players, list) and players:
            result = []
            for i, p in enumerate(players):
                if not isinstance(p, dict):
                    continue
                result.append({
                    "name": p.get("name", f"Batter {i+1}"),
                    "slot": p.get("slot", i + 1),
                    "wrc_plus": safe_float(p.get("wrc_plus"), 100.0),
                    "hand": p.get("hand", "R"),
                    "last_7_wrc": safe_float(p.get("last_7_wrc"), None),
                    "is_il": bool(p.get("is_il", False)),
                })
            return result or None

        # Sample-data fallback: LineupContext is aggregate-only, so represent
        # the top/mid/bottom thirds as pseudo-batters. This keeps the new player
        # contribution layer useful even before true player-level lineups arrive.
        top5 = safe_float(getattr(lineup, "top5_strength", None), 100.0)
        injured = int(safe_float(getattr(lineup, "injured_hitters", None), 0))
        return [
            {"name": "Top-order bats", "slot": 2, "wrc_plus": top5, "hand": "R", "last_7_wrc": None, "is_il": False},
            {"name": "Middle-order depth", "slot": 5, "wrc_plus": (top5 + 100) / 2, "hand": "R", "last_7_wrc": None, "is_il": False},
            {"name": "Lineup injuries", "slot": 7, "wrc_plus": 75 if injured > 0 else 100, "hand": "R", "last_7_wrc": None, "is_il": injured > 0},
        ]

    def _bullpen_dict(bp: Any) -> dict[str, Any] | None:
        if bp is None:
            return None
        era = safe_float(getattr(bp, "bullpen_era_last_7", None), 4.10)
        return {
            "closer_era": era + (0.40 if not getattr(bp, "closer_available", True) else 0.0),
            "setup_era": era,
            "leverage_era": era + (0.35 if not getattr(bp, "high_leverage_available", True) else 0.0),
            "save_opportunities_converted": 0.72 if getattr(bp, "closer_available", True) else 0.58,
        }

    def _fatigue_data(bp: Any) -> dict[str, Any]:
        if bp is None:
            return {"usage_last_3_days": 0}
        return {
            "usage_last_3_days": int(safe_float(getattr(bp, "relievers_used_yesterday", None), 0)
                                      + safe_float(getattr(bp, "back_to_back_usage", None), 0))
        }

    home_name = getattr(game, "home_team", "Home") if game else "Home"
    away_name = getattr(game, "away_team", "Away") if game else "Away"
    home_bullpen = collected.get("home_bullpen")
    away_bullpen = collected.get("away_bullpen")

    return {
        "home_lineup": _lineup_list(collected.get("home_lineup")),
        "away_lineup": _lineup_list(collected.get("away_lineup")),
        "home_sp": _sp_dict(home_pitcher),
        "away_sp": _sp_dict(away_pitcher),
        "home_bullpen": _bullpen_dict(home_bullpen),
        "away_bullpen": _bullpen_dict(away_bullpen),
        "game_context": {
            "home_name": home_name,
            "away_name": away_name,
            "home_fatigue_data": _fatigue_data(home_bullpen),
            "away_fatigue_data": _fatigue_data(away_bullpen),
        },
    }


def _pipeline_weight_overrides(weights: dict[str, float]) -> dict[str, float]:
    """Map public dynamic-weight keys to prediction-layer component keys."""
    return {
        "starting_pitcher": safe_float(weights.get("sp"), 0.25),
        "team_strength": safe_float(weights.get("log5"), 0.30),
        "offense": safe_float(weights.get("offense"), 0.20),
        "bullpen": safe_float(weights.get("bullpen"), 0.10),
        "recent_form": safe_float(weights.get("form"), 0.10),
        "home_field": safe_float(weights.get("home"), 0.05),
    }


def _apply_player_delta(
    moneyline: dict[str, Any],
    player_delta: float,
    home_team: str | None = None,
    away_team: str | None = None,
) -> dict[str, Any]:
    """Apply player-score delta as a small probability adjustment (max ±3%)."""
    adjustment = clamp(player_delta, -0.03, 0.03)
    output = dict(moneyline)
    output["player_delta_adjustment"] = round(adjustment, 4)
    if abs(adjustment) < 0.001:
        return output

    output["predicted_winner_pre_delta"] = output.get("predicted_winner")
    home_prob = safe_float(output.get("home_win_probability"), 0.5)
    home_prob = clamp(home_prob + adjustment, 0.05, 0.95)
    output["home_win_probability"] = home_prob
    output["away_win_probability"] = 1.0 - home_prob

    if home_prob >= 0.5 and home_team:
        output["predicted_winner"] = home_team
        output["final_lean"] = home_team
    elif home_prob < 0.5 and away_team:
        output["predicted_winner"] = away_team
        output["final_lean"] = away_team

    return output


def run_prediction_pipeline(game_id: str | int) -> dict[str, Any]:
    """Run one game through the full conservative pipeline."""
    collected = collect_game_data(game_id)
    features = build_game_features(collected)

    # --- Stage 2b: Dynamic weights & player contribution ----------------------
    game_context = _build_game_context(collected, features)
    dynamic_weights = calculate_dynamic_weights(game_context)

    player_inputs = _build_player_score_inputs(collected)
    player_scores = calculate_team_player_score(
        home_lineup=player_inputs["home_lineup"],
        away_lineup=player_inputs["away_lineup"],
        home_sp=player_inputs["home_sp"],
        away_sp=player_inputs["away_sp"],
        home_bullpen=player_inputs["home_bullpen"],
        away_bullpen=player_inputs["away_bullpen"],
        game_context=player_inputs["game_context"],
    )

    # --- Stage 3: Prediction (pass dynamic weights) ---------------------------
    raw_predictions = build_predictions(
        collected,
        features,
        weight_overrides=_pipeline_weight_overrides(dynamic_weights["weights"]),
    )
    market_comparison = compare_markets(raw_predictions, collected)
    quality_report = generate_quality_report(collected["context"])

    # Determine prediction tier based on game timing and data availability
    game = collected.get("game")
    game_start_time = getattr(game, "game_time", None) or getattr(game, "start_time", None)
    lineup_confirmed = quality_report.get("lineup") == "Confirmed"
    pitcher_confirmed = quality_report.get("probable_pitchers") == "Confirmed"
    tier = determine_prediction_tier(
        game_start_time=game_start_time,
        lineup_confirmed=lineup_confirmed,
        pitcher_confirmed=pitcher_confirmed,
    )

    moneyline_prediction = _apply_market_to_moneyline(
        raw_predictions["moneyline"],
        market_comparison,
    )

    # --- Apply player delta to moneyline before confidence downgrade ----------
    moneyline_prediction = _apply_player_delta(
        moneyline_prediction,
        player_scores["delta"],
        home_team=getattr(collected.get("game"), "home_team", None),
        away_team=getattr(collected.get("game"), "away_team", None),
    )

    moneyline = apply_confidence_downgrade(moneyline_prediction, quality_report)

    # Apply confidence modifier from dynamic weights
    conf_mod = dynamic_weights.get("confidence_modifier", 1.0)
    if conf_mod < 1.0:
        moneyline["dynamic_confidence_modifier"] = conf_mod

    first_inning_raw = deepcopy(raw_predictions["first_inning"])
    first_inning_raw["model_edge"] = abs(first_inning_raw.get("yrfi_probability", 0.5) - 0.5)
    first_inning_raw["market_type"] = "yrfi"
    first_inning = apply_confidence_downgrade(first_inning_raw, quality_report)

    # Apply tier confidence cap
    moneyline["confidence"] = apply_tier_confidence_cap(moneyline["confidence"], tier)
    first_inning["confidence"] = apply_tier_confidence_cap(first_inning["confidence"], tier)

    market = collected.get("market") or {}
    moneyline["model_probability"] = max(
        moneyline.get("home_win_probability", 0.0),
        moneyline.get("away_win_probability", 0.0),
    )
    moneyline["american_odds"] = (
        market.get("home_moneyline")
        if moneyline.get("predicted_winner") == getattr(collected["game"], "home_team", None)
        else market.get("away_moneyline")
    )
    first_inning["model_probability"] = calibrate(
        max(
            first_inning.get("yrfi_probability", 0.0),
            first_inning.get("nrfi_probability", 0.0),
        ),
        market="yrfi",
    )

    moneyline = apply_risk_framework(moneyline, quality_report)
    first_inning = apply_risk_framework(first_inning, quality_report)

    supporting_factors = _supporting_factors(moneyline, first_inning)

    result = {
        "stages": {
            "data_collection": "complete",
            "feature_engineering": "complete",
            "dynamic_weights": "complete",
            "player_contribution": "complete",
            "prediction": "complete",
            "market_comparison": "complete",
            "quality_control": "complete",
            "explanation": "complete",
        },
        "game": collected["game"],
        "context": collected["context"],
        "market": collected["market"],
        "features": features,
        "raw_predictions": raw_predictions,
        "market_comparison": market_comparison,
        "quality_report": moneyline.get("quality_report", quality_report),
        "prediction_tier": {
            "tier": tier.tier,
            "label": tier.label,
            "hours_to_game": tier.hours_to_game,
            "confidence_cap": tier.confidence_cap,
            "data_completeness": tier.data_completeness,
            "refresh_recommended": tier.refresh_recommended,
        },
        "moneyline": moneyline,
        "first_inning": first_inning,
        "supporting_factors": supporting_factors,
        # --- New outputs from dynamic weights & player contribution -----------
        "game_mode": dynamic_weights["mode"],
        "weights_used": dynamic_weights["weights"],
        "weight_adjustments": dynamic_weights["adjustments_applied"],
        "confidence_modifier": dynamic_weights["confidence_modifier"],
        "key_contributors_home": player_scores["home"]["key_contributors"],
        "key_contributors_away": player_scores["away"]["key_contributors"],
        "key_risks": (
            player_scores["home"]["key_risks"]
            + player_scores["away"]["key_risks"]
        ),
        "player_narrative": player_scores["narrative"],
        "player_scores": player_scores,
    }
    result["explanation"] = build_prediction_explanation(result)
    return result
