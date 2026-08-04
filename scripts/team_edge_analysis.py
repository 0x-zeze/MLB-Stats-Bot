#!/usr/bin/env python3
"""Team-level edge analysis for moneyline model picks.

Builds per-team advantage profiles from graded picks:
- Overall WR/ROI when model picks this team
- Side breakdown (away vs home)
- Disagreement performance (model picks team when market favors other)
- Advantage tier (S/A/B/C/D) for quick filtering

Run:
  node scripts/run_python.js scripts/team_edge_analysis.py
  node scripts/run_python.js scripts/team_edge_analysis.py --json
  node scripts/run_python.js scripts/team_edge_analysis.py --team "Kansas City Royals"
"""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.utils import data_path


def _implied_probability(american_odds: float) -> float:
    odds = float(american_odds)
    return 100.0 / (odds + 100.0) if odds > 0 else -odds / (-odds + 100.0)


def _american_profit(odds: float, won: bool) -> float:
    if won:
        return 100.0 / abs(odds) if odds < 0 else odds / 100.0
    return -1.0


def load_team_rows(sqlite_path: Path, outcomes_csv: Path) -> list[dict[str, Any]]:
    conn = sqlite3.connect(str(sqlite_path))
    conn.row_factory = sqlite3.Row
    try:
        picks = list(
            conn.execute(
                """
                SELECT game_pk, date_ymd, payload
                FROM picks
                ORDER BY date_ymd, game_pk
                """
            )
        )
    finally:
        conn.close()

    outcomes: dict[str, dict[str, str]] = {}
    if outcomes_csv.exists():
        with outcomes_csv.open(newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                if str(row.get("market") or "").lower() != "moneyline":
                    continue
                if str(row.get("result") or "").lower() not in {"win", "loss"}:
                    continue
                game_id = str(row.get("game_id") or "")
                if game_id:
                    outcomes[game_id] = row

    rows: list[dict[str, Any]] = []
    for row in picks:
        game_pk = str(row["game_pk"])
        outcome = outcomes.get(game_pk)
        if not outcome:
            continue
        try:
            payload = json.loads(row["payload"] or "{}")
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue

        model_breakdown = payload.get("modelBreakdown")
        if not isinstance(model_breakdown, dict):
            model_breakdown = {}
        pure_home = model_breakdown.get("pureHomeProbability")
        if pure_home is None:
            home = payload.get("home") or {}
            if isinstance(home, dict):
                pure_home = home.get("pureModelProbability")
        current_odds = payload.get("currentOdds") or {}
        if not isinstance(current_odds, dict):
            current_odds = {}
        home_moneyline = current_odds.get("homeMoneyline")
        away_moneyline = current_odds.get("awayMoneyline")
        if pure_home is None or home_moneyline is None or away_moneyline is None:
            continue
        try:
            model_home_prob = float(pure_home) / 100.0
            home_odds = float(home_moneyline)
            away_odds = float(away_moneyline)
        except (TypeError, ValueError):
            continue

        implied_home = _implied_probability(home_odds)
        implied_away = _implied_probability(away_odds)
        market_home = implied_home / (implied_home + implied_away)

        predicted_winner = str(outcome.get("prediction") or "")
        home_name = str((payload.get("home") or {}).get("name") or "")
        away_name = str((payload.get("away") or {}).get("name") or "")
        if predicted_winner.lower() == home_name.lower():
            home_won = 1
        elif predicted_winner.lower() == away_name.lower():
            home_won = 0
        else:
            continue

        model_side = "home" if model_home_prob >= 0.5 else "away"
        market_side = "home" if market_home >= 0.5 else "away"
        pick_team = home_name if model_side == "home" else away_name
        pick_odds = home_odds if model_side == "home" else away_odds
        won = bool(home_won) if model_side == "home" else not bool(home_won)
        profit = _american_profit(pick_odds, won)
        disagreement = model_side != market_side

        rows.append(
            {
                "date": str(row["date_ymd"] or ""),
                "game_pk": game_pk,
                "pick_team": pick_team,
                "model_side": model_side,
                "market_side": market_side,
                "model_prob": model_home_prob if model_side == "home" else 1.0 - model_home_prob,
                "market_prob": market_home if model_side == "home" else 1.0 - market_home,
                "odds": pick_odds,
                "won": won,
                "profit": profit,
                "disagreement": disagreement,
                "home_team": home_name,
                "away_team": away_name,
            }
        )
    return rows


def team_advantage(rows: list[dict[str, Any]]) -> dict[str, Any]:
    teams: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "n": 0, "wins": 0, "profit": 0.0,
            "model_prob_sum": 0.0, "market_prob_sum": 0.0,
            "conflicts": 0, "conflict_wins": 0, "conflict_profit": 0.0,
            "away_n": 0, "away_wins": 0, "away_profit": 0.0,
            "home_n": 0, "home_wins": 0, "home_profit": 0.0,
        }
    )
    for r in rows:
        t = teams[r["pick_team"]]
        t["n"] += 1
        t["wins"] += 1 if r["won"] else 0
        t["profit"] += r["profit"]
        t["model_prob_sum"] += r["model_prob"]
        t["market_prob_sum"] += r["market_prob"]
        if r["disagreement"]:
            t["conflicts"] += 1
            t["conflict_wins"] += 1 if r["won"] else 0
            t["conflict_profit"] += r["profit"]
        if r["model_side"] == "away":
            t["away_n"] += 1
            t["away_wins"] += 1 if r["won"] else 0
            t["away_profit"] += r["profit"]
        else:
            t["home_n"] += 1
            t["home_wins"] += 1 if r["won"] else 0
            t["home_profit"] += r["profit"]

    def advantage_score(t: dict[str, Any]) -> float | None:
        if t["n"] < 10:
            return None
        wr = t["wins"] / t["n"]
        roi = t["profit"] / t["n"]
        conflict_wr = t["conflict_wins"] / t["conflicts"] if t["conflicts"] >= 5 else None
        score = (
            wr * 0.4
            + min(max(roi, 0.0), 1.0) * 0.3
            + (conflict_wr or 0.0) * 0.2
            + min(t["n"] / 50.0, 1.0) * 0.1
        )
        return round(score, 3)

    def tier(score: float) -> str:
        if score >= 0.85:
            return "S"
        if score >= 0.75:
            return "A"
        if score >= 0.65:
            return "B"
        if score >= 0.55:
            return "C"
        return "D"

    result: dict[str, dict[str, Any]] = {}
    for team, t in teams.items():
        score = advantage_score(t)
        if score is None:
            continue
        n = t["n"]
        result[team] = {
            "tier": tier(score),
            "score": score,
            "n": n,
            "win_rate": round(t["wins"] / n, 3),
            "roi": round(t["profit"] / n, 3),
            "avg_model_prob": round(t["model_prob_sum"] / n, 3),
            "avg_market_prob": round(t["market_prob_sum"] / n, 3),
            "conflicts": t["conflicts"],
            "conflict_win_rate": round(t["conflict_wins"] / t["conflicts"], 3) if t["conflicts"] >= 5 else None,
            "conflict_roi": round(t["conflict_profit"] / t["conflicts"], 3) if t["conflicts"] >= 5 else None,
            "away": (
                {
                    "n": t["away_n"],
                    "win_rate": round(t["away_wins"] / t["away_n"], 3),
                    "roi": round(t["away_profit"] / t["away_n"], 3),
                }
                if t["away_n"] >= 5
                else None
            ),
            "home": (
                {
                    "n": t["home_n"],
                    "win_rate": round(t["home_wins"] / t["home_n"], 3),
                    "roi": round(t["home_profit"] / t["home_n"], 3),
                }
                if t["home_n"] >= 5
                else None
            ),
        }
    return dict(sorted(result.items(), key=lambda x: x[1]["score"], reverse=True))


def print_report(teams: dict[str, Any], team_filter: str | None = None) -> None:
    print("=" * 72)
    print("Team Advantage Analysis (model pick side)")
    print("=" * 72)
    print(f'{"team":<28} {"tier":>4} {"score":>5} {"n":>4} {"WR":>6} {"ROI":>7} {"confWR":>6} {"awayWR":>6}')
    for team, adv in teams.items():
        if team_filter and team_filter.lower() not in team.lower():
            continue
        conf_wr = adv["conflict_win_rate"]
        conf_wr_str = f"{conf_wr:.1%}" if conf_wr is not None else "n/a"
        away = adv["away"]
        away_str = f"{away['win_rate']:.1%}" if away else "n/a"
        print(
            f'{team:<28} {adv["tier"]:>4} {adv["score"]:>5} {adv["n"]:>4} '
            f'{adv["win_rate"]:>6.1%} {adv["roi"]:>+7.1%} {conf_wr_str:>6} {away_str:>6}'
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", default=str(data_path("state.sqlite")))
    parser.add_argument("--outcomes-csv", default=str(data_path("evolution/prediction_outcomes.csv")))
    parser.add_argument("--team", help="Filter to a specific team name")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--write", help="Write team advantages JSON to path")
    args = parser.parse_args(argv)

    sqlite_path = Path(args.sqlite)
    if not sqlite_path.exists():
        print(f"ERROR: sqlite not found: {sqlite_path}", file=sys.stderr)
        return 2

    rows = load_team_rows(sqlite_path, Path(args.outcomes_csv))
    teams = team_advantage(rows)

    if args.write:
        target = Path(args.write)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(
                {
                    "generated_at": Path(args.sqlite).stat().st_mtime,
                    "source": "state.sqlite picks + prediction_outcomes.csv",
                    "teams": teams,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"Wrote {target}")

    if args.json:
        print(json.dumps(teams, indent=2, sort_keys=True))
    else:
        print_report(teams, team_filter=args.team)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
