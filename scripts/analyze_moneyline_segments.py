#!/usr/bin/env python3
"""Segment-level accuracy & calibration report for settled predictions.

Reads data/evolution/prediction_outcomes.csv (the settled prediction memory,
~900+ moneyline rows) and prints:

  * Moneyline accuracy by bet_decision status (NO BET / LEAN / VALUE), odds side,
    edge band, predicted-probability band, and starter tier.
  * A CALIBRATION table (predicted probability bucket vs. actual win rate) that
    surfaces overconfidence.
  * A First-Inning (YRFI/NRFI) YES-vs-NO directional accuracy split.

This is READ-ONLY: it never writes stored data or changes any production output.
Use it to decide which rule candidates / recalibration are worth proposing
through the promotion gate.

Run:
    node scripts/run_python.js scripts/analyze_moneyline_segments.py
    node scripts/run_python.js scripts/analyze_moneyline_segments.py --json
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.utils import data_path  # noqa: E402


def _load_rows(csv_path: Path) -> list[dict]:
    rows: list[dict] = []
    with open(csv_path, newline="") as handle:
        for raw in csv.DictReader(handle):
            try:
                ev = json.loads(raw.get("evaluation_json") or "{}")
            except (json.JSONDecodeError, TypeError):
                ev = {}
            rows.append(ev)
    return rows


def _acc(sub: list[dict], correct_key: str) -> tuple[int, int, float]:
    n = len(sub)
    w = sum(1 for r in sub if r.get(correct_key))
    return n, w, (100.0 * w / n if n else 0.0)


def _fmt(sub: list[dict], correct_key: str) -> str:
    n, w, a = _acc(sub, correct_key)
    return f"{w}/{n} = {a:.1f}%" if n else "n=0"


def _bet_status(row: dict) -> str:
    bd = row.get("bet_decision")
    if isinstance(bd, dict):
        return str(bd.get("status") or "NONE")
    return "NONE"


def _bet_odds(row: dict):
    bd = row.get("bet_decision")
    if isinstance(bd, dict):
        return bd.get("odds")
    return None


def _edge_band(edge) -> str:
    e = abs(edge)
    if e < 2:
        return "0-2%"
    if e < 4:
        return "2-4%"
    if e < 6:
        return "4-6%"
    if e < 8:
        return "6-8%"
    return "8%+"


def _prob_band(p) -> str:
    if p is None:
        return "NA"
    if p < 50:
        return "<50 (pick underdog)"
    if p < 53:
        return "50-53"
    if p < 56:
        return "53-56"
    if p < 60:
        return "56-60"
    return "60%+"


def analyze(rows: list[dict]) -> dict:
    ml = [
        r
        for r in rows
        if r.get("market") == "moneyline" and r.get("moneyline_correct") is not None
    ]
    report: dict = {"moneyline_total": _acc(ml, "moneyline_correct")}

    def group(keyfn) -> dict[str, list[dict]]:
        g: dict[str, list[dict]] = defaultdict(list)
        for r in ml:
            g[keyfn(r)].append(r)
        return g

    report["by_status"] = {
        k: _acc(v, "moneyline_correct") for k, v in group(_bet_status).items()
    }
    report["by_odds_side"] = {
        k: _acc(v, "moneyline_correct")
        for k, v in group(
            lambda r: "NA"
            if _bet_odds(r) is None
            else ("favorite" if _bet_odds(r) < 0 else "underdog")
        ).items()
    }
    report["by_edge_band"] = {
        k: _acc(v, "moneyline_correct")
        for k, v in group(
            lambda r: _edge_band(r["edge"]) if r.get("edge") is not None else "NA"
        ).items()
    }
    report["by_prob_band"] = {
        k: _acc(v, "moneyline_correct")
        for k, v in group(lambda r: _prob_band(r.get("predicted_probability"))).items()
    }
    report["by_starter_tier"] = {
        k: _acc(v, "moneyline_correct")
        for k, v in group(lambda r: str(r.get("segment_starter_tier"))).items()
    }

    # Calibration: predicted-probability 5-point buckets vs actual win rate.
    cal: dict[str, dict] = {}
    cg: dict[int, list[dict]] = defaultdict(list)
    for r in ml:
        p = r.get("predicted_probability")
        if p is None:
            continue
        cg[int(p // 5) * 5].append(r)
    for lo in sorted(cg):
        n, w, a = _acc(cg[lo], "moneyline_correct")
        cal[f"{lo}-{lo + 5}"] = {
            "n": n,
            "actual_win_pct": round(a, 1),
            "overconfident": lo >= 55 and a < lo,
        }
    report["calibration"] = cal

    # First inning YRFI/NRFI directional split.
    yr = [
        r
        for r in rows
        if r.get("market") == "yrfi" and r.get("yrfi_nrfi_correct") is not None
    ]

    def yrfi_dir(r: dict) -> str:
        p = str(r.get("prediction", "")).upper()
        if "YES" in p or "YRFI" in p:
            return "YES"
        if "NO" in p or "NRFI" in p:
            return "NO"
        return "OTHER"

    yg: dict[str, list[dict]] = defaultdict(list)
    for r in yr:
        yg[yrfi_dir(r)].append(r)
    report["yrfi_total"] = _acc(yr, "yrfi_nrfi_correct")
    report["yrfi_by_direction"] = {
        k: _acc(v, "yrfi_nrfi_correct") for k, v in yg.items()
    }
    return report


def _print_group(title: str, group: dict[str, tuple[int, int, float]], order=None) -> None:
    print(f"\n{title}")
    keys = order or sorted(group, key=lambda k: -group[k][0])
    for k in keys:
        if k not in group:
            continue
        n, w, a = group[k]
        if n:
            print(f"  {k:22s}: {w}/{n} = {a:.1f}%")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--csv",
        default=str(data_path("evolution/prediction_outcomes.csv")),
        help="Path to prediction_outcomes.csv",
    )
    parser.add_argument("--json", action="store_true", help="Emit raw JSON only.")
    args = parser.parse_args()

    csv_path = Path(args.csv)
    if not csv_path.exists():
        print(f"ERROR: not found: {csv_path}", file=sys.stderr)
        return 2

    rows = _load_rows(csv_path)
    report = analyze(rows)

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0

    n, w, a = report["moneyline_total"]
    print("=" * 60)
    print(f"MONEYLINE overall accuracy: {w}/{n} = {a:.1f}%")
    print("=" * 60)
    _print_group("By bet decision status:", report["by_status"])
    _print_group("By odds side:", report["by_odds_side"])
    _print_group(
        "By edge band:", report["by_edge_band"], order=["0-2%", "2-4%", "4-6%", "6-8%", "8%+"]
    )
    _print_group(
        "By predicted-probability band:",
        report["by_prob_band"],
        order=["<50 (pick underdog)", "50-53", "53-56", "56-60", "60%+", "NA"],
    )
    _print_group("By starter tier:", report["by_starter_tier"])

    print("\nCALIBRATION (predicted prob bucket -> actual win rate):")
    for bucket, info in report["calibration"].items():
        flag = "  <-- OVERCONFIDENT" if info["overconfident"] else ""
        print(f"  pred {bucket}%: actual {info['actual_win_pct']:.0f}% (n={info['n']}){flag}")

    yn, yw, ya = report["yrfi_total"]
    print(f"\nFIRST INNING (YRFI) overall: {yw}/{yn} = {ya:.1f}%")
    _print_group("  By direction:", report["yrfi_by_direction"], order=["YES", "NO", "OTHER"])
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
