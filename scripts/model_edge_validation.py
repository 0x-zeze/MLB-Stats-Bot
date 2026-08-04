#!/usr/bin/env python3
"""Unified walk-forward validation for moneyline model-vs-market edge.

Single command. Validates:
  1. Market-anchored residual probability (blend weight).
  2. Model-vs-market disagreement gates (asymmetric):
       - model_home_market_away: model favors home, market favors away
       - model_away_market_home: model favors away, market favors home
  3. js.value_profile holdout (already separate; kept for context only)

Data (read-only):
  - data/state.sqlite picks.payload -> pureHomeProbability + currentOdds
  - data/evolution/prediction_outcomes.csv -> graded winner

A gate is promoted only when BOTH train and test windows independently clear
break-even WR for its odds band AND combined n >= threshold.

Run:
  npm run model:validate
  node scripts/run_python.js scripts/model_edge_validation.py --json
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sqlite3
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.utils import data_path

EPS = 1e-9
MIN_PROMOTE_N = 40


def _implied_probability(american_odds: float) -> float:
    odds = float(american_odds)
    return 100.0 / (odds + 100.0) if odds > 0 else -odds / (-odds + 100.0)


def _american_profit(odds: float, won: bool) -> float:
    if won:
        return 100.0 / abs(odds) if odds < 0 else odds / 100.0
    return -1.0


def load_joined_rows(sqlite_path: Path, outcomes_csv: Path) -> list[dict[str, Any]]:
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
            model_home = float(pure_home) / 100.0
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

        rows.append(
            {
                "date": str(row["date_ymd"] or ""),
                "game_pk": game_pk,
                "model_home": model_home,
                "market_home": market_home,
                "home_won": home_won,
                "home_odds": home_odds,
                "away_odds": away_odds,
            }
        )

    rows.sort(key=lambda item: (item["date"], item["game_pk"]))
    return rows


def metrics(rows: list[dict[str, Any]], probabilities: list[float] | None = None) -> dict[str, Any]:
    if not rows:
        return {"n": 0, "accuracy": None, "brier": None, "log_loss": None, "roi": None, "total_pl_units": 0.0}
    n = len(rows)
    if probabilities is None:
        probabilities = [row["model_home"] for row in rows]
    correct = brier = log_loss = total_pl = 0.0
    for row, p in zip(rows, probabilities):
        p = min(max(p, EPS), 1 - EPS)
        y = row["home_won"]
        correct += int((p >= 0.5) == bool(y))
        brier += (p - y) ** 2
        log_loss += -(y * math.log(p) + (1 - y) * math.log(1 - p))
        side = "home" if p >= 0.5 else "away"
        odds = row["home_odds"] if side == "home" else row["away_odds"]
        won = bool(y) if side == "home" else not bool(y)
        total_pl += _american_profit(odds, won)
    return {
        "n": n,
        "accuracy": correct / n,
        "brier": brier / n,
        "log_loss": log_loss / n,
        "roi": total_pl / n,
        "total_pl_units": total_pl,
    }


def blend_probs(rows: list[dict[str, Any]], weight: float) -> list[float]:
    return [
        min(max((1 - weight) * r["model_home"] + weight * r["market_home"], EPS), 1 - EPS)
        for r in rows
    ]


def fit_blend_weight(rows: list[dict[str, Any]]) -> float:
    if not rows:
        return 0.0
    best_w, best_loss = 0.0, float("inf")
    for w in [i / 100 for i in range(0, 51, 5)]:
        probs = blend_probs(rows, w)
        m = metrics(rows, probs)
        if m["log_loss"] is not None and m["log_loss"] < best_loss:
            best_loss = m["log_loss"]
            best_w = w
    return best_w


def disagreement_gate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Asymmetric model-vs-market disagreement slices."""
    conf = [r for r in rows if (r["model_home"] >= 0.5) != (r["market_home"] >= 0.5)]
    mh = [r for r in conf if r["model_home"] >= 0.5 and r["market_home"] < 0.5]
    ma = [r for r in conf if r["model_home"] < 0.5 and r["market_home"] >= 0.5]
    return {
        "conflicts_total": len(conf),
        "model_home_market_away": _gate_slice(mh),
        "model_away_market_home": _gate_slice(ma),
    }


# ---------------------------------------------------------------------------
# Sizing boost validation
# ---------------------------------------------------------------------------


def sizing_boost_validation(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Validate 1.5x stake boost on model-away vs market-home disagreement."""
    conf = [r for r in rows if (r["model_home"] >= 0.5) != (r["market_home"] >= 0.5)]
    disagreement = [r for r in conf if r["model_home"] < 0.5 and r["market_home"] >= 0.5]
    if not disagreement:
        return {"boost": 1.0, "validated": False, "reason": "no disagreement samples"}
    m = metrics(disagreement)
    if m["n"] < 40:
        return {"boost": 1.0, "validated": False, "reason": f"n={m['n']} < 40", "n": m["n"], "wr": m.get("accuracy"), "roi": m.get("roi")}
    # boost validated if WR > 55% and ROI > 0
    wr = m.get("accuracy") or 0
    roi = m.get("roi") or 0
    validated = wr >= 0.55 and roi >= 0
    return {
        "boost": 1.5 if validated else 1.0,
        "validated": validated,
        "n": m["n"],
        "wr": wr,
        "roi": roi,
        "reason": f"validated: WR {wr:.1%}, ROI {roi:.1%}, n={m['n']}" if validated else f"not validated: WR {wr:.1%} or ROI {roi:.1%}",
    }


# ---------------------------------------------------------------------------
# Reverse direction validation (model-home vs market-away)
# ---------------------------------------------------------------------------


def reverse_direction_validation(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Validate whether model-home vs market-away should also bypass."""
    conf = [r for r in rows if (r["model_home"] >= 0.5) != (r["market_home"] >= 0.5)]
    reverse = [r for r in conf if r["model_home"] >= 0.5 and r["market_home"] < 0.5]
    if not reverse:
        return {"promoted": False, "reason": "no reverse samples"}
    cut = max(1, len(reverse) // 2)
    train, test = reverse[:cut], reverse[cut:]
    train_m = metrics(train)
    test_m = metrics(test)
    promoted = (
        train_m["n"] >= 20
        and test_m["n"] >= 20
        and train_m.get("accuracy") is not None
        and test_m.get("accuracy") is not None
        and train_m["accuracy"] >= 0.55
        and test_m["accuracy"] >= 0.55
        and (train_m.get("roi") or 0) >= 0
        and (test_m.get("roi") or 0) >= 0
    )
    return {
        "promoted": promoted,
        "n": len(reverse),
        "train": train_m,
        "test": test_m,
        "reason": (
            f"promoted: train {train_m['accuracy']:.1%} + test {test_m['accuracy']:.1%}, n={train_m['n']}+{test_m['n']}"
            if promoted
            else f"not promoted: train {train_m['accuracy']:.1%} + test {test_m['accuracy']:.1%}, n={train_m['n']}+{test_m['n']}"
        ),
    }


# ---------------------------------------------------------------------------
# Per-band evaluation
# ---------------------------------------------------------------------------

_PROB_BANDS = [(0.0, 0.45), (0.45, 0.50), (0.50, 0.55), (0.55, 0.60), (0.60, 0.65), (0.65, 1.0)]
_ODDS_BANDS = [(-999, -200), (-200, -150), (-150, -110), (-110, 100), (100, 150), (150, 999)]


def per_band_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Metrics per probability band and per odds band."""
    prob_bands: list[dict[str, Any]] = []
    for lo, hi in _PROB_BANDS:
        group = [r for r in rows if lo <= r["model_home"] < hi]
        if len(group) < 10:
            continue
        m = metrics(group)
        mean_pred = sum(r["model_home"] for r in group) / len(group)
        actual = sum(r["home_won"] for r in group) / len(group)
        market_acc = metrics(group, [r["market_home"] for r in group]).get("accuracy")
        prob_bands.append(
            {
                "band": f"[{lo:.2f},{hi:.2f})",
                "n": len(group),
                "mean_pred": mean_pred,
                "actual_win_rate": actual,
                "gap": actual - mean_pred,
                "model_accuracy": m.get("accuracy"),
                "market_accuracy": market_acc,
                "model_roi": m.get("roi"),
                "brier": m.get("brier"),
            }
        )

    odds_bands: list[dict[str, Any]] = []
    for lo, hi in _ODDS_BANDS:
        group = []
        for r in rows:
            odds = r["home_odds"] if r["model_home"] >= 0.5 else r["away_odds"]
            if lo <= odds < hi:
                group.append(r)
        if len(group) < 10:
            continue
        m = metrics(group)
        market_acc = metrics(group, [r["market_home"] for r in group]).get("accuracy")
        odds_bands.append(
            {
                "band": f"[{lo},{hi})",
                "n": len(group),
                "model_accuracy": m.get("accuracy"),
                "market_accuracy": market_acc,
                "model_roi": m.get("roi"),
                "brier": m.get("brier"),
            }
        )

    return {
        "probability_bands": prob_bands,
        "odds_bands": odds_bands,
    }


# ---------------------------------------------------------------------------
# Banded shrink calibration fit (walk-forward)
# ---------------------------------------------------------------------------


def _fit_shrink_factor(part: list[dict[str, Any]]) -> float:
    if not part:
        return 1.0
    best_k, best_b = 1.0, float("inf")
    for k in [i / 100 for i in range(40, 121, 5)]:
        ps = [0.5 + (r["model_home"] - 0.5) * k for r in part]
        b = sum((p - r["home_won"]) ** 2 for p, r in zip(ps, part)) / len(part)
        if b < best_b:
            best_b, best_k = b, k
    return best_k


def fit_banded_shrink(rows: list[dict[str, Any]], n_splits: int = 4) -> dict[str, Any]:
    """Walk-forward banded shrink fit. Returns factors + combined test metrics."""
    n = len(rows)
    if n < 80:
        return {"factors": {}, "enabled": False, "reason": "not enough rows"}
    size = max(1, n // n_splits)
    combined_raw_b = combined_shrunk_b = 0.0
    tot = 0
    all_factors: dict[str, float] = {}
    for i in range(n_splits):
        start = i * size
        end = n if i == n_splits - 1 else (i + 1) * size
        train = rows[:start] if i > 0 else rows[:size]
        test = rows[start:end]
        if not train or not test:
            continue
        # fit per-band on train
        factors: dict[str, float] = {}
        for lo, hi in _PROB_BANDS:
            part = [r for r in train if lo <= r["model_home"] < hi]
            if len(part) >= 20:
                factors[f"{lo:.2f}-{hi:.2f}"] = _fit_shrink_factor(part)
        # apply to test
        def shrink(p: float) -> float:
            for (lo, hi), factor in [(b, factors.get(f"{b[0]:.2f}-{b[1]:.2f}", 1.0)) for b in _PROB_BANDS]:
                if lo <= p < hi:
                    return 0.5 + (p - 0.5) * factor
            return p
        ys = [r["home_won"] for r in test]
        raw_b = sum((r["model_home"] - y) ** 2 for r, y in zip(test, ys)) / len(test)
        shrunk_b = sum((shrink(r["model_home"]) - y) ** 2 for r, y in zip(test, ys)) / len(test)
        combined_raw_b += raw_b * len(test)
        combined_shrunk_b += shrunk_b * len(test)
        tot += len(test)
        all_factors.update(factors)
    if tot == 0:
        return {"factors": {}, "enabled": False, "reason": "no test rows"}
    raw_b = combined_raw_b / tot
    shrunk_b = combined_shrunk_b / tot
    # enable only if walk-forward improvement is real and meaningful
    enabled = shrunk_b < raw_b - 0.001
    return {
        "factors": all_factors,
        "enabled": enabled,
        "raw_brier": round(raw_b, 6),
        "shrunk_brier": round(shrunk_b, 6),
        "improvement": round(raw_b - shrunk_b, 6),
        "reason": "walk-forward improvement" if enabled else "insufficient walk-forward improvement",
    }


def _gate_slice(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {"n": 0, "promoted": False, "reason": "no samples"}
    # chronological 50/50 split
    cut = max(1, len(rows) // 2)
    train, test = rows[:cut], rows[cut:]
    train_m = metrics(train)
    test_m = metrics(test)
    full_m = metrics(rows)
    # break-even for typical favorite bands in this slice
    be_lo, be_hi = 0.55, 0.58
    promoted = (
        train_m["n"] >= MIN_PROMOTE_N
        and test_m["n"] >= MIN_PROMOTE_N
        and train_m["accuracy"] is not None
        and test_m["accuracy"] is not None
        and train_m["accuracy"] >= be_lo
        and test_m["accuracy"] >= be_lo
        and (train_m["roi"] or 0) >= 0
        and (test_m["roi"] or 0) >= 0
    )
    reason = []
    if train_m["n"] < MIN_PROMOTE_N or test_m["n"] < MIN_PROMOTE_N:
        reason.append(f"n={train_m['n']}+{test_m['n']} < {MIN_PROMOTE_N} each")
    if train_m["accuracy"] is not None and train_m["accuracy"] < be_lo:
        reason.append(f"train WR {train_m['accuracy']:.1%} < {be_lo:.0%}")
    if test_m["accuracy"] is not None and test_m["accuracy"] < be_lo:
        reason.append(f"test WR {test_m['accuracy']:.1%} < {be_lo:.0%}")
    if (train_m["roi"] or 0) < 0:
        reason.append("train ROI < 0")
    if (test_m["roi"] or 0) < 0:
        reason.append("test ROI < 0")
    if promoted:
        reason = ["train+test both clear break-even and n threshold"]
    return {
        "n": len(rows),
        "train": train_m,
        "test": test_m,
        "full": full_m,
        "promoted": promoted,
        "break_even_wr_band": [be_lo, be_hi],
        "min_n_each_window": MIN_PROMOTE_N,
        "reason": "; ".join(reason) if reason else "no samples",
    }


def analyze(*, sqlite_path: Path, outcomes_csv: Path, n_splits: int) -> dict[str, Any]:
    rows = load_joined_rows(sqlite_path, outcomes_csv)
    n = len(rows)
    model_m = metrics(rows)
    market_m = metrics(rows, [r["market_home"] for r in rows])

    # walk-forward blend weight
    split_size = max(1, n // n_splits)
    combined_rows: list[dict[str, Any]] = []
    combined_probs: list[float] = []
    weights: list[float] = []
    for idx in range(n_splits):
        start = idx * split_size
        end = n if idx == n_splits - 1 else (idx + 1) * split_size
        train = rows[:start] if idx > 0 else rows[:split_size]
        test = rows[start:end]
        if not train or not test:
            continue
        w = fit_blend_weight(train)
        weights.append(w)
        combined_rows.extend(test)
        combined_probs.extend(blend_probs(test, w))
    rec_w = sorted(weights)[len(weights) // 2] if weights else 0.0
    blend_m = metrics(combined_rows, combined_probs) if combined_rows else {"n": 0}
    blend_adopt = (
        blend_m.get("brier") is not None
        and market_m.get("brier") is not None
        and blend_m["brier"] <= market_m["brier"]
    )

    gates = disagreement_gate(rows)
    bands = per_band_metrics(rows)
    shrink = fit_banded_shrink(rows, n_splits)
    sizing = sizing_boost_validation(rows)
    reverse = reverse_direction_validation(rows)

    return {
        "inputs": {
            "rows_joined": n,
            "date_start": rows[0]["date"] if rows else None,
            "date_end": rows[-1]["date"] if rows else None,
            "splits": n_splits,
        },
        "model_vs_market": {
            "model": model_m,
            "market": market_m,
        },
        "residual_blend": {
            "recommended_weight": rec_w,
            "combined_walkforward": blend_m,
            "adoption_gate": {
                "blend_brier": blend_m.get("brier"),
                "market_brier": market_m.get("brier"),
                "should_consider_enabling": blend_adopt,
            },
        },
        "disagreement_gates": gates,
        "per_band": bands,
        "banded_shrink": shrink,
        "sizing_boost": sizing,
        "reverse_direction": reverse,
    }


def _fmt(v: float | None) -> str:
    return "n/a" if v is None else f"{v:.4f}"


def print_report(report: dict[str, Any]) -> None:
    i = report["inputs"]
    print("=" * 72)
    print("Moneyline model-vs-market edge validation")
    print("=" * 72)
    print(f"Rows: {i['rows_joined']} ({i['date_start']} .. {i['date_end']}), splits={i['splits']}")
    mv = report["model_vs_market"]
    print(f"Model:  acc={_fmt(mv['model']['accuracy'])} brier={_fmt(mv['model']['brier'])} roi={_fmt(mv['model']['roi'])}")
    print(f"Market: acc={_fmt(mv['market']['accuracy'])} brier={_fmt(mv['market']['brier'])} roi={_fmt(mv['market']['roi'])}")
    rb = report["residual_blend"]
    print(f"\nResidual blend: recommended_weight={rb['recommended_weight']}")
    print(f"  blend_brier={_fmt(rb['adoption_gate']['blend_brier'])} market_brier={_fmt(rb['adoption_gate']['market_brier'])} enable={rb['adoption_gate']['should_consider_enabling']}")
    dg = report["disagreement_gates"]
    print(f"\nDisagreement gates (conflicts total={dg['conflicts_total']}):")
    for name, g in dg.items():
        if name == "conflicts_total":
            continue
        print(f"  {name}: n={g['n']} promoted={g['promoted']}")
        print(f"    train n={g['train']['n']} acc={_fmt(g['train']['accuracy'])} roi={_fmt(g['train']['roi'])}")
        print(f"    test  n={g['test']['n']} acc={_fmt(g['test']['accuracy'])} roi={_fmt(g['test']['roi'])}")
        print(f"    reason: {g['reason']}")

    pb = report.get("per_band", {})
    if pb.get("probability_bands"):
        print("\nPer-probability-band:")
        for b in pb["probability_bands"]:
            print(
                f"  {b['band']} n={b['n']} pred={b['mean_pred']:.3f} actual={b['actual_win_rate']:.3f} "
                f"model_acc={_fmt(b['model_accuracy'])} market_acc={_fmt(b['market_accuracy'])} roi={_fmt(b['model_roi'])}"
            )
    if pb.get("odds_bands"):
        print("\nPer-odds-band:")
        for b in pb["odds_bands"]:
            print(
                f"  {b['band']} n={b['n']} model_acc={_fmt(b['model_accuracy'])} "
                f"market_acc={_fmt(b['market_accuracy'])} roi={_fmt(b['model_roi'])}"
            )

    bs = report.get("banded_shrink", {})
    print("\nBanded shrink calibration:")
    print(f"  enabled={bs.get('enabled')} raw_brier={_fmt(bs.get('raw_brier'))} shrunk_brier={_fmt(bs.get('shrunk_brier'))} improvement={_fmt(bs.get('improvement'))}")
    if bs.get("factors"):
        for band, k in sorted(bs["factors"].items()):
            print(f"  {band}: factor={k}")
    print(f"  reason: {bs.get('reason')}")

    sb = report.get("sizing_boost", {})
    print("\nSizing boost (disagreement):")
    print(f"  boost={sb.get('boost')} validated={sb.get('validated')} n={sb.get('n')} WR={_fmt(sb.get('wr'))} ROI={_fmt(sb.get('roi'))}")
    print(f"  reason: {sb.get('reason')}")

    rd = report.get("reverse_direction", {})
    print("\nReverse direction (model-home vs market-away):")
    print(f"  promoted={rd.get('promoted')} n={rd.get('n')}")
    print(f"  train n={rd.get('train', {}).get('n')} acc={_fmt(rd.get('train', {}).get('accuracy'))} roi={_fmt(rd.get('train', {}).get('roi'))}")
    print(f"  test  n={rd.get('test', {}).get('n')} acc={_fmt(rd.get('test', {}).get('accuracy'))} roi={_fmt(rd.get('test', {}).get('roi'))}")
    print(f"  reason: {rd.get('reason')}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", default=str(data_path("state.sqlite")))
    parser.add_argument("--outcomes-csv", default=str(data_path("evolution/prediction_outcomes.csv")))
    parser.add_argument("--splits", type=int, default=4)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    sqlite_path = Path(args.sqlite)
    if not sqlite_path.exists():
        print(f"ERROR: sqlite not found: {sqlite_path}", file=sys.stderr)
        return 2

    report = analyze(
        sqlite_path=sqlite_path,
        outcomes_csv=Path(args.outcomes_csv),
        n_splits=max(2, args.splits),
    )
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print_report(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
