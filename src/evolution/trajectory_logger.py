"""Pre-game prediction trajectory logging."""

from __future__ import annotations

import argparse
import json
from typing import Any

from ..utils import safe_float
from .memory_store import append_jsonl, current_versions, utc_now

POSTGAME_KEYS = {
    "actual_home_score",
    "actual_away_score",
    "actual_score",
    "actual_total",
    "actual_total_runs",
    "actual_result",
    "away_score",
    "final_result",
    "final_score",
    "home_score",
    "profit_loss",
    "result",
    "won",
}


def strip_postgame_fields(value: Any) -> Any:
    if isinstance(value, dict):
        cleaned = {}
        for key, item in value.items():
            if str(key).lower() in POSTGAME_KEYS:
                continue
            cleaned[key] = strip_postgame_fields(item)
        return cleaned
    if isinstance(value, list):
        return [strip_postgame_fields(item) for item in value]
    return value


def _nested(source: dict[str, Any], *keys: str, default: Any = None) -> Any:
    current: Any = source
    for key in keys:
        if not isinstance(current, dict):
            return default
        current = current.get(key)
    return current if current not in (None, "") else default


def _infer_market(context: dict[str, Any], prediction: dict[str, Any]) -> str:
    explicit = context.get("market") or prediction.get("market")
    if explicit:
        return str(explicit).lower()
    lean = str(prediction.get("final_lean") or prediction.get("lean") or "")
    return "totals" if lean.lower().startswith(("over", "under")) else "moneyline"


def _infer_tools(context: dict[str, Any]) -> list[str]:
    tools = list(context.get("tool_usage") or context.get("tool_calls_used") or [])
    if tools:
        return tools
    tools = ["get_today_games", "generate_quality_report"]
    if context.get("probable_pitchers") or context.get("probable_pitcher_status"):
        tools.append("get_probable_pitchers")
    if context.get("totals") or "total" in str(context.get("final_lean") or "").lower():
        tools.append("predict_total_runs")
    if context.get("moneyline"):
        tools.append("predict_moneyline")
    return tools


def build_prediction_trajectory(game_context: dict[str, Any], prediction_output: dict[str, Any] | None = None) -> dict[str, Any]:
    context = strip_postgame_fields(dict(game_context or {}))
    prediction_source = strip_postgame_fields(dict(prediction_output or game_context or {}))
    versions = current_versions()
    game_id = context.get("game_id") or context.get("id")
    if not game_id:
        game_id = f"{context.get('date', 'unknown')}-{context.get('away_team', 'away')}-{context.get('home_team', 'home')}"

    data_quality = context.get("data_quality") or {}
    totals = prediction_source.get("totals") or context.get("totals") or {}
    moneyline = prediction_source.get("moneyline") or context.get("moneyline") or {}
    market = _infer_market(context, prediction_source)
    final_lean = prediction_source.get("final_lean") or totals.get("lean") or prediction_source.get("lean") or "NO BET"
    confidence = (
        prediction_source.get("confidence")
        or moneyline.get("confidence")
        or totals.get("confidence")
        or "Low"
    )

    record = {
        "game_id": str(game_id),
        "date": context.get("date"),
        "market": market,
        "matchup": context.get("matchup") or f"{context.get('away_team')} @ {context.get('home_team')}",
        "home_team": context.get("home_team"),
        "away_team": context.get("away_team"),
        "game_time": context.get("game_time") or context.get("start"),
        "venue": context.get("venue") or context.get("ballpark"),
        "input_snapshot": {
            "probable_pitchers": context.get("probable_pitcher_status") or _nested(context, "probable_pitchers", "status"),
            "lineup_status": context.get("lineup_status") or data_quality.get("lineup"),
            "weather_status": context.get("weather_status") or data_quality.get("weather"),
            "odds_status": context.get("odds_status") or data_quality.get("odds"),
            "bullpen_status": context.get("bullpen_status") or data_quality.get("bullpen_usage"),
            "park_factor_status": context.get("park_factor_status") or data_quality.get("park_factor"),
            "data_quality": safe_float(data_quality.get("score"), safe_float(context.get("data_quality_score"), 0.0)),
        },
        "input_data_snapshot": context,
        "tool_usage": _infer_tools(context),
        "model_features_used": context.get("model_features_used") or [],
        "prediction": {
            "moneyline_probability": moneyline.get("model_probability") or moneyline.get("home_probability"),
            "projected_total": totals.get("projected_total"),
            "projected_total_runs": totals.get("projected_total") or prediction_source.get("projected_total_runs"),
            "market_total": totals.get("market_total"),
            "over_probability": totals.get("over_probability"),
            "under_probability": totals.get("under_probability"),
            "market_odds": moneyline.get("current_odds") or {"over": totals.get("over_odds"), "under": totals.get("under_odds")},
            "model_edge": moneyline.get("edge") if market == "moneyline" else totals.get("edge"),
            "lean": final_lean,
            "final_lean": final_lean,
            "confidence": confidence,
        },
        "main_factors": prediction_source.get("main_factors") or context.get("main_factors") or [],
        "risk_factors": prediction_source.get("risk_factors") or context.get("risk_factors") or [],
        "no_bet_reason": prediction_source.get("no_bet_reason") or context.get("no_bet_reason") or "",
        "prompt_version": context.get("prompt_version") or versions["prompt_version"],
        "rule_version": context.get("rule_version") or versions["rule_version"],
        "weight_version": context.get("weight_version") or versions["weight_version"],
        "model_version": context.get("model_version") or versions["model_version"],
        "timestamp": utc_now(),
    }
    return record


def log_prediction_trajectory(game_context: dict[str, Any], prediction_output: dict[str, Any] | None = None) -> dict[str, Any]:
    trajectory = build_prediction_trajectory(game_context, prediction_output)
    return append_jsonl("trajectories", trajectory)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Log current MLB prediction trajectories.")
    parser.add_argument("--log-today", action="store_true", help="Log today's dashboard slate trajectories.")
    parser.add_argument("--source", default="live", choices=["live", "sample", "mock"], help="Dashboard source to log.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.log_today:
        print("Nothing to do. Use --log-today.")
        return
    from ..dashboard_service import get_today_dashboard

    payload = get_today_dashboard(source=args.source)
    records = [log_prediction_trajectory(game, game) for game in payload.get("games", [])]
    print(json.dumps({"logged": len(records)}, indent=2))


if __name__ == "__main__":
    main()
