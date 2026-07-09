#!/usr/bin/env python3
"""Retrospective report on feature fallbacks (Stage 4).

Reads data/state.sqlite (tables ``picks`` and ``bet_ledger``) and reports:

  1. The percentage of picks that hit a fallback for each tracked feature
     (offense/first-inning scoring, pitcher score, bullpen fatigue, platoon
     split, leadoff OBP, team strength).
  2. Calibration & ROI for CLEAN picks (no fallback) vs. picks that used at
     least one fallback, using settled rows in ``bet_ledger``.

This is READ-ONLY: it never writes stored data or changes any production
output. It only makes sense once the Stage 2-3 instrumentation has populated
``feature_fallback_count`` / ``fallback_features_used`` for a few new slates —
rows written before the instrumentation store NULL and are reported separately
as "uninstrumented" so they never pollute the clean-vs-fallback comparison.

Run:
    node scripts/run_python.js scripts/analyze_feature_fallbacks.py
    node scripts/run_python.js scripts/analyze_feature_fallbacks.py --json
    node scripts/run_python.js scripts/analyze_feature_fallbacks.py --db data/state.sqlite
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = PROJECT_ROOT / "data" / "state.sqlite"

# Minimum settled bets required in a group before ROI/calibration is treated as
# meaningful. Below this we still print the numbers but flag them as low-sample.
MIN_GROUP_SAMPLE = 10

# Calibration buckets by model probability (percentage points).
CALIBRATION_BUCKETS = [(50, 55), (55, 60), (60, 65), (65, 70), (70, 101)]


def _parse_features(raw: Any) -> list[str]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    return [str(item) for item in value] if isinstance(value, list) else []


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def _has_columns(conn: sqlite3.Connection, table: str, columns: set[str]) -> bool:
    present = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    return columns.issubset(present)


def _pct(part: int, whole: int) -> float:
    return (100.0 * part / whole) if whole else 0.0


def feature_fallback_rates(conn: sqlite3.Connection) -> dict[str, Any]:
    """Percentage of instrumented picks that hit a fallback per feature."""
    rows = conn.execute(
        "SELECT feature_fallback_count, fallback_features_used FROM picks"
    ).fetchall()

    total = len(rows)
    instrumented = [r for r in rows if r["feature_fallback_count"] is not None]
    uninstrumented = total - len(instrumented)

    any_fallback = 0
    feature_counter: Counter[str] = Counter()
    for r in instrumented:
        features = _parse_features(r["fallback_features_used"])
        if features or (r["feature_fallback_count"] or 0) > 0:
            any_fallback += 1
        for feat in set(features):
            feature_counter[feat] += 1

    per_feature = {
        feat: {
            "picks_with_fallback": count,
            "pct_of_instrumented": round(_pct(count, len(instrumented)), 2),
        }
        for feat, count in sorted(feature_counter.items(), key=lambda kv: -kv[1])
    }

    return {
        "total_picks": total,
        "instrumented_picks": len(instrumented),
        "uninstrumented_picks": uninstrumented,
        "picks_with_any_fallback": any_fallback,
        "pct_with_any_fallback": round(_pct(any_fallback, len(instrumented)), 2),
        "per_feature": per_feature,
    }


def _roi(rows: list[sqlite3.Row]) -> dict[str, Any]:
    n = len(rows)
    wins = sum(1 for r in rows if r["result"] == "win")
    losses = sum(1 for r in rows if r["result"] == "loss")
    pushes = sum(1 for r in rows if r["result"] == "push")
    staked = sum(float(r["units_staked"] or 0.0) for r in rows)
    pl = sum(float(r["units_pl"] or 0.0) for r in rows)
    clv_vals = [float(r["clv"]) for r in rows if r["clv"] is not None]
    decided = wins + losses
    return {
        "settled_bets": n,
        "wins": wins,
        "losses": losses,
        "pushes": pushes,
        "win_rate_pct": round(_pct(wins, decided), 2) if decided else 0.0,
        "units_staked": round(staked, 3),
        "units_pl": round(pl, 3),
        "roi_pct": round(_pct(pl, staked), 2) if staked else 0.0,
        "avg_clv": round(sum(clv_vals) / len(clv_vals), 4) if clv_vals else None,
        "low_sample": decided < MIN_GROUP_SAMPLE,
    }


def _calibration(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    table = []
    for low, high in CALIBRATION_BUCKETS:
        bucket = [
            r
            for r in rows
            if r["model_prob"] is not None
            and low <= float(r["model_prob"]) < high
            and r["result"] in ("win", "loss")
        ]
        wins = sum(1 for r in bucket if r["result"] == "win")
        table.append(
            {
                "bucket": f"{low}-{high if high <= 100 else 100}%",
                "n": len(bucket),
                "predicted_mid_pct": (low + min(high, 100)) / 2,
                "actual_win_pct": round(_pct(wins, len(bucket)), 2) if bucket else None,
            }
        )
    return table


def clean_vs_fallback(conn: sqlite3.Connection) -> dict[str, Any]:
    """Compare settled bets with NO fallback vs. at least one fallback."""
    rows = conn.execute(
        """
        SELECT model_prob, edge, units_staked, units_pl, clv, result,
               feature_fallback_count, fallback_features_used
        FROM bet_ledger
        WHERE status = 'settled'
        """
    ).fetchall()

    instrumented = [r for r in rows if r["feature_fallback_count"] is not None]
    uninstrumented = [r for r in rows if r["feature_fallback_count"] is None]

    clean = [r for r in instrumented if (r["feature_fallback_count"] or 0) == 0]
    fallback = [r for r in instrumented if (r["feature_fallback_count"] or 0) > 0]

    return {
        "settled_total": len(rows),
        "settled_instrumented": len(instrumented),
        "settled_uninstrumented": len(uninstrumented),
        "clean": {
            "roi": _roi(clean),
            "calibration": _calibration(clean),
        },
        "fallback": {
            "roi": _roi(fallback),
            "calibration": _calibration(fallback),
        },
        "enough_data_for_comparison": (
            len(clean) >= MIN_GROUP_SAMPLE and len(fallback) >= MIN_GROUP_SAMPLE
        ),
    }


def build_report(db_path: Path) -> dict[str, Any]:
    if not db_path.exists():
        raise FileNotFoundError(f"database not found: {db_path}")
    conn = _connect(db_path)
    try:
        required = {"feature_fallback_count", "fallback_features_used"}
        if not _has_columns(conn, "picks", required) or not _has_columns(
            conn, "bet_ledger", required
        ):
            return {
                "error": (
                    "fallback columns missing — run the bot once so storage.js "
                    "applies the Stage 3 migration, then re-run this script."
                )
            }
        return {
            "db": str(db_path),
            "feature_fallback_rates": feature_fallback_rates(conn),
            "clean_vs_fallback": clean_vs_fallback(conn),
        }
    finally:
        conn.close()


def _print_human(report: dict[str, Any]) -> None:
    if "error" in report:
        print(f"ERROR: {report['error']}")
        return

    rates = report["feature_fallback_rates"]
    print("=" * 68)
    print("FEATURE FALLBACK RETROSPECTIVE")
    print("=" * 68)
    print(f"DB: {report['db']}")
    print()
    print(
        f"Picks: {rates['total_picks']} total | "
        f"{rates['instrumented_picks']} instrumented | "
        f"{rates['uninstrumented_picks']} pre-instrumentation (NULL)"
    )
    if rates["instrumented_picks"] == 0:
        print(
            "\nNo instrumented picks yet. Let Stage 2-3 run for a few slates "
            "before interpreting this report."
        )
    else:
        print(
            f"Picks with ANY fallback: {rates['picks_with_any_fallback']} "
            f"({rates['pct_with_any_fallback']}% of instrumented)"
        )
        print("\nPer-feature fallback rate (% of instrumented picks):")
        if not rates["per_feature"]:
            print("  (none recorded)")
        for feat, info in rates["per_feature"].items():
            print(
                f"  {feat:<38} {info['picks_with_fallback']:>5}  "
                f"{info['pct_of_instrumented']:>6}%"
            )

    cvf = report["clean_vs_fallback"]
    print()
    print("-" * 68)
    print("CLEAN (no fallback) vs. FALLBACK — settled bets")
    print("-" * 68)
    print(
        f"Settled: {cvf['settled_total']} total | "
        f"{cvf['settled_instrumented']} instrumented | "
        f"{cvf['settled_uninstrumented']} pre-instrumentation (NULL)"
    )
    if not cvf["enough_data_for_comparison"]:
        print(
            f"\n[low sample] Need >= {MIN_GROUP_SAMPLE} settled bets in BOTH "
            "groups for a reliable comparison. Numbers below are provisional."
        )

    for label in ("clean", "fallback"):
        roi = cvf[label]["roi"]
        print(f"\n  {label.upper()}:")
        print(
            f"    settled={roi['settled_bets']} W-L-P={roi['wins']}-{roi['losses']}-{roi['pushes']} "
            f"win%={roi['win_rate_pct']} roi%={roi['roi_pct']} "
            f"units_pl={roi['units_pl']} avg_clv={roi['avg_clv']}"
        )
        print("    calibration (predicted -> actual win%):")
        for row in cvf[label]["calibration"]:
            actual = "  n/a" if row["actual_win_pct"] is None else f"{row['actual_win_pct']:>5}%"
            print(f"      {row['bucket']:<9} n={row['n']:<4} actual={actual}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=str(DEFAULT_DB), help="path to state.sqlite")
    parser.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    args = parser.parse_args(argv)

    try:
        report = build_report(Path(args.db))
    except FileNotFoundError as exc:
        print(json.dumps({"error": str(exc)}) if args.json else f"ERROR: {exc}")
        return 1

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        _print_human(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
