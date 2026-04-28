"""Command-line prediction entry point.

Example:
    python -m src.predict --home "Los Angeles Dodgers" --away "New York Yankees"
"""

from __future__ import annotations

import argparse
from dataclasses import replace

from .data_loader import (
    PitcherStats,
    find_pitcher,
    find_team,
    load_pitcher_stats,
    load_sample_games,
    load_team_stats,
    pitchers_for_team,
    read_csv,
)
from .bullpen import get_bullpen_usage, load_bullpen_usage
from .lineup import get_lineup, load_lineups
from .model import BaselinePredictionModel
from .odds import (
    american_odds_to_implied_probability,
    calculate_edge,
    decimal_odds_to_implied_probability,
)
from .park_factors import get_park_factor, load_park_factors
from .totals import GameTotalContext, predict_total_runs
from .utils import clean_name, data_path, format_probability, safe_float
from .weather import get_weather_context, load_weather_contexts


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Predict an MLB matchup from local CSV data.")
    parser.add_argument("--home", required=True, help="Home team name")
    parser.add_argument("--away", required=True, help="Away team name")
    parser.add_argument("--home-pitcher", help="Override home starting pitcher")
    parser.add_argument("--away-pitcher", help="Override away starting pitcher")
    parser.add_argument("--team-stats", help="Path to team stats CSV")
    parser.add_argument("--pitcher-stats", help="Path to pitcher stats CSV")
    parser.add_argument("--games", help="Path to games CSV")
    parser.add_argument("--weather", help="Path to weather CSV")
    parser.add_argument("--park-factors", help="Path to park factors CSV")
    parser.add_argument("--bullpen-usage", help="Path to bullpen usage CSV")
    parser.add_argument("--lineups", help="Path to lineups CSV")
    parser.add_argument("--market-totals", help="Path to market totals CSV")
    parser.add_argument("--home-odds", help="Optional home odds for market edge comparison")
    parser.add_argument("--market-total", type=float, help="Optional betting market total")
    parser.add_argument("--over-odds", help="Optional over odds for total edge comparison")
    parser.add_argument("--under-odds", help="Optional under odds for total edge comparison")
    parser.add_argument("--odds-format", choices=["american", "decimal"], default="american")
    return parser.parse_args()


def _matchup_pitcher_from_games(
    games_path: str | None,
    home_team: str,
    away_team: str,
    side: str,
) -> str | None:
    games = load_sample_games(games_path)
    home_key = clean_name(home_team)
    away_key = clean_name(away_team)
    for game in games:
        if clean_name(game.home_team) == home_key and clean_name(game.away_team) == away_key:
            return game.home_pitcher if side == "home" else game.away_pitcher
    return None


def _default_pitcher_for_team(pitchers: dict[str, PitcherStats], team: str) -> str | None:
    options = pitchers_for_team(pitchers.values(), team)
    return options[0].pitcher if options else None


def _resolve_pitcher(
    pitchers: dict[str, PitcherStats],
    games_path: str | None,
    team: str,
    opponent: str,
    side: str,
    override: str | None,
) -> PitcherStats | None:
    name = override or _matchup_pitcher_from_games(
        games_path,
        home_team=team if side == "home" else opponent,
        away_team=opponent if side == "home" else team,
        side=side,
    )
    name = name or _default_pitcher_for_team(pitchers, team)
    return find_pitcher(pitchers, name)


def _market_probability(odds: str | None, odds_format: str) -> float | None:
    if odds is None or not str(odds).strip():
        return None
    if odds_format == "decimal":
        return decimal_odds_to_implied_probability(odds)
    return american_odds_to_implied_probability(odds)


def _find_market_total_row(path: str | None, home_team: str, away_team: str) -> dict[str, str] | None:
    source = path or data_path("sample_market_totals.csv")
    home_key = clean_name(home_team)
    away_key = clean_name(away_team)
    for row in read_csv(source):
        if clean_name(row.get("home_team", "")) == home_key and clean_name(row.get("away_team", "")) == away_key:
            return row
    return None


def _probability_for_total_side(total_result, market_total: float, side: str) -> float:
    probabilities = (
        total_result.over_probabilities if side.lower() == "over" else total_result.under_probabilities
    )
    if market_total in probabilities:
        return probabilities[market_total]
    nearest_line = min(probabilities, key=lambda line: abs(line - market_total))
    return probabilities[nearest_line]


def main() -> None:
    args = parse_args()
    teams = load_team_stats(args.team_stats)
    pitchers = load_pitcher_stats(args.pitcher_stats)
    weather_contexts = load_weather_contexts(args.weather)
    park_factors = load_park_factors(args.park_factors)
    bullpen_usage = load_bullpen_usage(args.bullpen_usage)
    lineups = load_lineups(args.lineups)
    market_row = _find_market_total_row(args.market_totals, args.home, args.away)

    home_team = find_team(teams, args.home)
    away_team = find_team(teams, args.away)
    home_pitcher = _resolve_pitcher(
        pitchers, args.games, args.home, args.away, "home", args.home_pitcher
    )
    away_pitcher = _resolve_pitcher(
        pitchers, args.games, args.away, args.home, "away", args.away_pitcher
    )

    result = BaselinePredictionModel().predict(home_team, away_team, home_pitcher, away_pitcher)
    print(f"Home Team: {result.home_team}")
    print(f"Away Team: {result.away_team}")
    print("")
    print("Winner Prediction:")
    print(f"{result.home_team} win probability: {format_probability(result.home_win_probability)}")
    print(f"{result.away_team} win probability: {format_probability(result.away_win_probability)}")
    print(f"Predicted winner: {result.predicted_winner}")
    print(f"Confidence: {result.confidence}")

    market_probability = _market_probability(args.home_odds, args.odds_format)
    if market_probability is not None:
        edge = calculate_edge(result.home_win_probability, market_probability)
        print("")
        print("Market Comparison:")
        print(f"Home Market Implied Probability: {format_probability(market_probability)}")
        print(f"Home Model Edge: {edge * 100:+.1f}%")

    market_total = args.market_total
    if market_total is None and market_row:
        market_total = safe_float(market_row.get("market_total"), 0.0) or None
    over_odds = args.over_odds or (market_row or {}).get("over_odds")
    under_odds = args.under_odds or (market_row or {}).get("under_odds")

    total_context = GameTotalContext(
        home_pitcher=home_pitcher,
        away_pitcher=away_pitcher,
        home_lineup=get_lineup(lineups, args.home),
        away_lineup=get_lineup(lineups, args.away),
        home_bullpen=get_bullpen_usage(bullpen_usage, args.home),
        away_bullpen=get_bullpen_usage(bullpen_usage, args.away),
        weather=get_weather_context(weather_contexts, args.home, args.away),
        park=get_park_factor(park_factors, args.home),
    )
    total_result = predict_total_runs(home_team, away_team, total_context, market_total=market_total)
    if market_total is not None:
        if total_result.best_total_lean.startswith("Over"):
            market_side_probability = _market_probability(over_odds, args.odds_format)
            if market_side_probability is not None:
                model_probability = _probability_for_total_side(total_result, market_total, "over")
                total_result = replace(
                    total_result,
                    model_edge=calculate_edge(model_probability, market_side_probability),
                )
        elif total_result.best_total_lean.startswith("Under"):
            market_side_probability = _market_probability(under_odds, args.odds_format)
            if market_side_probability is not None:
                model_probability = _probability_for_total_side(total_result, market_total, "under")
                total_result = replace(
                    total_result,
                    model_edge=calculate_edge(model_probability, market_side_probability),
                )

    print("")
    print(total_result.format())


if __name__ == "__main__":
    main()
