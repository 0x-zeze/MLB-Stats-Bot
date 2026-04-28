"""Backtesting CLI for MLB moneyline and totals predictions."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path
from typing import Any

from .bullpen import get_bullpen_usage, load_bullpen_usage
from .data_loader import (
    GameRow,
    PitcherStats,
    TeamStats,
    find_pitcher,
    find_team,
    load_pitcher_stats,
    load_sample_games,
    load_team_stats,
    read_csv,
)
from .lineup import LineupContext, get_lineup, load_lineups
from .model import BaselinePredictionModel
from .odds import american_odds_to_implied_probability, calculate_edge
from .park_factors import get_park_factor, load_park_factors
from .totals import GameTotalContext, predict_total_runs
from .utils import clean_name, data_path, safe_float
from .weather import WeatherContext, get_weather_context, load_weather_contexts

PREDICTION_LOG_FIELDS = [
    "game_id",
    "date",
    "home_team",
    "away_team",
    "predicted_winner",
    "home_win_probability",
    "away_win_probability",
    "projected_total_runs",
    "market_total",
    "over_probability",
    "under_probability",
    "model_edge",
    "confidence",
    "final_lean",
    "actual_home_score",
    "actual_away_score",
    "actual_total_runs",
    "result",
    "profit_loss",
    "closing_line",
    "closing_line_value",
]

CONFIDENCE_ORDER = {"low": 0, "medium": 1, "high": 2}


def american_profit(odds: str | int | float | None, won: bool, stake: float = 1.0) -> float:
    """Return profit/loss for a one-unit American-odds bet."""
    if not won:
        return -stake
    value = safe_float(odds, 0.0)
    if value == 0:
        return stake
    if value > 0:
        return stake * value / 100.0
    return stake * 100.0 / abs(value)


def completed_games(games: list[GameRow]) -> list[GameRow]:
    """Return games with final scores."""
    return [game for game in games if game.home_score is not None and game.away_score is not None]


def filter_games(
    games: list[GameRow],
    season: int | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> list[GameRow]:
    """Filter completed games by season or date range."""
    filtered = completed_games(games)
    if season is not None:
        filtered = [game for game in filtered if game.date.startswith(str(season))]
    if start_date:
        filtered = [game for game in filtered if game.date >= start_date]
    if end_date:
        filtered = [game for game in filtered if game.date <= end_date]
    return filtered


def market_lookup(path: str | Path | None = None) -> dict[str, dict[str, str]]:
    """Load market rows keyed by away@home."""
    source = Path(path) if path else data_path("sample_market_totals.csv")
    rows = read_csv(source)
    return {
        f"{clean_name(row.get('away_team', ''))}@{clean_name(row.get('home_team', ''))}": row
        for row in rows
    }


def market_for_game(game: GameRow, markets: dict[str, dict[str, str]]) -> dict[str, str] | None:
    """Return market row for a game."""
    return markets.get(f"{clean_name(game.away_team)}@{clean_name(game.home_team)}")


def confidence_below(confidence: str, threshold: str = "low") -> bool:
    """Return whether confidence is at or below a threshold bucket."""
    return CONFIDENCE_ORDER.get(confidence.lower(), 0) <= CONFIDENCE_ORDER.get(threshold.lower(), 0)


def bullpen_incomplete(bullpen: Any) -> bool:
    """Return whether bullpen data is missing or partial."""
    return bullpen is None


def weather_missing_for_outdoor(weather: WeatherContext | None) -> bool:
    """Return whether weather is missing for a non-roof context."""
    if weather is None:
        return True
    return False


def lineups_unconfirmed(home_lineup: LineupContext | None, away_lineup: LineupContext | None) -> bool:
    """Return whether either lineup is missing or unconfirmed."""
    return not home_lineup or not away_lineup or not home_lineup.confirmed or not away_lineup.confirmed


def no_bet_reasons(
    *,
    model_edge: float | None,
    confidence: str,
    projected_total_difference: float | None = None,
    home_pitcher: PitcherStats | None = None,
    away_pitcher: PitcherStats | None = None,
    home_lineup: LineupContext | None = None,
    away_lineup: LineupContext | None = None,
    weather: WeatherContext | None = None,
    home_bullpen: Any = None,
    away_bullpen: Any = None,
    odds_stale: bool = False,
    confidence_threshold: str = "low",
) -> list[str]:
    """Return no-bet reasons from edge, confidence, and data-completeness checks."""
    reasons: list[str] = []
    if model_edge is None or abs(model_edge) < 0.02:
        reasons.append("model edge below 2%")
    if projected_total_difference is not None and abs(projected_total_difference) < 0.4:
        reasons.append("projected total difference below 0.4 runs")
    if home_pitcher is None or away_pitcher is None:
        reasons.append("probable pitcher missing")
    if lineups_unconfirmed(home_lineup, away_lineup) and confidence.lower() == "low":
        reasons.append("lineup not confirmed and confidence is low")
    if weather_missing_for_outdoor(weather):
        reasons.append("weather data missing for outdoor stadium")
    if odds_stale:
        reasons.append("odds are stale")
    if bullpen_incomplete(home_bullpen) or bullpen_incomplete(away_bullpen):
        reasons.append("bullpen data incomplete")
    if confidence_below(confidence, confidence_threshold):
        reasons.append("confidence below threshold")
    return reasons


def _resolve_pitcher(pitchers: dict[str, PitcherStats], name: str | None) -> PitcherStats | None:
    if not name:
        return None
    return find_pitcher(pitchers, name)


def _state() -> dict[str, Any]:
    return {
        "teams": load_team_stats(),
        "pitchers": load_pitcher_stats(),
        "parks": load_park_factors(),
        "weather": load_weather_contexts(),
        "bullpens": load_bullpen_usage(),
        "lineups": load_lineups(),
    }


def _base_row(game: GameRow, game_id: str) -> dict[str, Any]:
    actual_total = (game.home_score or 0) + (game.away_score or 0)
    return {
        "game_id": game_id,
        "date": game.date,
        "home_team": game.home_team,
        "away_team": game.away_team,
        "actual_home_score": game.home_score,
        "actual_away_score": game.away_score,
        "actual_total_runs": actual_total,
    }


def _context(game: GameRow, state: dict[str, Any]) -> tuple[TeamStats, TeamStats, PitcherStats | None, PitcherStats | None, GameTotalContext]:
    home_team = find_team(state["teams"], game.home_team)
    away_team = find_team(state["teams"], game.away_team)
    home_pitcher = _resolve_pitcher(state["pitchers"], game.home_pitcher)
    away_pitcher = _resolve_pitcher(state["pitchers"], game.away_pitcher)
    total_context = GameTotalContext(
        home_pitcher=home_pitcher,
        away_pitcher=away_pitcher,
        home_lineup=get_lineup(state["lineups"], game.home_team),
        away_lineup=get_lineup(state["lineups"], game.away_team),
        home_bullpen=get_bullpen_usage(state["bullpens"], game.home_team),
        away_bullpen=get_bullpen_usage(state["bullpens"], game.away_team),
        weather=get_weather_context(state["weather"], game.home_team, game.away_team),
        park=get_park_factor(state["parks"], game.home_team),
    )
    return home_team, away_team, home_pitcher, away_pitcher, total_context


def _total_probability(probabilities: dict[float, float], target_total: float) -> float:
    """Return probability for a target total, using nearest common line when needed."""
    if target_total in probabilities:
        return probabilities[target_total]
    if not probabilities:
        return 0.0
    nearest = min(probabilities, key=lambda line: abs(line - target_total))
    return probabilities[nearest]


def build_moneyline_row(
    game: GameRow,
    game_id: str,
    state: dict[str, Any],
    market: dict[str, str] | None,
) -> dict[str, Any]:
    """Build one moneyline backtest row."""
    home_team, away_team, home_pitcher, away_pitcher, total_context = _context(game, state)
    prediction = BaselinePredictionModel().predict(home_team, away_team, home_pitcher, away_pitcher)
    home_is_pick = prediction.predicted_winner == home_team.team
    bet_probability = prediction.home_win_probability if home_is_pick else prediction.away_win_probability
    odds = (market or {}).get("home_moneyline" if home_is_pick else "away_moneyline")
    implied = american_odds_to_implied_probability(odds) if odds else None
    edge = calculate_edge(bet_probability, implied) if implied is not None else None
    reasons = no_bet_reasons(
        model_edge=edge,
        confidence=prediction.confidence,
        home_pitcher=home_pitcher,
        away_pitcher=away_pitcher,
        home_lineup=total_context.home_lineup,
        away_lineup=total_context.away_lineup,
        weather=total_context.weather,
        home_bullpen=total_context.home_bullpen,
        away_bullpen=total_context.away_bullpen,
        odds_stale=not bool(odds),
    )

    actual_home_win = (game.home_score or 0) > (game.away_score or 0)
    bet_won = actual_home_win if home_is_pick else not actual_home_win
    result = "no_bet" if reasons else "win" if bet_won else "loss"
    profit_loss = 0.0 if reasons else american_profit(odds, bet_won)

    row = _base_row(game, game_id)
    row.update(
        {
            "predicted_winner": prediction.predicted_winner,
            "home_win_probability": prediction.home_win_probability,
            "away_win_probability": prediction.away_win_probability,
            "projected_total_runs": "",
            "market_total": "",
            "over_probability": "",
            "under_probability": "",
            "model_edge": edge if edge is not None else "",
            "confidence": prediction.confidence.lower(),
            "final_lean": "NO BET" if reasons else prediction.predicted_winner,
            "result": result,
            "profit_loss": profit_loss,
            "closing_line": "",
            "closing_line_value": 0.0,
        }
    )
    return row


def build_totals_row(
    game: GameRow,
    game_id: str,
    state: dict[str, Any],
    market: dict[str, str] | None,
) -> dict[str, Any]:
    """Build one totals backtest row."""
    home_team, away_team, home_pitcher, away_pitcher, total_context = _context(game, state)
    market_total = safe_float((market or {}).get("market_total"), 0.0)
    total_prediction = predict_total_runs(home_team, away_team, total_context, market_total=market_total or None)
    target_total = market_total or 8.5
    over_probability = _total_probability(total_prediction.over_probabilities, target_total)
    under_probability = _total_probability(total_prediction.under_probabilities, target_total)
    is_over = total_prediction.best_total_lean.startswith("Over")
    is_under = total_prediction.best_total_lean.startswith("Under")
    odds = (market or {}).get("over_odds" if is_over else "under_odds" if is_under else "")
    edge = total_prediction.model_edge
    closing_line = safe_float((market or {}).get("closing_total"), 0.0) or safe_float((market or {}).get("current_total"), target_total)
    projected_diff = total_prediction.projected_total_runs - target_total
    reasons = no_bet_reasons(
        model_edge=edge,
        confidence=total_prediction.confidence,
        projected_total_difference=projected_diff,
        home_pitcher=home_pitcher,
        away_pitcher=away_pitcher,
        home_lineup=total_context.home_lineup,
        away_lineup=total_context.away_lineup,
        weather=total_context.weather,
        home_bullpen=total_context.home_bullpen,
        away_bullpen=total_context.away_bullpen,
        odds_stale=not bool(odds) or market_total <= 0,
    )
    if not is_over and not is_under:
        reasons.append("no clear total lean")

    actual_total = (game.home_score or 0) + (game.away_score or 0)
    if actual_total == target_total:
        result = "push"
        profit_loss = 0.0
    else:
        bet_won = actual_total > target_total if is_over else actual_total < target_total
        result = "no_bet" if reasons else "win" if bet_won else "loss"
        profit_loss = 0.0 if reasons else american_profit(odds, bet_won)

    clv = closing_line - target_total if is_over else target_total - closing_line if is_under else 0.0
    row = _base_row(game, game_id)
    row.update(
        {
            "predicted_winner": "",
            "home_win_probability": "",
            "away_win_probability": "",
            "projected_total_runs": total_prediction.projected_total_runs,
            "market_total": target_total,
            "over_probability": over_probability,
            "under_probability": under_probability,
            "model_edge": edge,
            "confidence": total_prediction.confidence.lower(),
            "final_lean": "NO BET" if reasons else total_prediction.best_total_lean,
            "result": result,
            "profit_loss": profit_loss,
            "closing_line": closing_line,
            "closing_line_value": 0.0 if reasons else clv,
        }
    )
    return row


def run_backtest(
    *,
    season: int | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    market: str = "moneyline",
    games_path: str | Path | None = None,
    market_path: str | Path | None = None,
) -> list[dict[str, Any]]:
    """Run a sample-data backtest for a season/date range and market."""
    if market not in {"moneyline", "totals", "run_line", "first5"}:
        raise ValueError("market must be moneyline, totals, run_line, or first5")
    if market in {"run_line", "first5"}:
        return []

    games = filter_games(load_sample_games(games_path), season=season, start_date=start_date, end_date=end_date)
    state = _state()
    markets = market_lookup(market_path)
    rows = []
    for index, game in enumerate(games):
        game_id = f"{game.date}-{clean_name(game.away_team)}-at-{clean_name(game.home_team)}"
        market_row = market_for_game(game, markets)
        if market == "moneyline":
            rows.append(build_moneyline_row(game, game_id, state, market_row))
        else:
            rows.append(build_totals_row(game, game_id, state, market_row))
    return rows


def write_prediction_log(rows: list[dict[str, Any]], path: str | Path | None = None) -> Path:
    """Write backtest rows to the predictions log CSV."""
    target = Path(path) if path else data_path("predictions_log.csv")
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=PREDICTION_LOG_FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in PREDICTION_LOG_FIELDS})
    return target


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backtest MLB predictions from local CSV data.")
    parser.add_argument("--season", type=int, help="Season year, for example 2024")
    parser.add_argument("--start-date", help="Start date YYYY-MM-DD")
    parser.add_argument("--end-date", help="End date YYYY-MM-DD")
    parser.add_argument("--market", choices=["moneyline", "totals", "run_line", "first5"], default="moneyline")
    parser.add_argument("--log", default=str(data_path("predictions_log.csv")), help="Output predictions log CSV")
    parser.add_argument("--no-write", action="store_true", help="Do not write predictions log")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rows = run_backtest(
        season=args.season,
        start_date=args.start_date,
        end_date=args.end_date,
        market=args.market,
    )
    if args.market in {"run_line", "first5"}:
        print(f"{args.market} backtest is optional and not implemented for the sample dataset yet.")
        return
    if not args.no_write:
        path = write_prediction_log(rows, args.log)
        print(f"Wrote {len(rows)} {args.market} rows to {path}")
    else:
        print(f"Generated {len(rows)} {args.market} rows")


if __name__ == "__main__":
    main()
