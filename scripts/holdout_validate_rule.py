#!/usr/bin/env python3
"""Holdout validation for js.value_profile (HOME-scoped empirical value gate).

Reconstructs the rule filter from live SQLite picks payloads:

  side == home
  abs(modelBreakdown.rawEdge) in [min_raw_edge, max_raw_edge]   (default 0.5..1.0)
  odds in [min_odds, max_odds]                                   (default -160..-110)

Splits graded moneyline history into:
  - before / derive window: dates used to *find* the rule (default 2026-04-28..2026-07-29)
  - after / holdout window: dates strictly after derive_end

Grading prefers game_outcomes.winner_team_id, then prediction_outcomes.csv.

This is READ-ONLY. It does not change rules or production state.

Run:
  node scripts/run_python.js scripts/holdout_validate_rule.py
  node scripts/run_python.js scripts/holdout_validate_rule.py --json
  node scripts/run_python.js scripts/holdout_validate_rule.py --derive-end 2026-07-29
"""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.utils import data_path

# Defaults match data/rules/moneyline_rules.json js.value_profile + PROGRESS.md notes.
DEFAULT_DERIVE_START = "2026-04-28"
DEFAULT_DERIVE_END = "2026-07-29"
DEFAULT_MIN_RAW_EDGE = 0.5
DEFAULT_MAX_RAW_EDGE = 1.0
DEFAULT_MIN_ODDS = -160.0
DEFAULT_MAX_ODDS = -110.0
# Rough break-even band for favorites in -160..-110 (risking 1u).
BREAK_EVEN_WR_LO = 0.55
BREAK_EVEN_WR_HI = 0.58
MIN_HOLD_OUT_N = 30


def _load_rules_params(rules_path: Path) -> dict[str, Any]:
    if not rules_path.exists():
        return {}
    try:
        catalog = json.loads(rules_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    for rule in catalog.get("rules") or []:
        if rule.get("id") == "js.value_profile":
            params = dict(rule.get("params") or {})
            engines = rule.get("engines") or []
            params["_engines"] = list(engines)
            # Live only when JS-scoped and not explicitly disabled.
            params["_live"] = "js" in engines and rule.get("enabled") is not False
            return params
    return {}


def _american_pl(odds: float, won: bool) -> float:
    if won:
        if odds < 0:
            return 100.0 / abs(odds)
        return odds / 100.0
    return -1.0


def _extract_side_raw_odds(payload: dict[str, Any], row: sqlite3.Row) -> tuple[str | None, float | None, float | None, Any]:
    mb = payload.get("modelBreakdown") or {}
    if not isinstance(mb, dict):
        mb = {}
    raw = mb.get("rawEdge")
    pick = payload.get("pick") or {}
    if not isinstance(pick, dict):
        pick = {}
    pick_id = pick.get("id") if pick.get("id") is not None else row["pick_team_id"]
    home = payload.get("home") or {}
    if not isinstance(home, dict):
        home = {}
    home_id = home.get("id") if home.get("id") is not None else row["home_team_id"]
    side = None
    if pick_id is not None and home_id is not None:
        side = "home" if str(pick_id) == str(home_id) else "away"

    odds = None
    co = payload.get("currentOdds") or {}
    if isinstance(co, dict) and side is not None and co.get(side) is not None:
        odds = co.get(side)
    bd = payload.get("betDecision") or {}
    if odds is None and isinstance(bd, dict) and bd.get("odds") is not None:
        if bd.get("side") in (None, side) or str(bd.get("teamId") or "") == str(pick_id or ""):
            odds = bd.get("odds")
    mvo = payload.get("moneylineValueOptions") or []
    if odds is None and isinstance(mvo, list):
        for opt in mvo:
            if not isinstance(opt, dict):
                continue
            if opt.get("side") == side or str(opt.get("teamId") or opt.get("id") or "") == str(pick_id):
                if opt.get("odds") is not None:
                    odds = opt.get("odds")
                    break

    try:
        raw_f = abs(float(raw)) if raw is not None else None
    except (TypeError, ValueError):
        raw_f = None
    try:
        odds_f = float(odds) if odds is not None else None
    except (TypeError, ValueError):
        odds_f = None
    return side, raw_f, odds_f, pick_id


def _load_csv_outcomes(csv_path: Path) -> dict[str, dict[str, Any]]:
    if not csv_path.exists():
        return {}
    out: dict[str, dict[str, Any]] = {}
    with csv_path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            if str(row.get("market") or "").lower() != "moneyline":
                continue
            if str(row.get("result") or "").lower() not in {"win", "loss"}:
                continue
            gid = str(row.get("game_id") or "")
            if gid:
                out[gid] = row
    return out


def build_records(
    sqlite_path: Path,
    outcomes_csv: Path,
) -> list[dict[str, Any]]:
    conn = sqlite3.connect(str(sqlite_path))
    conn.row_factory = sqlite3.Row
    try:
        picks = list(
            conn.execute(
                """
                SELECT game_pk, date_ymd, matchup, home_team_id, away_team_id,
                       pick_team_id, payload
                FROM picks
                """
            )
        )
        game_outcomes = {
            str(row["game_pk"]): row
            for row in conn.execute(
                """
                SELECT game_pk, winner_team_id, home_team_id, away_team_id
                FROM game_outcomes
                WHERE winner_team_id IS NOT NULL
                """
            )
        }
    finally:
        conn.close()

    csv_outcomes = _load_csv_outcomes(outcomes_csv)
    records: list[dict[str, Any]] = []
    for row in picks:
        try:
            payload = json.loads(row["payload"] or "{}")
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        side, raw_edge, odds, pick_id = _extract_side_raw_odds(payload, row)
        if side is None or raw_edge is None or odds is None:
            continue
        # Guard against garbage snapshot prices.
        if odds > 500 or odds < -500:
            continue

        gid = str(row["game_pk"])
        result = None
        profit_loss = None
        go = game_outcomes.get(gid)
        if go is not None and pick_id is not None:
            result = "win" if str(go["winner_team_id"]) == str(pick_id) else "loss"
            profit_loss = _american_pl(odds, result == "win")
        elif gid in csv_outcomes:
            result = str(csv_outcomes[gid].get("result") or "").lower()
            if result in {"win", "loss"}:
                profit_loss = _american_pl(odds, result == "win")

        records.append(
            {
                "game_pk": gid,
                "date": row["date_ymd"] or "",
                "matchup": row["matchup"] or "",
                "side": side,
                "raw_edge": raw_edge,
                "odds": odds,
                "result": result,
                "profit_loss": profit_loss,
            }
        )
    return records


def in_value_profile(
    rec: dict[str, Any],
    *,
    scope_side: str,
    min_raw_edge: float,
    max_raw_edge: float,
    min_odds: float,
    max_odds: float,
) -> bool:
    if rec["side"] != scope_side:
        return False
    if not (min_raw_edge <= rec["raw_edge"] <= max_raw_edge):
        return False
    if not (min_odds <= rec["odds"] <= max_odds):
        return False
    return True


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    graded = [r for r in rows if r.get("result") in {"win", "loss"}]
    wins = sum(1 for r in graded if r["result"] == "win")
    losses = len(graded) - wins
    pl = sum(float(r["profit_loss"] or 0.0) for r in graded)
    staked = float(len(graded)) if graded else 0.0
    win_rate = (wins / len(graded)) if graded else None
    roi = (pl / staked) if staked else None
    dates = sorted(r["date"] for r in graded if r.get("date"))
    return {
        "n": len(graded),
        "wins": wins,
        "losses": losses,
        "win_rate": win_rate,
        "roi": roi,
        "total_pl_units": pl if graded else 0.0,
        "date_start": dates[0] if dates else None,
        "date_end": dates[-1] if dates else None,
    }


def verdict_for_holdout(holdout: dict[str, Any]) -> dict[str, Any]:
    n = int(holdout.get("n") or 0)
    wr = holdout.get("win_rate")
    roi = holdout.get("roi")
    reasons: list[str] = []
    status = "unproven"

    if n < MIN_HOLD_OUT_N:
        reasons.append(
            f"holdout n={n} < {MIN_HOLD_OUT_N}; sample too small to confirm the rule"
        )
        status = "unproven_disable_candidate"
    if wr is None:
        reasons.append("no graded holdout rows")
        status = "unproven_disable_candidate"
    else:
        if wr < BREAK_EVEN_WR_LO:
            reasons.append(
                f"holdout win_rate {wr:.1%} below ~break-even band "
                f"{BREAK_EVEN_WR_LO:.0%}-{BREAK_EVEN_WR_HI:.0%} for -160..-110 favorites"
            )
            status = "unproven_disable_candidate"
        elif wr < BREAK_EVEN_WR_HI and n < MIN_HOLD_OUT_N:
            reasons.append(
                f"holdout win_rate {wr:.1%} only in break-even zone with small n"
            )
        elif wr >= BREAK_EVEN_WR_HI and n >= MIN_HOLD_OUT_N:
            reasons.append(
                f"holdout win_rate {wr:.1%} with n={n} clears break-even band; keep watching"
            )
            status = "holds_for_now"
        else:
            reasons.append(
                f"holdout win_rate {wr:.1%} with n={n}; not enough evidence to promote"
            )
            if status == "unproven":
                status = "unproven_disable_candidate"

    if roi is not None and roi < 0 and n >= 10:
        reasons.append(f"holdout ROI {roi:.1%} is negative")
        if status == "holds_for_now":
            status = "unproven_disable_candidate"

    return {
        "status": status,
        "reasons": reasons,
        "break_even_wr_band": [BREAK_EVEN_WR_LO, BREAK_EVEN_WR_HI],
        "min_holdout_n": MIN_HOLD_OUT_N,
        "recommendation": (
            "Flag js.value_profile as unproven; disable or keep off promotion path "
            "until holdout n and WR clear thresholds."
            if status == "unproven_disable_candidate"
            else (
                "Holdout does not kill the rule yet; re-run as data accumulates. "
                "Still not a multi-season proof."
                if status == "holds_for_now"
                else "Insufficient evidence."
            )
        ),
    }


def analyze(
    *,
    sqlite_path: Path,
    outcomes_csv: Path,
    rules_path: Path,
    derive_start: str,
    derive_end: str,
    min_raw_edge: float | None = None,
    max_raw_edge: float | None = None,
    min_odds: float | None = None,
    max_odds: float | None = None,
    scope_side: str = "home",
) -> dict[str, Any]:
    params = _load_rules_params(rules_path)
    scope_side = str(params.get("scope_side") or scope_side)
    min_raw_edge = float(params.get("min_raw_edge", min_raw_edge if min_raw_edge is not None else DEFAULT_MIN_RAW_EDGE))
    max_raw_edge = float(params.get("max_raw_edge", max_raw_edge if max_raw_edge is not None else DEFAULT_MAX_RAW_EDGE))
    min_odds = float(params.get("min_odds", min_odds if min_odds is not None else DEFAULT_MIN_ODDS))
    max_odds = float(params.get("max_odds", max_odds if max_odds is not None else DEFAULT_MAX_ODDS))

    records = build_records(sqlite_path, outcomes_csv)
    profile = [
        r
        for r in records
        if in_value_profile(
            r,
            scope_side=scope_side,
            min_raw_edge=min_raw_edge,
            max_raw_edge=max_raw_edge,
            min_odds=min_odds,
            max_odds=max_odds,
        )
    ]
    graded = [r for r in profile if r.get("result") in {"win", "loss"}]
    in_sample = [r for r in graded if derive_start <= r["date"] <= derive_end]
    holdout = [r for r in graded if r["date"] > derive_end]
    pre_start = [r for r in graded if r["date"] and r["date"] < derive_start]

    in_stats = summarize(in_sample)
    out_stats = summarize(holdout)
    all_stats = summarize(graded)
    verdict = verdict_for_holdout(out_stats)

    # Claimed derivation numbers from rule notes / PROGRESS (not re-fit here).
    claimed = {
        "n": 127,
        "win_rate": 0.646,
        "roi": 0.089,
        "universe_n": 1168,
        "universe_dates": "2026-04-28..2026-07-29",
        "note": (
            "Claimed in-sample metrics from rule notes. Reconstructable graded "
            "rows in SQLite+CSV may be lower if rawEdge/odds were not persisted "
            "on older picks."
        ),
    }

    reproducibility = {
        "claimed_n": claimed["n"],
        "reconstructed_in_sample_n": in_stats["n"],
        "reconstructed_in_sample_win_rate": in_stats["win_rate"],
        "reconstructed_in_sample_roi": in_stats["roi"],
        "matches_claimed_n": in_stats["n"] == claimed["n"],
        "matches_claimed_wr_within_3pt": (
            in_stats["win_rate"] is not None
            and abs(in_stats["win_rate"] - claimed["win_rate"]) <= 0.03
        ),
    }

    return {
        "rule_id": "js.value_profile",
        "rule_live": bool(params.get("_live")),
        "rule_engines": list(params.get("_engines") or []),
        "filter": {
            "scope_side": scope_side,
            "min_raw_edge": min_raw_edge,
            "max_raw_edge": max_raw_edge,
            "min_odds": min_odds,
            "max_odds": max_odds,
        },
        "windows": {
            "derive_start": derive_start,
            "derive_end": derive_end,
            "holdout": f">{derive_end} exclusive end → present",
        },
        "coverage": {
            "records_with_side_raw_odds": len(records),
            "in_profile": len(profile),
            "in_profile_graded": len(graded),
            "graded_before_derive_start": len(pre_start),
        },
        "claimed_in_sample": claimed,
        "in_sample": in_stats,
        "holdout": out_stats,
        "all_graded_in_profile": all_stats,
        "reproducibility": reproducibility,
        "verdict": verdict,
    }


def _pct(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value * 100:.1f}%"


def _print_report(report: dict[str, Any]) -> None:
    f = report["filter"]
    print("=" * 64)
    print("js.value_profile holdout validation")
    print("=" * 64)
    live = report.get("rule_live")
    if live is False:
        print("NOTE: rule is DISABLED in moneyline_rules.json (enabled:false).")
        print("      This script still scores the *filter* on history for research.")
    print(
        f"Filter: side={f['scope_side']} rawEdge=[{f['min_raw_edge']},{f['max_raw_edge']}] "
        f"odds=[{f['min_odds']},{f['max_odds']}]"
    )
    w = report["windows"]
    print(f"Derive window: {w['derive_start']} .. {w['derive_end']} (inclusive)")
    print(f"Holdout: dates > {w['derive_end']}")
    c = report["coverage"]
    print(
        f"Coverage: records_with_side_raw_odds={c['records_with_side_raw_odds']} "
        f"in_profile={c['in_profile']} graded={c['in_profile_graded']}"
    )
    print()
    claimed = report["claimed_in_sample"]
    print(
        f"CLAIMED in-sample: n={claimed['n']} WR={_pct(claimed['win_rate'])} "
        f"ROI={_pct(claimed['roi'])} (universe {claimed['universe_n']} picks "
        f"{claimed['universe_dates']})"
    )
    ins = report["in_sample"]
    print(
        f"RECONSTRUCTED in-sample: n={ins['n']} W-L={ins['wins']}-{ins['losses']} "
        f"WR={_pct(ins['win_rate'])} ROI={_pct(ins['roi'])} "
        f"dates={ins['date_start']}..{ins['date_end']}"
    )
    out = report["holdout"]
    print(
        f"HOLDOUT out-of-sample: n={out['n']} W-L={out['wins']}-{out['losses']} "
        f"WR={_pct(out['win_rate'])} ROI={_pct(out['roi'])} "
        f"dates={out['date_start']}..{out['date_end']}"
    )
    print()
    rep = report["reproducibility"]
    print(
        f"Reproducibility: claimed_n_match={rep['matches_claimed_n']} "
        f"wr_within_3pt={rep['matches_claimed_wr_within_3pt']}"
    )
    v = report["verdict"]
    print(f"Verdict: {v['status']}")
    for reason in v["reasons"]:
        print(f"  - {reason}")
    print(f"Recommendation: {v['recommendation']}")
    print()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", default=str(data_path("state.sqlite")))
    parser.add_argument(
        "--outcomes-csv",
        default=str(data_path("evolution/prediction_outcomes.csv")),
    )
    parser.add_argument(
        "--rules",
        default=str(data_path("rules/moneyline_rules.json")),
    )
    parser.add_argument("--derive-start", default=DEFAULT_DERIVE_START)
    parser.add_argument("--derive-end", default=DEFAULT_DERIVE_END)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    sqlite_path = Path(args.sqlite)
    if not sqlite_path.exists():
        print(f"ERROR: sqlite not found: {sqlite_path}", file=sys.stderr)
        return 2

    report = analyze(
        sqlite_path=sqlite_path,
        outcomes_csv=Path(args.outcomes_csv),
        rules_path=Path(args.rules),
        derive_start=args.derive_start,
        derive_end=args.derive_end,
    )
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        _print_report(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
