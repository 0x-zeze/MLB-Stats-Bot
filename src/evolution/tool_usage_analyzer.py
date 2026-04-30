"""Analyze whether prediction trajectories used the expected data tools."""

from __future__ import annotations

from typing import Any

from .memory_store import append_jsonl


def analyze_tool_usage(trajectory: dict[str, Any]) -> dict[str, Any]:
    tools = set(trajectory.get("tool_usage") or [])
    snapshot = trajectory.get("input_snapshot") or {}
    market = str(trajectory.get("market") or "").lower()
    missing_tools: list[str] = []
    unnecessary_tools: list[str] = []

    required = {"get_today_games", "generate_quality_report", "get_probable_pitchers"}
    if market == "totals":
        required.update({"predict_total_runs", "get_weather_context", "get_bullpen_usage"})
    if market == "moneyline":
        required.add("predict_moneyline")
    missing_tools.extend(sorted(required - tools))

    if market == "moneyline" and "predict_total_runs" in tools and "predict_moneyline" not in tools:
        unnecessary_tools.append("predict_total_runs")
    if str(snapshot.get("weather_status") or "").lower() in {"missing", "unavailable"} and market == "totals":
        if "get_weather_context" not in missing_tools:
            missing_tools.append("get_weather_context")
    if str(snapshot.get("odds_status") or "").lower() in {"missing", "stale", "unavailable"}:
        missing_tools.append("get_market_comparison")
    if str(snapshot.get("probable_pitchers") or "").lower() in {"missing", "tbd", "unavailable"}:
        missing_tools.append("get_probable_pitchers")

    unique_missing = sorted(set(missing_tools))
    score = max(0, 100 - len(unique_missing) * 8 - len(unnecessary_tools) * 3)
    recommendation = "Tool usage looked complete."
    if "get_weather_context" in unique_missing:
        recommendation = "Weather should be checked before totals prediction for outdoor stadiums."
    elif unique_missing:
        recommendation = f"Review missing tool calls: {', '.join(unique_missing[:3])}."

    report = {
        "game_id": trajectory.get("game_id"),
        "market": market,
        "tool_usage_quality": score,
        "missing_tools": unique_missing,
        "unnecessary_tools": unnecessary_tools,
        "recommendation": recommendation,
    }
    return report


def store_tool_usage_report(trajectory: dict[str, Any]) -> dict[str, Any]:
    return append_jsonl("tool_usage_reports", analyze_tool_usage(trajectory))
