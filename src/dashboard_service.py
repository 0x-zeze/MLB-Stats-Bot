"""Service layer for the FastAPI/React MLB prediction dashboard.

This module keeps dashboard business logic out of FastAPI routes and out of
React components. It can use live Node-backed MLB predictions, the local Python
sample pipeline, or mock data when external data is unavailable.
"""

from __future__ import annotations

import csv
import json
import os
import subprocess
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from typing import Any

from .backtest import run_backtest
from .evaluate import (
    calculate_metrics,
    load_prediction_log,
    performance_by_confidence,
    performance_by_market_total,
)
from .prediction_pipeline import run_prediction_pipeline
from .utils import data_path, safe_float

DEFAULT_DASHBOARD_SETTINGS: dict[str, Any] = {
    "minimum_moneyline_edge": 0.02,
    "minimum_total_edge": 0.02,
    "minimum_projected_total_difference": 0.4,
    "minimum_data_quality_score": 60,
    "odds_stale_minutes": 15,
    "weather_stale_minutes": 60,
    "auto_refresh_minutes": 10,
    "low_confidence_threshold": 0.53,
    "medium_confidence_threshold": 0.57,
    "high_confidence_threshold": 0.62,
    "enable_weather_adjustment": True,
    "enable_umpire_adjustment": False,
    "enable_market_movement_adjustment": True,
}

_ROOT_DIR = Path(__file__).resolve().parents[1]
_SETTINGS_PATH = data_path("dashboard_settings.json")
_MOCK_PATH = data_path("dashboard_mock.json")
_TELEGRAM_STATE_PATH = data_path("state.json")


def now_iso() -> str:
    """Return a UTC timestamp for dashboard payloads."""
    return datetime.now(timezone.utc).isoformat()


def _read_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return fallback
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_mock_dashboard() -> dict[str, Any]:
    """Load realistic mock data used when live APIs are unavailable."""
    return _read_json(_MOCK_PATH, {"today": {"games": []}, "history": [], "performance": {}, "backtest": {}})


def load_telegram_state() -> dict[str, Any]:
    """Load Telegram bot state so dashboard history/performance mirrors the bot."""
    return _read_json(_TELEGRAM_STATE_PATH, {})


def load_dashboard_settings() -> dict[str, Any]:
    """Load dashboard thresholds, merging saved values with defaults."""
    saved = _read_json(_SETTINGS_PATH, {})
    return {**DEFAULT_DASHBOARD_SETTINGS, **saved}


def save_dashboard_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """Persist dashboard threshold settings."""
    current = load_dashboard_settings()
    for key, default in DEFAULT_DASHBOARD_SETTINGS.items():
        if key not in settings:
            continue
        value = settings[key]
        if isinstance(default, bool):
            current[key] = bool(value)
        elif isinstance(default, int):
            current[key] = int(value)
        elif isinstance(default, float):
            current[key] = float(value)
        else:
            current[key] = value

    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _SETTINGS_PATH.open("w", encoding="utf-8") as handle:
        json.dump(current, handle, indent=2, sort_keys=True)
    return current


def _as_percent(value: Any) -> float | None:
    """Normalize decimal or percent probability to 0-100 scale."""
    if value in (None, ""):
        return None
    parsed = safe_float(value, 0.0)
    return round(parsed * 100.0 if abs(parsed) <= 1.0 else parsed, 1)


def _as_edge_pct(value: Any) -> float | None:
    """Normalize decimal or percentage-point edge to displayed percentage points."""
    if value in (None, ""):
        return None
    parsed = safe_float(value, 0.0)
    return round(parsed * 100.0 if abs(parsed) <= 1.0 else parsed, 1)


def _status(value: Any, fallback: str = "Missing") -> str:
    text = str(value or "").strip()
    return text if text else fallback


def _decision_from_game(game: dict[str, Any], settings: dict[str, Any]) -> tuple[str, str]:
    quality = safe_float(game.get("data_quality", {}).get("score"), 0.0)
    moneyline_edge = abs(safe_float(game.get("moneyline", {}).get("edge"), 0.0))
    total_edge = abs(safe_float(game.get("totals", {}).get("edge"), 0.0))
    total_diff = abs(safe_float(game.get("totals", {}).get("difference"), 0.0))
    confidence = str(game.get("moneyline", {}).get("confidence") or "Low").lower()
    no_bet_reason = game.get("no_bet_reason") or ""
    minimum_moneyline_edge = safe_float(settings["minimum_moneyline_edge"], 0.02) * 100
    minimum_total_edge = safe_float(settings["minimum_total_edge"], 0.02) * 100

    if no_bet_reason:
        return "NO BET", no_bet_reason
    if quality < safe_float(settings["minimum_data_quality_score"], 60.0):
        return "NO BET", "Data quality score below minimum threshold"
    if game.get("probable_pitchers", {}).get("status") in {"Missing", "TBD"}:
        return "NO BET", "Missing probable pitcher"
    if total_diff and total_diff < safe_float(settings["minimum_projected_total_difference"], 0.4):
        if moneyline_edge < minimum_moneyline_edge:
            return "NO BET", "Projected total difference below 0.4 runs and moneyline edge is small"

    if quality >= 85 and confidence == "high" and max(moneyline_edge, total_edge) >= 4.0:
        return "BET", ""
    if moneyline_edge >= minimum_moneyline_edge or total_edge >= minimum_total_edge:
        return "LEAN", ""
    return "NO BET", "Model edge below minimum threshold"


def _summarize_today(games: list[dict[str, Any]], source: str, warning: str | None = None) -> dict[str, Any]:
    bet_count = sum(1 for game in games if game.get("decision") == "BET")
    lean_count = sum(1 for game in games if game.get("decision") == "LEAN")
    no_bet_count = sum(1 for game in games if game.get("decision") == "NO BET")
    quality_values = [safe_float(game.get("data_quality", {}).get("score"), 0.0) for game in games]
    average_quality = round(sum(quality_values) / len(quality_values), 1) if quality_values else 0.0
    return {
        "source": source,
        "last_updated": now_iso(),
        "warning": warning,
        "summary": {
            "total_games": len(games),
            "bet_count": bet_count,
            "lean_count": lean_count,
            "no_bet_count": no_bet_count,
            "average_data_quality": average_quality,
        },
        "games": games,
    }


def _mock_today(settings: dict[str, Any], warning: str | None = None) -> dict[str, Any]:
    payload = load_mock_dashboard().get("today", {})
    games = []
    for raw_game in payload.get("games", []):
        game = dict(raw_game)
        decision, reason = _decision_from_game(game, settings)
        game["decision"] = decision
        game["no_bet_reason"] = reason
        games.append(game)
    return _summarize_today(games, "mock", warning)


def _quality_from_live(game: dict[str, Any]) -> dict[str, Any]:
    quality = game.get("quality") or {}
    fields = quality.get("fields") or {}
    return {
        "score": quality.get("score", 0),
        "probable_pitchers": fields.get("probablePitchers", {}).get("status", "Missing"),
        "lineup": fields.get("lineup", {}).get("status", "Missing"),
        "weather": fields.get("weather", {}).get("status", "Missing"),
        "odds": fields.get("odds", {}).get("status", "Unavailable"),
        "bullpen_usage": fields.get("bullpen", {}).get("status", "Missing"),
        "park_factor": fields.get("park", {}).get("status", "Missing"),
        "injury_news": "Available" if "injury context" not in quality.get("missingFields", []) else "Missing",
        "market_movement": "Unavailable",
        "missing_fields": quality.get("missingFields", []),
        "stale_fields": quality.get("staleFields", []),
        "confidence_adjustments": quality.get("confidenceAdjustments", []),
        "issues": quality.get("missingFields", []) + quality.get("confidenceAdjustments", []),
    }


def _live_game_to_dashboard(game: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any]:
    total_runs = game.get("totalRuns") or {}
    over = total_runs.get("over") or {}
    under = total_runs.get("under") or {}
    market_total = safe_float(total_runs.get("marketLine"), 8.5)
    line_key = str(market_total)
    over_probability = _as_percent(over.get(line_key) or over.get("8.5"))
    under_probability = _as_percent(under.get(line_key) or under.get("8.5"))
    quality = _quality_from_live(game)
    projected_total = safe_float(total_runs.get("projectedTotal"), 0.0)
    dashboard_game = {
        "id": game.get("game_id"),
        "date": game.get("date"),
        "away_team": game.get("away_team"),
        "home_team": game.get("home_team"),
        "game_time": game.get("start"),
        "ballpark": game.get("venue"),
        "status": game.get("status"),
        "probable_pitchers": {
            "away": game.get("starters", {}).get("away", "TBD"),
            "home": game.get("starters", {}).get("home", "TBD"),
            "status": quality["probable_pitchers"],
        },
        "lineup_status": quality["lineup"],
        "weather_status": quality["weather"],
        "weather_summary": "Weather adjustment included when available",
        "odds_status": quality["odds"],
        "freshness_status": "Fresh",
        "final_lean": total_runs.get("bestLean") or game.get("pick", {}).get("name") or "NO BET",
        "no_bet_reason": "",
        "moneyline": {
            "away_probability": _as_percent(game.get("probabilities", {}).get("away")),
            "home_probability": _as_percent(game.get("probabilities", {}).get("home")),
            "model_probability": _as_percent(game.get("pick", {}).get("probability")),
            "market_implied_probability": None,
            "edge": None,
            "current_odds": "Unavailable",
            "confidence": _status(game.get("pick", {}).get("confidence"), "Low").title(),
        },
        "totals": {
            "projected_total": round(projected_total, 1) if projected_total else None,
            "market_total": market_total,
            "difference": round(safe_float(total_runs.get("marketDeltaRuns"), projected_total - market_total), 1),
            "over_probability": over_probability,
            "under_probability": under_probability,
            "edge": _as_edge_pct(total_runs.get("modelEdge")),
            "lean": total_runs.get("bestLean") or "No total lean",
            "over_odds": "Unavailable",
            "under_odds": "Unavailable",
        },
        "data_quality": quality,
        "main_factors": game.get("reasons") or total_runs.get("factors") or [],
        "risk_factors": [game.get("risk")] if game.get("risk") else quality.get("issues", []),
    }
    decision, reason = _decision_from_game(dashboard_game, settings)
    if dashboard_game["odds_status"] in {"Unavailable", "Missing"} and decision == "BET":
        decision = "LEAN"
        reason = "Market odds unavailable, treat as lean only"
    dashboard_game["decision"] = decision
    dashboard_game["no_bet_reason"] = reason
    return dashboard_game


def _node_live_predictions(date_ymd: str) -> dict[str, Any]:
    """Call the existing Node live prediction layer and return normalized JSON."""
    script = (
        "import('./src/dashboard.js')"
        ".then(async (m) => { const data = await m.livePredictions(process.env.DASHBOARD_DATE);"
        " console.log(JSON.stringify(data)); })"
        ".catch((error) => { console.error(error.stack || error.message); process.exit(1); });"
    )
    env = os.environ.copy()
    env["DASHBOARD_DATE"] = date_ymd
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=_ROOT_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=70,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "Node live prediction failed").strip())
    return json.loads(result.stdout)


def _live_today(date_ymd: str, settings: dict[str, Any]) -> dict[str, Any]:
    payload = _node_live_predictions(date_ymd)
    games = [_live_game_to_dashboard(game, settings) for game in payload.get("games", [])]
    return _summarize_today(games, "live")


def _quality_from_sample(quality: dict[str, Any]) -> dict[str, Any]:
    return {
        "score": quality.get("score", 0),
        "probable_pitchers": quality.get("probable_pitchers", "Missing"),
        "lineup": quality.get("lineup", "Missing"),
        "weather": quality.get("weather", "Missing"),
        "odds": quality.get("odds", "Missing"),
        "bullpen_usage": quality.get("bullpen_usage", "Missing"),
        "park_factor": quality.get("park_factor", "Missing"),
        "injury_news": quality.get("injury_news", "Missing"),
        "market_movement": quality.get("market_movement", "Missing"),
        "missing_fields": quality.get("missing_fields", []),
        "stale_fields": quality.get("stale_fields", []),
        "confidence_adjustments": quality.get("confidence_adjustments", []),
        "issues": quality.get("missing_fields", []) + quality.get("stale_fields", []),
    }


def _sample_game_to_dashboard(game_id: int, pipeline: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any]:
    game = pipeline["game"]
    moneyline = pipeline["moneyline"]
    totals = pipeline["totals"]
    quality = _quality_from_sample(pipeline.get("quality_report", {}))
    context = pipeline.get("context", {})
    market = pipeline.get("market", {})
    market_line = safe_float(totals.get("market_total"), 8.5)
    over = totals.get("over_probabilities") or {}
    under = totals.get("under_probabilities") or {}
    line_key = market_line if market_line in over else min(over.keys(), key=lambda item: abs(item - market_line)) if over else 8.5
    projected_total = safe_float(totals.get("projected_total_runs"), 0.0)
    dashboard_game = {
        "id": str(game_id),
        "date": game.date,
        "away_team": game.away_team,
        "home_team": game.home_team,
        "game_time": game.date,
        "ballpark": context.get("park", {}).get("park", game.home_team),
        "status": "Sample",
        "probable_pitchers": {
            "away": game.away_pitcher or "TBD",
            "home": game.home_pitcher or "TBD",
            "status": quality["probable_pitchers"],
        },
        "lineup_status": quality["lineup"],
        "weather_status": quality["weather"],
        "weather_summary": context.get("weather", {}).get("condition", "Sample weather context"),
        "odds_status": quality["odds"],
        "freshness_status": "Sample",
        "final_lean": totals.get("final_lean") or moneyline.get("final_lean"),
        "no_bet_reason": moneyline.get("decision_reason") or totals.get("decision_reason") or "",
        "moneyline": {
            "away_probability": _as_percent(moneyline.get("away_win_probability")),
            "home_probability": _as_percent(moneyline.get("home_win_probability")),
            "model_probability": _as_percent(max(moneyline.get("away_win_probability", 0), moneyline.get("home_win_probability", 0))),
            "market_implied_probability": _as_percent(moneyline.get("home_market_implied_probability")),
            "edge": _as_edge_pct(moneyline.get("model_edge")),
            "current_odds": market.get("home_moneyline") or "Unavailable",
            "confidence": str(moneyline.get("confidence", "Low")).title(),
        },
        "totals": {
            "projected_total": round(projected_total, 1),
            "market_total": market_line,
            "difference": round(projected_total - market_line, 1),
            "over_probability": _as_percent(over.get(line_key)),
            "under_probability": _as_percent(under.get(line_key)),
            "edge": _as_edge_pct(totals.get("model_edge")),
            "lean": totals.get("best_total_lean") or totals.get("raw_lean") or "No total lean",
            "over_odds": market.get("over_odds") or "Unavailable",
            "under_odds": market.get("under_odds") or "Unavailable",
        },
        "data_quality": quality,
        "main_factors": pipeline.get("supporting_factors") or moneyline.get("main_factors") or [],
        "risk_factors": quality.get("issues") or [moneyline.get("decision_reason", "")],
    }
    decision, reason = _decision_from_game(dashboard_game, settings)
    dashboard_game["decision"] = decision
    dashboard_game["no_bet_reason"] = reason or dashboard_game["no_bet_reason"]
    return dashboard_game


def _sample_today(settings: dict[str, Any]) -> dict[str, Any]:
    games = []
    for game_id in range(0, 8):
        try:
            games.append(_sample_game_to_dashboard(game_id, run_prediction_pipeline(game_id), settings))
        except Exception:
            break
    return _summarize_today(games, "sample")


def get_today_dashboard(date_ymd: str | None = None, source: str = "live") -> dict[str, Any]:
    """Return today's dashboard payload from live, sample, or mock data."""
    settings = load_dashboard_settings()
    source = (source or "live").lower()
    target_date = date_ymd or datetime.now().date().isoformat()
    if source == "mock":
        return _mock_today(settings)
    if source == "sample":
        return _sample_today(settings)
    try:
        return _live_today(target_date, settings)
    except Exception as exc:
        return _mock_today(settings, warning=f"Live data unavailable; showing mock data. Detail: {exc}")


def _telegram_learning_by_game(state: dict[str, Any]) -> dict[str, dict[str, Any]]:
    memory = state.get("memory") or {}
    logs = memory.get("learningLog") or []
    return {str(item.get("gamePk")): item for item in logs if item.get("gamePk") is not None}


def _telegram_history_row(prediction: dict[str, Any], outcome: dict[str, Any] | None = None) -> dict[str, Any]:
    pick = prediction.get("pick") or {}
    away = prediction.get("away") or {}
    home = prediction.get("home") or {}
    correct = outcome.get("correct") if outcome else None
    result = "Pending" if correct is None else "Win" if correct else "Loss"
    profit_loss = 0.0 if correct is None else 1.0 if correct else -1.0
    prediction_name = pick.get("name") or pick.get("abbreviation") or "-"
    probability = safe_float(pick.get("winProbability"), 0.0)
    return {
        "date": prediction.get("dateYmd"),
        "matchup": prediction.get("matchup") or f"{away.get('name')} @ {home.get('name')}",
        "market_type": "moneyline",
        "prediction": prediction_name,
        "decision": "BET",
        "confidence": str(pick.get("confidence") or "model").title(),
        "model_probability": probability,
        "market_implied_probability": None,
        "edge": 0.0,
        "projected_total": None,
        "market_total": None,
        "closing_line": None,
        "actual_result": outcome.get("score") if outcome else "",
        "result": result,
        "profit_loss": profit_loss,
        "clv": 0.0,
        "notes": outcome.get("note", "") if outcome else prediction.get("agentRisk", ""),
        "source": "telegram",
    }


def get_telegram_prediction_history() -> list[dict[str, Any]]:
    """Return rows from the Telegram bot's persisted state.json."""
    state = load_telegram_state()
    predictions = state.get("predictions") or {}
    outcomes = _telegram_learning_by_game(state)
    rows = [
        _telegram_history_row(prediction, outcomes.get(str(game_pk)))
        for game_pk, prediction in predictions.items()
    ]
    rows.sort(key=lambda row: (str(row.get("date") or ""), str(row.get("matchup") or "")), reverse=True)
    return rows


def _accuracy(correct: Any, total: Any) -> float:
    parsed_total = safe_float(total, 0.0)
    if parsed_total <= 0:
        return 0.0
    return round((safe_float(correct, 0.0) / parsed_total) * 100.0, 1)


def _telegram_calibration_rows(state: dict[str, Any]) -> list[dict[str, Any]]:
    predictions = state.get("predictions") or {}
    outcomes = _telegram_learning_by_game(state)
    buckets: dict[str, dict[str, float]] = {}
    for game_pk, prediction in predictions.items():
        outcome = outcomes.get(str(game_pk))
        if outcome is None:
            continue
        probability = safe_float((prediction.get("pick") or {}).get("winProbability"), 0.0)
        if probability <= 0:
            continue
        bucket_floor = int(probability // 10) * 10
        bucket = f"{bucket_floor}-{bucket_floor + 9}%"
        if bucket not in buckets:
            buckets[bucket] = {"predictions": 0, "expected": 0.0, "correct": 0.0}
        buckets[bucket]["predictions"] += 1
        buckets[bucket]["expected"] += probability
        buckets[bucket]["correct"] += 1 if outcome.get("correct") else 0

    return [
        {
            "bucket": bucket,
            "predictions": int(values["predictions"]),
            "expected": round(values["expected"] / values["predictions"], 1) if values["predictions"] else 0.0,
            "actual": _accuracy(values["correct"], values["predictions"]),
        }
        for bucket, values in sorted(buckets.items())
    ]


def get_telegram_model_performance() -> dict[str, Any] | None:
    """Return model performance from Telegram memory so it matches /memory."""
    state = load_telegram_state()
    memory = state.get("memory") or {}
    total = safe_float(memory.get("totalPicks"), 0.0)
    if total <= 0:
        return None

    correct = safe_float(memory.get("correctPicks"), 0.0)
    wrong = safe_float(memory.get("wrongPicks"), 0.0)
    win_rate = _accuracy(correct, total)
    by_confidence = memory.get("byConfidence") or {}
    first_inning = memory.get("firstInning") or {}
    calibration = _telegram_calibration_rows(state)
    if not calibration:
        calibration = [
            {
                "bucket": str(label).title(),
                "predictions": int(value.get("total", 0)),
                "expected": 0.0,
                "actual": _accuracy(value.get("correct", 0), value.get("total", 0)),
            }
            for label, value in by_confidence.items()
        ]

    return {
        "overall": {
            "total_predictions": int(total),
            "bets_taken": int(total),
            "wins": int(correct),
            "losses": int(wrong),
            "win_rate": win_rate,
            "roi": round(((correct - wrong) / total) * 100.0, 1) if total else 0.0,
            "average_edge": 0.0,
            "average_clv": 0.0,
            "brier_score": 0.0,
            "log_loss": 0.0,
            "clv_hit_rate": 0.0,
            "source": "telegram",
        },
        "by_market": [
            {"market": "moneyline", "bets": int(total), "win_rate": win_rate, "roi": round(((correct - wrong) / total) * 100.0, 1) if total else 0.0},
            {
                "market": "first inning",
                "bets": int(safe_float(first_inning.get("totalPicks"), 0.0)),
                "win_rate": _accuracy(first_inning.get("correctPicks", 0), first_inning.get("totalPicks", 0)),
                "roi": 0.0,
            },
        ],
        "by_total_range": [],
        "calibration": calibration,
        "recent_log": (memory.get("learningLog") or [])[:10],
    }


def get_prediction_history() -> list[dict[str, Any]]:
    """Return historical predictions from the log or mock data."""
    telegram_rows = get_telegram_prediction_history()
    if telegram_rows:
        return telegram_rows

    rows = load_prediction_log()
    if not rows:
        return load_mock_dashboard().get("history", [])
    history = []
    for row in rows:
        prediction = row.get("final_lean") or row.get("predicted_winner")
        history.append(
            {
                "date": row.get("date"),
                "matchup": f"{row.get('away_team')} @ {row.get('home_team')}",
                "market_type": "totals" if str(prediction).startswith(("Over", "Under")) else "moneyline",
                "prediction": prediction,
                "decision": "NO BET" if prediction == "NO BET" else "BET",
                "confidence": str(row.get("confidence", "")).title(),
                "model_probability": _as_percent(row.get("home_win_probability") or row.get("over_probability")),
                "market_implied_probability": None,
                "edge": _as_edge_pct(row.get("model_edge")),
                "projected_total": row.get("projected_total_runs"),
                "market_total": row.get("market_total"),
                "closing_line": row.get("closing_line"),
                "actual_result": f"{row.get('away_team')} {row.get('actual_away_score')} - {row.get('home_team')} {row.get('actual_home_score')}",
                "result": str(row.get("result", "")).title(),
                "profit_loss": safe_float(row.get("profit_loss"), 0.0),
                "clv": safe_float(row.get("closing_line_value"), 0.0),
                "notes": "",
            }
        )
    return history


def get_model_performance() -> dict[str, Any]:
    """Return performance metrics from prediction logs or mock data."""
    telegram_performance = get_telegram_model_performance()
    if telegram_performance:
        return telegram_performance

    rows = load_prediction_log()
    if not rows:
        return load_mock_dashboard().get("performance", {})
    metrics = calculate_metrics(rows)
    by_confidence = performance_by_confidence(rows)
    by_total_range = performance_by_market_total(rows)
    return {
        "overall": {
            "total_predictions": len(rows),
            "bets_taken": metrics.get("bets", 0),
            "win_rate": _as_percent(metrics.get("win_rate")) or 0.0,
            "roi": _as_edge_pct(metrics.get("roi")) or 0.0,
            "average_edge": _as_edge_pct(metrics.get("average_edge")) or 0.0,
            "average_clv": metrics.get("average_clv", 0.0),
            "brier_score": metrics.get("brier_score", 0.0),
            "log_loss": metrics.get("log_loss", 0.0),
            "clv_hit_rate": 0.0,
        },
        "by_market": [
            {"market": "moneyline", "bets": metrics.get("bets", 0), "win_rate": _as_percent(metrics.get("win_rate")) or 0.0, "roi": _as_edge_pct(metrics.get("roi")) or 0.0},
            {"market": "totals", "bets": metrics.get("bets", 0), "win_rate": _as_percent(metrics.get("win_rate")) or 0.0, "roi": _as_edge_pct(metrics.get("roi")) or 0.0},
        ],
        "by_total_range": [
            {"range": key, "bets": value.get("bets", 0), "win_rate": _as_percent(value.get("win_rate")) or 0.0, "roi": _as_edge_pct(value.get("roi")) or 0.0}
            for key, value in by_total_range.items()
        ],
        "calibration": [
            {"bucket": key, "predictions": value.get("bets", 0), "expected": 0.0, "actual": _as_percent(value.get("win_rate")) or 0.0}
            for key, value in by_confidence.items()
        ],
    }


def run_dashboard_backtest(params: dict[str, Any]) -> dict[str, Any]:
    """Run a sample backtest and shape it for the dashboard."""
    market = params.get("market_type") or params.get("market") or "moneyline"
    rows = run_backtest(
        season=int(params["season"]) if params.get("season") else None,
        start_date=params.get("start_date") or None,
        end_date=params.get("end_date") or None,
        market=market,
    )
    if not rows:
        return load_mock_dashboard().get("backtest", {})
    metrics = calculate_metrics(rows)
    no_bet_reasons: dict[str, int] = {}
    for row in rows:
        if row.get("result") == "no_bet":
            reason = row.get("final_lean") or "NO BET"
            no_bet_reasons[reason] = no_bet_reasons.get(reason, 0) + 1
    return {
        "summary": {
            "bets_taken": metrics.get("bets", 0),
            "win_rate": _as_percent(metrics.get("win_rate")) or 0.0,
            "roi": _as_edge_pct(metrics.get("roi")) or 0.0,
            "average_edge": _as_edge_pct(metrics.get("average_edge")) or 0.0,
            "average_clv": metrics.get("average_clv", 0.0),
            "best_segment": "See performance by market total",
            "weakest_segment": "See performance by market total",
            "calibration_summary": "Generated from local CSV backtest.",
            "no_bet_count": sum(1 for row in rows if row.get("result") == "no_bet"),
        },
        "no_bet_reasons": [{"reason": key, "count": value} for key, value in no_bet_reasons.items()],
        "rows": [
            {
                "date": row.get("date"),
                "matchup": f"{row.get('away_team')} @ {row.get('home_team')}",
                "market": market,
                "lean": row.get("final_lean"),
                "result": row.get("result"),
                "edge": _as_edge_pct(row.get("model_edge")),
                "profit_loss": row.get("profit_loss"),
            }
            for row in rows
        ],
    }


def get_mock_backtest() -> dict[str, Any]:
    """Return mock backtest payload."""
    return load_mock_dashboard().get("backtest", {})


def rows_to_csv(rows: list[dict[str, Any]]) -> str:
    """Serialize dictionaries to CSV text."""
    if not rows:
        return ""
    fieldnames = sorted({key for row in rows for key in row.keys()})
    output = StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return output.getvalue()
