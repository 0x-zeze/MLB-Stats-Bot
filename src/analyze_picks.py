"""Analyze prediction outcomes and surface moneyline-specific edge improvements.

Reads graded picks from data/evolution/prediction_outcomes.csv through the same
loader the audit uses, then writes a human-readable report. The report separates
moneyline from YRFI so headline win rate is not polluted by advisory/low-edge
markets. It also adds weekly moneyline cohorts so we can track whether a week is
getting enough auditable picks and how far that cohort sits from a 70% win-rate
target.

Run: node scripts/run_python.js -m src.analyze_picks
"""

from __future__ import annotations

import argparse
import math
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from .calibration import brier_score, log_loss
from .evolution.evolution_audit import (
    _evaluation_rows,
    _predicted_probability,
    calibration_buckets,
    clv_report,
    segment_performance,
)
from .utils import safe_float

_REPORT_PATH = Path(__file__).resolve().parent.parent / "data" / "docs" / "picks-analysis.md"
_MARKETS = ("moneyline", "yrfi")
_WEEKLY_TARGET_WIN_RATE = 70.0


def _american_profit(odds: float, won: bool) -> float:
    """Return profit on a 1-unit stake at the given American odds."""
    if odds == 0:
        return 0.0
    if won:
        return odds / 100.0 if odds > 0 else 100.0 / abs(odds)
    return -1.0


def _decided(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [r for r in rows if r.get("result") in ("win", "loss")]


def _market_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Accuracy, ROI, Brier, log-loss, and model lift for one market's rows."""
    decided = _decided(rows)
    wins = sum(1 for r in decided if r.get("result") == "win")
    losses = len(decided) - wins

    probs: list[float] = []
    outcomes: list[int] = []
    baseline_probs: list[float] = []
    for r in decided:
        prob = _predicted_probability(r)
        if prob is None:
            continue
        probs.append(prob / 100.0)
        outcomes.append(1 if r.get("result") == "win" else 0)
        baseline_probs.append(0.5)

    # ROI: prefer stored profit_loss; fall back to None if absent so we do not
    # pretend audit-only picks were staked at an unavailable price.
    pls = [safe_float(r.get("profit_loss"), None) for r in decided]
    pls = [p for p in pls if p is not None]
    roi = round((sum(pls) / len(pls)) * 100.0, 1) if pls else None

    model_brier = round(brier_score(probs, outcomes), 4) if probs else None
    baseline_brier = round(brier_score(baseline_probs, outcomes), 4) if probs else None
    lift = (
        round(baseline_brier - model_brier, 4)
        if model_brier is not None and baseline_brier is not None
        else None
    )

    return {
        "sample": len(rows),
        "decided": len(decided),
        "wins": wins,
        "losses": losses,
        "pushes": sum(1 for r in rows if r.get("result") == "push"),
        "no_bets": sum(1 for r in rows if r.get("result") == "no_bet"),
        "win_rate": round((wins / len(decided)) * 100.0, 1) if decided else 0.0,
        "roi_pct": roi,
        "model_brier": model_brier,
        "baseline_brier": baseline_brier,
        "brier_lift": lift,
        "log_loss": round(log_loss(probs, outcomes), 4) if probs else None,
    }


def _confidence_direction(buckets: list[dict[str, Any]]) -> dict[str, int]:
    """Count over/under/calibrated verdicts across probability buckets."""
    tally = {"overconfident": 0, "underconfident": 0, "calibrated": 0}
    for b in buckets:
        tally[b.get("verdict", "calibrated")] = tally.get(b.get("verdict", "calibrated"), 0) + 1
    return tally


def _parse_date(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value or "")[:10])
    except ValueError:
        return None


def _week_start(value: Any) -> str:
    parsed = _parse_date(value)
    if parsed is None:
        return "unknown"
    return (parsed - timedelta(days=parsed.weekday())).isoformat()


def _weekly_metrics(rows: list[dict[str, Any]], min_sample: int = 1) -> list[dict[str, Any]]:
    """Return Monday-start weekly cohorts for decided rows."""
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in _decided(rows):
        grouped[_week_start(row.get("date"))].append(row)

    weeks: list[dict[str, Any]] = []
    for week, items in grouped.items():
        metrics = _market_metrics(items)
        weekly_clv = clv_report(items)
        target_wins = math.ceil((_WEEKLY_TARGET_WIN_RATE / 100.0) * metrics["decided"])
        gap = metrics["wins"] - target_wins
        weeks.append(
            {
                "week_start": week,
                "week_end": _week_end_label(week),
                "meets_sample": metrics["decided"] >= min_sample,
                "target_win_rate": _WEEKLY_TARGET_WIN_RATE,
                "target_wins": target_wins,
                "target_gap": gap,
                "clv": weekly_clv,
                **metrics,
            }
        )
    return sorted(weeks, key=lambda row: row["week_start"])


def _week_end_label(week_start: str) -> str:
    parsed = _parse_date(week_start)
    if parsed is None:
        return "unknown"
    return (parsed + timedelta(days=6)).isoformat()


def _ranked_segments(rows: list[dict[str, Any]], min_sample: int) -> dict[str, list[dict[str, Any]]]:
    segments = [s for s in segment_performance(rows, min_sample=min_sample) if s.get("decided", 0) >= min_sample]
    strongest = sorted(segments, key=lambda s: (s["accuracy"], s["wins"], s["sample_size"]), reverse=True)[:8]
    weakest = sorted(segments, key=lambda s: (s["loss_rate"], s["losses"], s["sample_size"]), reverse=True)[:8]
    return {"strongest": strongest, "weakest": weakest}


def analyze(min_week_sample: int = 20, segment_min_sample: int = 20) -> dict[str, Any]:
    rows = _evaluation_rows()
    by_market: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_market[r.get("market", "moneyline")].append(r)

    report: dict[str, Any] = {
        "total_rows": len(rows),
        "markets": {},
        "overall_metrics": _market_metrics(rows),
        "clv": clv_report(rows),
        "weekly_target_win_rate": _WEEKLY_TARGET_WIN_RATE,
        "min_week_sample": min_week_sample,
        "segment_min_sample": segment_min_sample,
    }

    for market in _MARKETS:
        mrows = by_market.get(market, [])
        if not mrows:
            continue
        buckets = calibration_buckets(mrows, min_sample=3)
        market_report = {
            "metrics": _market_metrics(mrows),
            "calibration_buckets": buckets,
            "confidence_direction": _confidence_direction(buckets),
            "clv": clv_report(mrows),
            "weekly": _weekly_metrics(mrows, min_sample=min_week_sample),
            "segments": _ranked_segments(mrows, min_sample=segment_min_sample),
        }
        report["markets"][market] = market_report
    return report


def _fmt(value: Any, suffix: str = "") -> str:
    if value is None:
        return "n/a"
    return f"{value}{suffix}"


def _target_status(row: dict[str, Any]) -> str:
    gap = int(row.get("target_gap", 0))
    if gap > 0:
        return f"tembus +{gap}W"
    if gap == 0:
        return "tembus target"
    return f"butuh {abs(gap)}W lagi"


def _render_market_summary(lines: list[str], market: str, data: dict[str, Any]) -> None:
    m = data["metrics"]
    cd = data["confidence_direction"]
    lines.append(f"### {market.upper()}\n")
    lines.append("| Metrik | Nilai |")
    lines.append("|---|---|")
    lines.append(f"| Sample (decided) | {m['decided']} / {m['sample']} |")
    lines.append(f"| Win rate | {_fmt(m['win_rate'], '%')} |")
    lines.append(f"| ROI | {_fmt(m['roi_pct'], '%')} |")
    lines.append(f"| Brier model | {_fmt(m['model_brier'])} |")
    lines.append(f"| Brier baseline | {_fmt(m['baseline_brier'])} |")
    lines.append(f"| Lift Brier | {_fmt(m['brier_lift'])} |")
    lines.append(f"| Log-loss | {_fmt(m['log_loss'])} |")
    lines.append(f"| CLV sample | {data['clv']['sample_size']} |")
    lines.append(f"| Avg CLV | {_fmt(data['clv']['average_clv'])} |\n")
    lines.append(
        f"Arah miscalibration: **{cd['overconfident']} bucket overconfident, "
        f"{cd['underconfident']} underconfident, {cd['calibrated']} terkalibrasi.**\n"
    )


def _render_calibration(lines: list[str], data: dict[str, Any]) -> None:
    buckets = data.get("calibration_buckets") or []
    if not buckets:
        return
    lines.append("| Bucket | n | Prob prediksi | Win rate observasi | Error | Verdict |")
    lines.append("|---|---:|---:|---:|---:|---|")
    for b in buckets:
        lines.append(
            f"| {str(b['bucket']).replace('probability:', '')} | {b['sample_size']} "
            f"| {b['avg_predicted_probability']}% | {b['observed_win_rate']}% "
            f"| {b['calibration_error']:+} | {b['verdict']} |"
        )
    lines.append("")


def _render_weekly_moneyline(lines: list[str], moneyline: dict[str, Any], min_week_sample: int) -> None:
    weekly = moneyline.get("weekly") or []
    lines.append("## Moneyline Weekly Cohorts\n")
    lines.append(
        "Target 70% di sini = **win rate dari total moneyline picks dalam satu minggu**, "
        "bukan probabilitas tiap tim harus 70%. Weekly cohort membantu lihat apakah volume "
        "cukup untuk diaudit.\n"
    )
    lines.append(f"Minimum sample sehat per minggu: **{min_week_sample} moneyline decided picks**.\n")
    if not weekly:
        lines.append("Belum ada weekly moneyline data.\n")
        return

    lines.append("| Week | Decided | W-L | WR | ROI | Brier | CLV | Target 70% | Sample |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---|---|")
    for row in weekly:
        sample = "OK" if row["meets_sample"] else "tipis"
        lines.append(
            f"| {row['week_start']}→{row['week_end']} | {row['decided']} | "
            f"{row['wins']}-{row['losses']} | {row['win_rate']}% | {_fmt(row['roi_pct'], '%')} | "
            f"{_fmt(row['model_brier'])} | {_fmt(row['clv']['average_clv'] if isinstance(row.get('clv'), dict) else row.get('average_clv'))} | "
            f"{_target_status(row)} | {sample} |"
        )
    lines.append("")

    qualified = [row for row in weekly if row["meets_sample"]]
    hit_weeks = [row for row in qualified if row["win_rate"] >= _WEEKLY_TARGET_WIN_RATE]
    if qualified:
        lines.append(
            f"Qualified weeks: **{len(qualified)}**, weeks ≥70%: **{len(hit_weeks)}**. "
            "Kalau jumlah hit-week rendah, jangan naikkan threshold probabilitas; cari segment/filter "
            "yang menaikkan weekly W-L tanpa mematikan volume audit.\n"
        )
    else:
        lines.append(
            "Belum ada minggu dengan sample cukup. Prioritas pertama: pastikan /today atau auto-alert "
            "jalan sebelum game mulai agar semua moneyline picks tersimpan untuk audit.\n"
        )


def _render_segments(lines: list[str], title: str, segments: list[dict[str, Any]]) -> None:
    lines.append(f"## {title}\n")
    if not segments:
        lines.append("Belum ada segmen dengan sample cukup.\n")
        return
    lines.append("| Segmen | Sample | W-L | Win rate | Loss rate | Avg Brier | Avg CLV |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|")
    for s in segments:
        lines.append(
            f"| {s['segment']} | {s['sample_size']} | {s['wins']}-{s['losses']} | "
            f"{s['accuracy']}% | {s['loss_rate']}% | {_fmt(s['average_brier'])} | {_fmt(s['average_clv'])} |"
        )
    lines.append("")


def render_markdown(report: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append("# Analisa Picks — Moneyline Weekly Edge\n")
    lines.append(
        f"Dataset: **{report['total_rows']} outcome aktif** dari "
        "`data/evolution/prediction_outcomes.csv`, dipisah per market.\n"
    )
    lines.append(
        "> Fokus utama: moneyline-only. YRFI dipisah karena historis advisory/negatif, "
        "jadi tidak boleh menutupi edge moneyline.\n"
    )
    lines.append(
        "> Catatan tracking: semua moneyline prediksi yang tersimpan sebelum game bisa diaudit. "
        "`VALUE` tetap ledger bet; `LEAN/NO BET` tetap berguna sebagai audit/shadow sample dan tidak dihitung sebagai staked ROI.\n"
    )

    o = report["overall_metrics"]
    lines.append("## Ringkasan Aktif (Moneyline + YRFI)\n")
    lines.append("| Metrik | Nilai |")
    lines.append("|---|---:|")
    lines.append(f"| Sample (decided) | {o['decided']} / {o['sample']} |")
    lines.append(f"| Win rate | {_fmt(o['win_rate'], '%')} |")
    lines.append(f"| ROI (per unit) | {_fmt(o['roi_pct'], '%')} |")
    lines.append(f"| Brier model | {_fmt(o['model_brier'])} |")
    lines.append(f"| Brier baseline (flat 50%) | {_fmt(o['baseline_brier'])} |")
    lines.append(f"| Lift Brier (baseline − model) | {_fmt(o['brier_lift'])} |")
    lines.append(f"| Log-loss | {_fmt(o['log_loss'])} |\n")

    lines.append("## Per Market\n")
    for market, data in report["markets"].items():
        _render_market_summary(lines, market, data)
        _render_calibration(lines, data)

    moneyline = report["markets"].get("moneyline")
    if moneyline:
        _render_weekly_moneyline(lines, moneyline, int(report["min_week_sample"]))
        _render_segments(lines, "Moneyline Segmen Terkuat", moneyline["segments"]["strongest"])
        _render_segments(lines, "Moneyline Segmen Terlemah", moneyline["segments"]["weakest"])

    lines.append("## CLV\n")
    clv = report["clv"]
    lines.append(f"- Sample dengan CLV: **{clv['sample_size']}** (status: {clv['status']})")
    lines.append(f"- Rata-rata CLV: {_fmt(clv['average_clv'])}")
    lines.append(f"- Positif/negatif/flat: {clv['positive']}/{clv['negative']}/{clv['flat']}")
    lines.append(f"- {clv['note']}")
    lines.append(f"- {_clv_interpretation(clv)}\n")

    lines.append("## Rekomendasi Praktis\n")
    lines.extend(_recommendations(report))
    return "\n".join(lines) + "\n"


def _clv_interpretation(clv: dict[str, Any]) -> str:
    """Honest, sample-size-aware reading of the CLV aggregate."""
    n = clv.get("sample_size", 0)
    avg = clv.get("average_clv")
    if not n:
        return "Belum ada data closing line. Capture opening + closing odds harus tetap jalan."
    base = (
        f"Sampel masih tipis ({n} < 50) — terlalu sedikit untuk menyimpulkan edge pasar."
        if n < 50
        else f"Sampel cukup ({n}) untuk mulai membaca arah edge pasar."
    )
    if avg is None:
        return base
    if avg < -0.05:
        return base + f" Rata-rata CLV negatif ({avg}) = harga rata-rata lebih buruk dari closing."
    if avg > 0.05:
        return base + f" Rata-rata CLV positif ({avg}) = beat the close (sinyal edge sehat)."
    return base + f" Rata-rata CLV ~flat ({avg})."


def _recommendations(report: dict[str, Any]) -> list[str]:
    recs: list[str] = []
    moneyline = report["markets"].get("moneyline")
    if moneyline:
        m = moneyline["metrics"]
        recs.append(
            f"- **Moneyline headline**: baca terpisah dari YRFI. Saat ini {m['wins']}-{m['losses']} "
            f"({m['win_rate']}%) dari {m['decided']} decided picks."
        )
        weak_weeks = [w for w in moneyline["weekly"] if w["meets_sample"] and w["win_rate"] < _WEEKLY_TARGET_WIN_RATE]
        if weak_weeks:
            recs.append(
                f"- **Weekly target 70%**: {len(weak_weeks)} qualified week masih di bawah target. "
                "Gunakan weekly table untuk audit penyebab, bukan menaikkan floor probabilitas secara buta."
            )
        if moneyline["clv"]["sample_size"] < 50:
            recs.append(
                f"- **Moneyline CLV**: hanya {moneyline['clv']['sample_size']} sampel. "
                "Simpan opening + closing odds untuk semua tracked picks supaya edge pasar bisa diaudit."
            )
        for bucket in moneyline.get("calibration_buckets", []):
            if bucket.get("verdict") == "overconfident":
                recs.append(
                    f"- **Kalibrasi**: bucket {bucket['bucket']} overconfident "
                    f"({bucket['observed_win_rate']}% actual vs {bucket['avg_predicted_probability']}% pred). "
                    "Cap confidence/value untuk bucket ini sampai sample baru membaik."
                )
                break
    yrfi = report["markets"].get("yrfi")
    if yrfi:
        ym = yrfi["metrics"]
        recs.append(
            f"- **YRFI tetap terpisah**: {ym['wins']}-{ym['losses']} ({ym['win_rate']}%). "
            "Jangan campur ke headline moneyline."
        )
    if not recs:
        recs.append("- Tidak ada masalah sistematis terdeteksi pada dataset ini.")
    return recs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze MLB pick outcomes with moneyline weekly cohorts.")
    parser.add_argument("--output", default=str(_REPORT_PATH), help="Markdown report output path")
    parser.add_argument("--min-week-sample", type=int, default=20, help="Minimum weekly moneyline decided sample")
    parser.add_argument("--segment-min-sample", type=int, default=20, help="Minimum sample for segment tables")
    parser.add_argument("--stdout", action="store_true", help="Print report markdown to stdout instead of writing only")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = analyze(
        min_week_sample=max(1, args.min_week_sample),
        segment_min_sample=max(1, args.segment_min_sample),
    )
    markdown = render_markdown(report)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(markdown, encoding="utf-8")

    o = report["overall_metrics"]
    print(f"Analyzed {report['total_rows']} active outcomes across {len(report['markets'])} markets.")
    print(f"Overall active win rate: {o['win_rate']}% ({o['wins']}-{o['losses']})")
    for market, data in report["markets"].items():
        m = data["metrics"]
        cd = data["confidence_direction"]
        print(
            f"  {market}: {m['win_rate']}% ({m['wins']}-{m['losses']}), "
            f"lift={m['brier_lift']}, over={cd['overconfident']} under={cd['underconfident']} cal={cd['calibrated']}"
        )
    print(f"Report written to {output_path}")
    if args.stdout:
        print(markdown)


if __name__ == "__main__":
    main()
