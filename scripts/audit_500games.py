"""
MLB Stats Bot - 500 Game Audit Script
======================================
Jalankan dari root folder MLB-Stats-Bot:
    python3 scripts/audit_500games.py

Output:
    - Terminal: ringkasan lengkap
    - data/audit_report.json: raw data untuk Codex/Agent
    - data/audit_report.csv: export flat untuk spreadsheet

Pastikan file ada:
    data/predictions_log.csv
"""

import csv
import json
import os
import sys
from collections import defaultdict
from datetime import datetime
from math import log, sqrt


# ─────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(SCRIPT_DIR) if os.path.basename(SCRIPT_DIR) == "scripts" else SCRIPT_DIR
PREDICTIONS_LOG = os.path.join(BASE_DIR, "data", "predictions_log.csv")
OUTPUT_JSON = os.path.join(BASE_DIR, "data", "audit_report.json")
OUTPUT_CSV = os.path.join(BASE_DIR, "data", "audit_report.csv")

CONFIDENCE_LEVELS = ["low", "medium", "high"]
EDGE_BUCKETS = [
    ("edge_neg", None, 0),
    ("edge_0_3", 0, 3),
    ("edge_3_6", 3, 6),
    ("edge_6_10", 6, 10),
    ("edge_10plus", 10, None),
]
PROB_BUCKETS = [
    ("50_55", 50, 55),
    ("55_60", 55, 60),
    ("60_65", 60, 65),
    ("65_70", 65, 70),
    ("70plus", 70, None),
]


# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────
def safe_float(val, default=None):
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def safe_int(val, default=None):
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def pct(numerator, denominator):
    if denominator == 0:
        return 0.0
    return round(100 * numerator / denominator, 1)


def brier_score(rows):
    """Lower is better. 0.25 = random, <0.20 decent, <0.15 good."""
    scores = []
    for r in rows:
        prob = safe_float(r.get("home_win_probability", 50)) / 100
        outcome = 1 if r.get("result", "").upper() in ("WIN", "CORRECT", "HOME") else 0
        if r.get("predicted_winner", "").lower() in (
            r.get("away_team", "x").lower(), "away"
        ):
            prob = 1 - prob
        scores.append((prob - outcome) ** 2)
    if not scores:
        return None
    return round(sum(scores) / len(scores), 4)


def log_loss_score(rows):
    eps = 1e-9
    losses = []
    for r in rows:
        prob = safe_float(r.get("home_win_probability", 50)) / 100
        outcome = 1 if r.get("result", "").upper() in ("WIN", "CORRECT", "HOME") else 0
        if r.get("predicted_winner", "").lower() in (
            r.get("away_team", "x").lower(), "away"
        ):
            prob = 1 - prob
        prob = max(eps, min(1 - eps, prob))
        losses.append(-(outcome * log(prob) + (1 - outcome) * log(1 - prob)))
    if not losses:
        return None
    return round(sum(losses) / len(losses), 4)


def win_rate_group(rows):
    wins = sum(1 for r in rows if r.get("result", "").upper() in ("WIN", "CORRECT"))
    total = len(rows)
    return wins, total, pct(wins, total)


def roi_group(rows):
    """Simple unit stake ROI. Needs profit_loss column."""
    total_pl = sum(safe_float(r.get("profit_loss", 0), 0) for r in rows)
    total_staked = len(rows)
    if total_staked == 0:
        return 0.0
    return round(100 * total_pl / total_staked, 2)


# ─────────────────────────────────────────────
# LOAD DATA
# ─────────────────────────────────────────────
def load_predictions(path):
    if not os.path.exists(path):
        print(f"[ERROR] File tidak ditemukan: {path}")
        print("Pastikan predictions_log.csv ada di folder data/")
        sys.exit(1)

    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)

    print(f"[OK] Loaded {len(rows)} game records dari {path}")
    return rows


# ─────────────────────────────────────────────
# ANALYSIS MODULES
# ─────────────────────────────────────────────
def analyze_overall(rows):
    settled = [r for r in rows if r.get("result", "").strip() != ""]
    wins, total, wr = win_rate_group(settled)
    no_bet = [r for r in rows if r.get("final_lean", "").upper() == "NO BET"]
    bet = [r for r in rows if r.get("final_lean", "").upper() in ("BET", "VALUE")]

    return {
        "total_games": len(rows),
        "settled_games": total,
        "wins": wins,
        "losses": total - wins,
        "win_rate_pct": wr,
        "no_bet_count": len(no_bet),
        "bet_count": len(bet),
        "roi": roi_group(settled),
        "brier_score": brier_score(settled),
        "log_loss": log_loss_score(settled),
    }


def analyze_by_confidence(rows):
    result = {}
    for level in CONFIDENCE_LEVELS:
        group = [r for r in rows if r.get("confidence", "").lower() == level
                 and r.get("result", "").strip() != ""]
        w, t, wr = win_rate_group(group)
        result[level] = {
            "count": t,
            "wins": w,
            "win_rate_pct": wr,
            "roi": roi_group(group),
        }
    return result


def analyze_by_edge(rows):
    result = {}
    for label, lo, hi in EDGE_BUCKETS:
        group = []
        for r in rows:
            edge = safe_float(r.get("model_edge", r.get("edge", None)))
            if edge is None:
                continue
            if lo is None and edge < hi:
                group.append(r)
            elif hi is None and edge >= lo:
                group.append(r)
            elif lo is not None and hi is not None and lo <= edge < hi:
                group.append(r)
        settled = [r for r in group if r.get("result", "").strip() != ""]
        w, t, wr = win_rate_group(settled)
        result[label] = {
            "count": t,
            "wins": w,
            "win_rate_pct": wr,
            "roi": roi_group(settled),
            "edge_range": f"{lo if lo is not None else '<0'} to {hi if hi is not None else '+'}%",
        }
    return result


def analyze_by_probability(rows):
    result = {}
    for label, lo, hi in PROB_BUCKETS:
        group = []
        for r in rows:
            prob = safe_float(r.get("home_win_probability"))
            if prob is None:
                continue
            # normalize to predicted team's probability
            if r.get("predicted_winner", "").lower() in (
                r.get("away_team", "x").lower(), "away"
            ):
                prob = 100 - prob
            if hi is None and prob >= lo:
                group.append(r)
            elif lo <= prob < hi:
                group.append(r)
        settled = [r for r in group if r.get("result", "").strip() != ""]
        w, t, wr = win_rate_group(settled)
        result[label] = {
            "count": t,
            "wins": w,
            "win_rate_pct": wr,
            "prob_range": f"{lo}-{hi if hi else '100'}%",
        }
    return result


def analyze_no_bet_quality(rows):
    """
    Cek apakah game yang di-NO BET sebenarnya lebih sering menang
    (artinya bot melewatkan value) atau lebih sering kalah (artinya
    NO BET filter bekerja dengan baik).
    """
    no_bet = [r for r in rows if r.get("final_lean", "").upper() == "NO BET"
              and r.get("result", "").strip() != ""]
    w, t, wr = win_rate_group(no_bet)
    return {
        "no_bet_settled": t,
        "no_bet_would_have_won": w,
        "no_bet_would_have_win_rate": wr,
        "interpretation": (
            "NO BET filter BURUK - banyak game bagus dilewati"
            if wr > 56
            else "NO BET filter BAGUS - game yang dilewati memang lebih susah"
        ),
    }


def analyze_llm_vs_baseline(rows):
    """
    Bandingkan win rate ketika LLM override baseline
    vs ketika LLM setuju dengan baseline.
    Butuh kolom agent_probability dan baseline_probability.
    """
    overrides = []
    agrees = []

    for r in rows:
        agent_prob = safe_float(r.get("agent_probability") or r.get("agent_prob"))
        baseline_prob = safe_float(r.get("baseline_probability") or r.get("baseline_prob"))
        if agent_prob is None or baseline_prob is None:
            continue
        diff = abs(agent_prob - baseline_prob)
        if diff >= 5:  # threshold: beda 5% dianggap override
            overrides.append(r)
        else:
            agrees.append(r)

    ov_settled = [r for r in overrides if r.get("result", "").strip() != ""]
    ag_settled = [r for r in agrees if r.get("result", "").strip() != ""]

    _, _, ov_wr = win_rate_group(ov_settled)
    _, _, ag_wr = win_rate_group(ag_settled)

    return {
        "override_count": len(ov_settled),
        "override_win_rate": ov_wr,
        "agree_count": len(ag_settled),
        "agree_win_rate": ag_wr,
        "data_available": len(ov_settled) + len(ag_settled) > 0,
        "interpretation": (
            "LLM override NET NEGATIVE - baseline lebih akurat"
            if ov_wr < ag_wr
            else "LLM override NET POSITIVE - agent menambah nilai"
        ) if (len(ov_settled) + len(ag_settled) > 0) else "Data agent vs baseline tidak tersedia di CSV",
    }


def analyze_by_home_away(rows):
    home_pick = [r for r in rows
                 if r.get("predicted_winner", "").lower() == r.get("home_team", "").lower()
                 and r.get("result", "").strip() != ""]
    away_pick = [r for r in rows
                 if r.get("predicted_winner", "").lower() == r.get("away_team", "").lower()
                 and r.get("result", "").strip() != ""]

    _, _, hw = win_rate_group(home_pick)
    _, _, aw = win_rate_group(away_pick)

    return {
        "home_picks": len(home_pick),
        "home_win_rate": hw,
        "away_picks": len(away_pick),
        "away_win_rate": aw,
        "bias_note": (
            "Terlalu banyak home picks - cek home field bias"
            if len(home_pick) > len(away_pick) * 1.5
            else "Pick distribution home/away normal"
        ),
    }


def analyze_by_month(rows):
    result = defaultdict(list)
    for r in rows:
        date_str = r.get("date", "")
        try:
            dt = datetime.strptime(date_str[:10], "%Y-%m-%d")
            month_key = dt.strftime("%Y-%m")
        except ValueError:
            month_key = "unknown"
        result[month_key].append(r)

    monthly = {}
    for month, group in sorted(result.items()):
        settled = [r for r in group if r.get("result", "").strip() != ""]
        w, t, wr = win_rate_group(settled)
        monthly[month] = {"games": t, "wins": w, "win_rate_pct": wr}
    return monthly


def analyze_calibration(rows):
    """
    Kalibrasi: kalau model bilang 65%, actual win rate idealnya ~65%.
    Kalau berbeda jauh, model perlu recalibration.
    """
    buckets = defaultdict(list)
    for r in rows:
        if r.get("result", "").strip() == "":
            continue
        prob = safe_float(r.get("home_win_probability"))
        if prob is None:
            continue
        if r.get("predicted_winner", "").lower() in (
            r.get("away_team", "x").lower(), "away"
        ):
            prob = 100 - prob
        bucket = int(prob // 5) * 5  # bucket ke 5%
        outcome = 1 if r.get("result", "").upper() in ("WIN", "CORRECT") else 0
        buckets[bucket].append(outcome)

    calibration = {}
    max_gap = 0
    overconfident_buckets = []

    for bucket_start, outcomes in sorted(buckets.items()):
        actual_rate = pct(sum(outcomes), len(outcomes))
        gap = actual_rate - bucket_start
        max_gap = max(max_gap, abs(gap))
        calibration[f"{bucket_start}-{bucket_start+5}%"] = {
            "count": len(outcomes),
            "model_says": f"~{bucket_start+2}%",
            "actual_win_rate": actual_rate,
            "gap": round(gap, 1),
        }
        if gap < -8:
            overconfident_buckets.append(f"{bucket_start}-{bucket_start+5}%")

    return {
        "by_bucket": calibration,
        "max_calibration_gap": max_gap,
        "overconfident_buckets": overconfident_buckets,
        "calibration_quality": (
            "BAIK" if max_gap < 8
            else "PERLU RECALIBRATION" if max_gap < 15
            else "BURUK - recalibration mendesak"
        ),
    }


def analyze_loss_patterns(rows):
    """Cari pola loss - mana yang paling sering salah."""
    losses = [r for r in rows if r.get("result", "").upper() in ("LOSS", "WRONG", "INCORRECT")
              and r.get("result", "").strip() != ""]

    # Group loss by confidence
    loss_by_conf = defaultdict(int)
    for r in losses:
        loss_by_conf[r.get("confidence", "unknown").lower()] += 1

    # Group loss by edge bucket
    loss_by_edge = defaultdict(int)
    for r in losses:
        edge = safe_float(r.get("model_edge", r.get("edge")))
        if edge is None:
            loss_by_edge["unknown"] += 1
        elif edge < 0:
            loss_by_edge["negative_edge"] += 1
        elif edge < 3:
            loss_by_edge["edge_0_3"] += 1
        elif edge < 6:
            loss_by_edge["edge_3_6"] += 1
        else:
            loss_by_edge["edge_6plus"] += 1

    # Most common upset teams (bot salah tebak)
    upset_teams = defaultdict(int)
    for r in losses:
        winner_team = r.get("actual_winner", r.get("home_team", ""))
        if r.get("predicted_winner", "").lower() != winner_team.lower():
            upset_teams[winner_team] += 1

    top_upset = sorted(upset_teams.items(), key=lambda x: x[1], reverse=True)[:10]

    return {
        "total_losses": len(losses),
        "loss_by_confidence": dict(loss_by_conf),
        "loss_by_edge": dict(loss_by_edge),
        "top_10_teams_bot_underestimated": top_upset,
        "insight": (
            "Banyak loss di confidence HIGH → overconfidence problem"
            if loss_by_conf.get("high", 0) > loss_by_conf.get("low", 0)
            else "Loss terdistribusi normal"
        ),
    }


def analyze_yrfi_nrfi(rows):
    yrfi_rows = [r for r in rows if r.get("yrfi_pick", "").upper() in ("YES", "YRFI")
                 and r.get("yrfi_result", "").strip() != ""]
    nrfi_rows = [r for r in rows if r.get("yrfi_pick", "").upper() in ("NO", "NRFI")
                 and r.get("yrfi_result", "").strip() != ""]

    def yrfi_wins(group, expected_pick):
        return sum(1 for r in group if r.get("yrfi_result", "").upper() == expected_pick.upper())

    yrfi_win = yrfi_wins(yrfi_rows, "YES")
    nrfi_win = yrfi_wins(nrfi_rows, "NO")

    return {
        "yrfi_picks": len(yrfi_rows),
        "yrfi_correct": yrfi_win,
        "yrfi_accuracy": pct(yrfi_win, len(yrfi_rows)),
        "nrfi_picks": len(nrfi_rows),
        "nrfi_correct": nrfi_win,
        "nrfi_accuracy": pct(nrfi_win, len(nrfi_rows)),
        "data_available": len(yrfi_rows) + len(nrfi_rows) > 0,
        "note": "Kolom yrfi_pick dan yrfi_result harus ada di CSV untuk analisa ini"
        if len(yrfi_rows) + len(nrfi_rows) == 0
        else "",
    }


def generate_priority_recommendations(report):
    """Buat rekomendasi prioritas berdasarkan hasil audit."""
    recs = []
    overall = report.get("overall", {})
    calib = report.get("calibration", {})
    llm = report.get("llm_vs_baseline", {})
    no_bet = report.get("no_bet_quality", {})
    confidence = report.get("by_confidence", {})

    wr = overall.get("win_rate_pct", 0)
    if wr < 55:
        recs.append({
            "priority": 1,
            "area": "Overall Win Rate",
            "issue": f"Win rate {wr}% terlalu rendah",
            "action": "Audit feature importance - kemungkinan bobot pitcher/bullpen perlu disesuaikan",
        })

    if calib.get("max_calibration_gap", 0) > 10:
        recs.append({
            "priority": 2,
            "area": "Kalibrasi Model",
            "issue": f"Gap kalibrasi {calib.get('max_calibration_gap')}% - model overconfident",
            "action": "Terapkan Platt scaling atau isotonic regression untuk recalibrate probability output",
        })

    if llm.get("data_available") and llm.get("override_win_rate", 100) < llm.get("agree_win_rate", 0):
        recs.append({
            "priority": 3,
            "area": "LLM Override",
            "issue": "LLM override menurunkan akurasi vs baseline",
            "action": "Batasi LLM override maksimal ±8% dari baseline, atau nonaktifkan sementara untuk A/B test",
        })

    no_bet_wr = no_bet.get("no_bet_would_have_win_rate", 0)
    if no_bet_wr > 56:
        recs.append({
            "priority": 4,
            "area": "NO BET Filter",
            "issue": f"Game yang di-skip punya win rate {no_bet_wr}% - filter terlalu agresif",
            "action": "Turunkan threshold NO BET: edge minimum dari 2% ke 1.5%, atau data quality dari 60 ke 55",
        })

    high_conf = confidence.get("high", {})
    if high_conf.get("count", 0) > 20 and high_conf.get("win_rate_pct", 100) < 60:
        recs.append({
            "priority": 5,
            "area": "High Confidence Picks",
            "issue": f"High confidence hanya {high_conf.get('win_rate_pct')}% win rate",
            "action": "Perketat kriteria High confidence: wajib SP confirmed + lineup confirmed + odds fresh",
        })

    if not recs:
        recs.append({
            "priority": 1,
            "area": "Statcast Features",
            "issue": "Win rate 56% stagnan - model butuh fitur baru",
            "action": "Integrasikan xwOBA, barrel rate, dan exit velocity dari Baseball Savant",
        })

    return sorted(recs, key=lambda x: x["priority"])


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def main():
    print("=" * 60)
    print("  MLB Stats Bot - 500 Game Audit")
    print("=" * 60)

    rows = load_predictions(PREDICTIONS_LOG)

    print("\n[1/8] Overall performance...")
    overall = analyze_overall(rows)

    print("[2/8] By confidence level...")
    by_confidence = analyze_by_confidence(rows)

    print("[3/8] By edge bucket...")
    by_edge = analyze_by_edge(rows)

    print("[4/8] By probability bucket...")
    by_probability = analyze_by_probability(rows)

    print("[5/8] NO BET quality...")
    no_bet_quality = analyze_no_bet_quality(rows)

    print("[6/8] LLM vs baseline...")
    llm_vs_baseline = analyze_llm_vs_baseline(rows)

    print("[7/8] Calibration & loss patterns...")
    calibration = analyze_calibration(rows)
    loss_patterns = analyze_loss_patterns(rows)
    home_away = analyze_by_home_away(rows)
    by_month = analyze_by_month(rows)
    yrfi_nrfi = analyze_yrfi_nrfi(rows)

    print("[8/8] Generating recommendations...")
    report = {
        "generated_at": datetime.now().isoformat(),
        "overall": overall,
        "by_confidence": by_confidence,
        "by_edge": by_edge,
        "by_probability": by_probability,
        "no_bet_quality": no_bet_quality,
        "llm_vs_baseline": llm_vs_baseline,
        "calibration": calibration,
        "loss_patterns": loss_patterns,
        "home_away": home_away,
        "by_month": by_month,
        "yrfi_nrfi": yrfi_nrfi,
    }
    report["priority_recommendations"] = generate_priority_recommendations(report)

    # ── PRINT SUMMARY ──────────────────────────────────
    print("\n" + "=" * 60)
    print("  HASIL AUDIT")
    print("=" * 60)

    o = overall
    print(f"\n📊 OVERALL")
    print(f"   Total games  : {o['total_games']}")
    print(f"   Settled      : {o['settled_games']}")
    print(f"   Win rate     : {o['win_rate_pct']}%  ({o['wins']}W / {o['losses']}L)")
    print(f"   ROI          : {o['roi']}%")
    print(f"   Brier score  : {o['brier_score']}  (lower=better, 0.25=random)")
    print(f"   Log loss     : {o['log_loss']}")
    print(f"   NO BET count : {o['no_bet_count']}")

    print(f"\n🎯 BY CONFIDENCE")
    for lvl in CONFIDENCE_LEVELS:
        c = by_confidence.get(lvl, {})
        print(f"   {lvl.upper():8s}  {c.get('win_rate_pct', 0):5.1f}%  ({c.get('count', 0)} games, ROI {c.get('roi', 0)}%)")

    print(f"\n📈 BY EDGE BUCKET")
    for label, lo, hi in EDGE_BUCKETS:
        e = by_edge.get(label, {})
        print(f"   {e.get('edge_range', label):20s}  {e.get('win_rate_pct', 0):5.1f}%  ({e.get('count', 0)} games)")

    print(f"\n🔵 KALIBRASI")
    print(f"   Max gap      : {calibration['max_calibration_gap']}%")
    print(f"   Status       : {calibration['calibration_quality']}")
    if calibration["overconfident_buckets"]:
        print(f"   Overconfident buckets: {', '.join(calibration['overconfident_buckets'])}")

    print(f"\n🤖 LLM vs BASELINE")
    llm = llm_vs_baseline
    if llm["data_available"]:
        print(f"   Override ({llm['override_count']} games): {llm['override_win_rate']}%")
        print(f"   Agree    ({llm['agree_count']} games): {llm['agree_win_rate']}%")
        print(f"   → {llm['interpretation']}")
    else:
        print(f"   → {llm['data_available'] or llm['interpretation']}")

    print(f"\n🚫 NO BET FILTER QUALITY")
    nb = no_bet_quality
    print(f"   NO BET games skipped  : {nb['no_bet_settled']}")
    print(f"   Would have won        : {nb['no_bet_would_have_won']} ({nb['no_bet_would_have_win_rate']}%)")
    print(f"   → {nb['interpretation']}")

    print(f"\n🏠 HOME vs AWAY BIAS")
    ha = home_away
    print(f"   Home picks: {ha['home_picks']} games, {ha['home_win_rate']}% WR")
    print(f"   Away picks: {ha['away_picks']} games, {ha['away_win_rate']}% WR")
    print(f"   → {ha['bias_note']}")

    print(f"\n⚾ YRFI / NRFI")
    yn = yrfi_nrfi
    if yn["data_available"]:
        print(f"   YRFI: {yn['yrfi_accuracy']}% ({yn['yrfi_picks']} picks)")
        print(f"   NRFI: {yn['nrfi_accuracy']}% ({yn['nrfi_picks']} picks)")
    else:
        print(f"   → {yn['note']}")

    print(f"\n📅 BY MONTH (win rate)")
    for month, m in list(by_month.items())[-6:]:
        bar = "█" * int(m["win_rate_pct"] / 5)
        print(f"   {month}  {m['win_rate_pct']:5.1f}%  {bar}  ({m['games']} games)")

    print(f"\n🔴 LOSS PATTERNS")
    lp = loss_patterns
    print(f"   Total losses : {lp['total_losses']}")
    print(f"   By confidence: {lp['loss_by_confidence']}")
    print(f"   By edge      : {lp['loss_by_edge']}")
    print(f"   → {lp['insight']}")
    if lp["top_10_teams_bot_underestimated"]:
        print(f"   Teams paling sering mengalahkan prediksi bot:")
        for team, count in lp["top_10_teams_bot_underestimated"][:5]:
            print(f"     {team}: {count}x")

    print(f"\n🚀 PRIORITY RECOMMENDATIONS")
    for rec in report["priority_recommendations"]:
        print(f"\n   [{rec['priority']}] {rec['area'].upper()}")
        print(f"       Issue  : {rec['issue']}")
        print(f"       Action : {rec['action']}")

    # ── SAVE OUTPUT ──────────────────────────────────
    os.makedirs(os.path.dirname(OUTPUT_JSON), exist_ok=True)

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"\n✅ JSON report saved: {OUTPUT_JSON}")

    # Flat CSV export
    flat_rows = []
    for label, lo, hi in EDGE_BUCKETS:
        e = by_edge.get(label, {})
        flat_rows.append({
            "group_type": "edge",
            "group_label": label,
            "count": e.get("count", 0),
            "win_rate_pct": e.get("win_rate_pct", 0),
            "roi": e.get("roi", 0),
        })
    for lvl in CONFIDENCE_LEVELS:
        c = by_confidence.get(lvl, {})
        flat_rows.append({
            "group_type": "confidence",
            "group_label": lvl,
            "count": c.get("count", 0),
            "win_rate_pct": c.get("win_rate_pct", 0),
            "roi": c.get("roi", 0),
        })

    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["group_type", "group_label", "count", "win_rate_pct", "roi"])
        writer.writeheader()
        writer.writerows(flat_rows)
    print(f"✅ CSV export saved:  {OUTPUT_CSV}")

    print("\n" + "=" * 60)
    print("  Audit selesai. Share audit_report.json ke Codex")
    print("  untuk analysis lebih lanjut.")
    print("=" * 60)


if __name__ == "__main__":
    main()
