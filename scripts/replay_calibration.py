#!/usr/bin/env python3
"""Replay settled bets through the current calibration map to estimate what
win rate / ROI WOULD have been if picks were filtered on calibrated probability
and the 4% edge threshold, instead of the raw probability used at prediction time.

This does NOT change any stored data. It's a read-only simulation for decision-making.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.probability_calibrator import _normalize_market, _normalize_probability, calibrate
from src.utils import data_path

MIN_EDGE = {"moneyline": 0.04, "yrfi": 0.06}


def implied_prob_from_odds(odds: float) -> float | None:
    if odds is None:
        return None
    if odds > 0:
        return 100.0 / (odds + 100.0)
    return -odds / (-odds + 100.0)


def main() -> None:
    sqlite_path = data_path("state.sqlite")
    if not sqlite_path.exists():
        raise SystemExit(f"SQLite database not found: {sqlite_path}")

    conn = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only = ON")
    conn.row_factory = sqlite3.Row

    results: dict[str, dict] = {
        "moneyline": {"taken": 0, "would_skip": 0, "wins": 0, "losses": 0, "pl": 0.0, "staked": 0.0},
        "yrfi": {"taken": 0, "would_skip": 0, "wins": 0, "losses": 0, "pl": 0.0, "staked": 0.0},
    }

    try:
        rows = conn.execute(
            """
            SELECT market, model_prob, fair_prob, odds, result, units_pl, units_staked
            FROM bet_ledger
            WHERE status = 'settled' AND result IN ('win','loss')
            """
        )

        for row in rows:
            market = _normalize_market(row["market"])
            if market not in results:
                continue

            raw_prob = _normalize_probability(row["model_prob"])
            if raw_prob is None:
                continue

            calibrated = calibrate(raw_prob, market=market)

            implied = _normalize_probability(row["fair_prob"])
            if implied is None:
                implied = implied_prob_from_odds(row["odds"]) if row["odds"] else None
            if implied is None:
                continue

            calibrated_edge = calibrated - implied
            bucket = results[market]
            if calibrated_edge < MIN_EDGE.get(market, 0.04):
                bucket["would_skip"] += 1
                continue

            bucket["taken"] += 1
            won = str(row["result"]).lower() == "win"
            bucket["wins" if won else "losses"] += 1
            bucket["pl"] += float(row["units_pl"] or 0.0)
            bucket["staked"] += float(row["units_staked"] or 0.0)
    finally:
        conn.close()

    print("=== Replay: what if calibrated probability had gated picks ===\n")
    for market, r in results.items():
        total = r["taken"]
        win_rate = (r["wins"] / total * 100) if total else 0.0
        roi = (r["pl"] / r["staked"] * 100) if r["staked"] else 0.0
        print(f"{market.upper()}")
        print(f"  Would have taken: {total} (skipped {r['would_skip']} as below edge threshold)")
        print(f"  Win rate: {win_rate:.1f}%")
        print(f"  ROI: {roi:+.1f}%")
        print()


if __name__ == "__main__":
    main()
