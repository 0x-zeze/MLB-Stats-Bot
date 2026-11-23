#!/usr/bin/env python3
"""Run the Phase 4 head-to-head Shadow Tournament report on the read-only SQLite DB."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.eval.shadow_tournament import (
    DEFAULT_MIN_BOOTSTRAP_PROB_BETTER,
    DEFAULT_MIN_CLV_GAMES,
    DEFAULT_MIN_COMMON_GAMES,
    evaluate_shadow_tournament_db,
)


def _fmt(val: float | None, digits: int = 4) -> str:
    if val is None:
        return "-"
    return f"{val:.{digits}f}"


def _print_report(report: dict[str, Any]) -> None:
    print("=== MLB Shadow Tournament Report ===")
    print(
        f"Verdict: {report['verdict']} | Common Games: {report['common_games']} / {report['min_common_games']} "
        f"(all-models intersection: {report.get('all_models_common_games', 0)})"
    )
    print(
        f"Winner: {report.get('winner_model_id') or '-'} | "
        f"Rule Simplification Eligible: {report['rule_simplification_eligible']} | "
        f"Recommended Rule Profile: {report['recommended_rule_profile']}"
    )
    if report.get("reasons"):
        print(f"Reasons: {', '.join(report['reasons'])}")

    leaderboard = report.get("leaderboard") or []
    if leaderboard:
        print("\nLeaderboard (sorted by Log-Loss, then Brier):")
        print(f"{'Model':<26} {'N':>5} {'Brier':>9} {'LogLoss':>9} {'ECE':>8} {'Acc':>8} {'CLV':>9} {'CLV_N':>6}")
        for row in leaderboard:
            acc = f"{row['accuracy'] * 100:.1f}%" if row.get("accuracy") is not None else "-"
            clv = f"{row['mean_clv'] * 100:+.2f}%" if row.get("mean_clv") is not None else "-"
            print(
                f"{row['model_id']:<26} {row.get('n', 0):>5} "
                f"{_fmt(row.get('brier'), 5):>9} {_fmt(row.get('log_loss'), 5):>9} "
                f"{_fmt(row.get('ece'), 4):>8} {acc:>8} {clv:>9} {row.get('clv_n', 0):>6}"
            )
    else:
        print("\nNo settled common games recorded yet. Run the bot live to accumulate shadow history.")

    comparisons = report.get("comparisons") or {}
    if comparisons:
        print("\nChallenger Promotion Gates:")
        for cid, comp in comparisons.items():
            status = "PASS" if comp.get("passed_promotion_gate") else "HOLD"
            print(
                f"- {cid}: {status} (n={comp.get('common_games', 0)}, "
                f"dBrier_mkt={_fmt(comp.get('brier_gain_vs_market'), 5)}, "
                f"dLL_mkt={_fmt(comp.get('logloss_gain_vs_market'), 5)})"
            )
            for fail in comp.get("gate_failures") or []:
                print(f"    gate: {fail}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate MLB shadow tournament (read-only SQLite).")
    parser.add_argument("--db", default=str(PROJECT_ROOT / "data" / "state.sqlite"), help="Path to SQLite DB")
    parser.add_argument("--min-games", type=int, default=DEFAULT_MIN_COMMON_GAMES)
    parser.add_argument("--min-clv-games", type=int, default=DEFAULT_MIN_CLV_GAMES)
    parser.add_argument("--min-bootstrap", type=float, default=DEFAULT_MIN_BOOTSTRAP_PROB_BETTER)
    parser.add_argument("--no-require-clv", action="store_true", help="Do not require positive CLV gate")
    parser.add_argument("--out", default="", help="Optional path to save JSON report")
    parser.add_argument("--json", action="store_true", help="Emit JSON output")
    args = parser.parse_args()

    db_file = Path(args.db)
    if not db_file.exists():
        err = {"status": "error", "error": f"SQLite database not found: {args.db}"}
        print(json.dumps(err, indent=2) if args.json else f"ERROR: {err['error']}")
        return 1

    report = evaluate_shadow_tournament_db(
        str(db_file),
        min_common_games=args.min_games,
        min_clv_games=args.min_clv_games,
        min_bootstrap_prob_better=args.min_bootstrap,
        require_positive_clv=not args.no_require_clv,
    )
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")

    if args.json:
        print(json.dumps(report, indent=2, default=str))
    else:
        _print_report(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
