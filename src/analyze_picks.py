"""Analyze the full prediction-outcome history to surface edge improvements.

Reads every graded pick from data/evolution/prediction_outcomes.csv (via the
same loader the audit uses, so evaluation_json is merged in), then computes
per-market accuracy, ROI, Brier, log-loss, calibration-by-bucket, weakest/
strongest segments, and CLV. Writes a human-readable report to
data/docs/picks-analysis-500.md.

This is a read-only analysis: it never mutates outcomes or calibration maps.
It reuses existing primitives instead of re-deriving them:
  - _evaluation_rows / calibration_buckets / segment_performance / clv_report
    from src.evolution.evolution_audit
  - brier_score / log_loss from src.calibration
  - _predicted_probability from src.evolution.evolution_audit

Run: node scripts/run_python.js -m src.analyze_picks
"""

from __future__ import annotations

from collections import defaultdict
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

_REPORT_PATH = Path(__file__).resolve().parent.parent / "data" / "docs" / "picks-analysis-500.md"
_MARKETS = ("moneyline", "totals", "yrfi")


def _american_profit(odds: float, won: bool) -> float:
    """Return profit on a 1-unit stake at the given American odds."""
    if odds == 0:
        return 0.0
    if won:
        return odds / 100.0 if odds > 0 else 100.0 / abs(odds)
    return -1.0


def _market_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Accuracy, ROI, Brier, log-loss, and model lift for one market's rows."""
    decided = [r for r in rows if r.get("result") in ("win", "loss")]
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

    # ROI: prefer stored profit_loss; fall back to even-money if absent.
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


def analyze() -> dict[str, Any]:
    rows = _evaluation_rows()
    by_market: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_market[r.get("market", "moneyline")].append(r)

    report: dict[str, Any] = {
        "total_rows": len(rows),
        "markets": {},
        "overall_metrics": _market_metrics(rows),
        "weakest_segments": segment_performance(rows, min_sample=5)[:8],
        "clv": clv_report(rows),
    }
    strongest = sorted(
        segment_performance(rows, min_sample=5),
        key=lambda s: (s["loss_rate"], -s["sample_size"]),
    )[:5]
    report["strongest_segments"] = strongest

    for market in _MARKETS:
        mrows = by_market.get(market, [])
        if not mrows:
            continue
        buckets = calibration_buckets(mrows, min_sample=3)
        report["markets"][market] = {
            "metrics": _market_metrics(mrows),
            "calibration_buckets": buckets,
            "confidence_direction": _confidence_direction(buckets),
            "clv": clv_report(mrows),
        }
    return report


def _fmt(value: Any, suffix: str = "") -> str:
    if value is None:
        return "n/a"
    return f"{value}{suffix}"


def render_markdown(report: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append("# Analisa Picks — Peningkatan Edge Prediksi\n")
    lines.append(
        f"Dataset: **{report['total_rows']} outcome tergradasi** dari "
        "`data/evolution/prediction_outcomes.csv` (seluruh riwayat, di-breakdown per market).\n"
    )
    lines.append(
        "> Catatan: user menyebut \"500 picks\"; jumlah riil dataset lebih besar. "
        "Analisa memakai SEMUA baris agar sinyal kalibrasi sekuat mungkin.\n"
    )

    o = report["overall_metrics"]
    lines.append("## Ringkasan Keseluruhan\n")
    lines.append("| Metrik | Nilai |")
    lines.append("|---|---|")
    lines.append(f"| Sample (decided) | {o['decided']} / {o['sample']} |")
    lines.append(f"| Win rate | {_fmt(o['win_rate'], '%')} |")
    lines.append(f"| ROI (per unit) | {_fmt(o['roi_pct'], '%')} |")
    lines.append(f"| Brier model | {_fmt(o['model_brier'])} |")
    lines.append(f"| Brier baseline (flat 50%) | {_fmt(o['baseline_brier'])} |")
    lines.append(f"| **Lift Brier (baseline − model)** | **{_fmt(o['brier_lift'])}** |")
    lines.append(f"| Log-loss | {_fmt(o['log_loss'])} |\n")
    lines.append(
        "Lift Brier positif = model lebih baik dari tebak koin; negatif = model "
        "lebih buruk dari sekadar 50%.\n"
    )

    lines.append("## Per Market\n")
    for market, data in report["markets"].items():
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
        lines.append(f"| Log-loss | {_fmt(m['log_loss'])} |\n")
        lines.append(
            f"Arah miscalibration: **{cd['overconfident']} bucket overconfident, "
            f"{cd['underconfident']} underconfident, {cd['calibrated']} terkalibrasi.**\n"
        )
        if data["calibration_buckets"]:
            lines.append("| Bucket | n | Prob prediksi | Win rate observasi | Error | Verdict |")
            lines.append("|---|---|---|---|---|---|")
            for b in data["calibration_buckets"]:
                lines.append(
                    f"| {b['bucket'].replace('probability:', '')} | {b['sample_size']} "
                    f"| {b['avg_predicted_probability']}% | {b['observed_win_rate']}% "
                    f"| {b['calibration_error']:+} | {b['verdict']} |"
                )
            lines.append("")

    lines.append("## Segmen Terlemah (loss rate tertinggi)\n")
    if report["weakest_segments"]:
        lines.append("| Segmen | Sample | Win rate | Loss rate | Avg Brier |")
        lines.append("|---|---|---|---|---|")
        for s in report["weakest_segments"]:
            lines.append(
                f"| {s['segment']} | {s['sample_size']} | {s['accuracy']}% "
                f"| {s['loss_rate']}% | {_fmt(s['average_brier'])} |"
            )
        lines.append("")

    lines.append("## CLV (Closing Line Value)\n")
    clv = report["clv"]
    lines.append(f"- Sample dengan CLV: **{clv['sample_size']}** (status: {clv['status']})")
    lines.append(f"- Rata-rata CLV: {_fmt(clv['average_clv'])}")
    lines.append(f"- Positif/negatif/flat: {clv['positive']}/{clv['negative']}/{clv['flat']}")
    lines.append(f"- {clv['note']}")
    lines.append(f"- {_clv_interpretation(clv)}\n")
    market_clv = [
        (mkt, data["clv"])
        for mkt, data in report["markets"].items()
        if data.get("clv", {}).get("sample_size", 0) > 0
    ]
    if market_clv:
        lines.append("| Market | Sample CLV | Rata-rata | +/−/flat |")
        lines.append("|---|---|---|---|")
        for mkt, c in market_clv:
            lines.append(
                f"| {mkt} | {c['sample_size']} | {_fmt(c['average_clv'])} "
                f"| {c['positive']}/{c['negative']}/{c['flat']} |"
            )
        lines.append("")

    lines.append("## Temuan & Rekomendasi\n")
    lines.extend(_recommendations(report))
    return "\n".join(lines) + "\n"


def _clv_interpretation(clv: dict[str, Any]) -> str:
    """Honest, sample-size-aware reading of the CLV aggregate."""
    n = clv.get("sample_size", 0)
    avg = clv.get("average_clv")
    if not n:
        return (
            "Belum ada data closing line. Capture forward sudah jalan; CLV akan terisi "
            "seiring slate baru di-grade."
        )
    if n < 50:
        base = (
            f"Sampel masih tipis ({n} < 50) — terlalu sedikit untuk menyimpulkan edge pasar; "
            "varians per-bet besar. Biarkan menumpuk dulu."
        )
    else:
        base = f"Sampel cukup ({n}) untuk mulai membaca arah edge pasar."
    if avg is None:
        return base
    if avg < -0.05:
        return base + f" Rata-rata CLV negatif ({avg}) = harga rata-rata sedikit lebih buruk dari closing — pantau, jangan disimpulkan sampai sampel tebal."
    if avg > 0.05:
        return base + f" Rata-rata CLV positif ({avg}) = beat the close (sinyal edge sehat)."
    return base + f" Rata-rata CLV ~flat ({avg})."


def _recommendations(report: dict[str, Any]) -> list[str]:
    recs: list[str] = []
    for market, data in report["markets"].items():
        cd = data["confidence_direction"]
        m = data["metrics"]
        if m["brier_lift"] is not None and m["brier_lift"] <= 0:
            recs.append(
                f"- **{market}**: lift Brier {m['brier_lift']} ≤ 0 — model TIDAK mengalahkan "
                "tebak-50%. Kalibrasi/threshold market ini perlu perbaikan paling mendesak."
            )
        if cd["underconfident"] > cd["overconfident"]:
            recs.append(
                f"- **{market}**: underconfidence dominan ({cd['underconfident']} vs "
                f"{cd['overconfident']} bucket). Dampening edge global (`* 0.7` di mlb.js) "
                "kemungkinan over-correcting untuk market ini — pertimbangkan menaikkan faktor."
            )
        elif cd["overconfident"] > cd["underconfident"]:
            recs.append(
                f"- **{market}**: overconfidence dominan ({cd['overconfident']} vs "
                f"{cd['underconfident']} bucket). Pertahankan/perketat dampening."
            )
    clv = report["clv"]
    if clv["sample_size"] < 50:
        recs.append(
            f"- **CLV**: hanya {clv['sample_size']} sampel — terlalu tipis untuk menilai edge "
            "pasar. Pastikan opening + closing odds tersimpan untuk setiap pick."
        )
    if not recs:
        recs.append("- Tidak ada masalah sistematis terdeteksi pada dataset ini.")
    return recs


def main() -> None:
    report = analyze()
    _REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    _REPORT_PATH.write_text(render_markdown(report), encoding="utf-8")
    o = report["overall_metrics"]
    print(f"Analyzed {report['total_rows']} outcomes across {len(report['markets'])} markets.")
    print(f"Overall Brier lift (baseline - model): {o['brier_lift']}")
    for market, data in report["markets"].items():
        cd = data["confidence_direction"]
        print(
            f"  {market}: lift={data['metrics']['brier_lift']} "
            f"over={cd['overconfident']} under={cd['underconfident']} cal={cd['calibrated']}"
        )
    print(f"Report written to {_REPORT_PATH}")


if __name__ == "__main__":
    main()
