"""Head-to-head Shadow Tournament Evaluator & Promotion/Rule-Simplification Gate.

Compares competing models on strictly IDENTICAL settled common games:
  - heuristic_v1 (production control)
  - no_vig_market (sharp same-book no-vig baseline)
  - learned_v2_logistic (pure-baseball challenger)
  - market_residual_v2 (linear market-offset residual challenger)
  - market_residual_gbdt_v2 (shallow monotone GBDT + market-offset challenger)

Promotion & Rule-Simplification Gate (Phase 4.4 — Fail-Closed):
  Each challenger is evaluated on its own pairwise common settled games against
  (heuristic_v1, no_vig_market) so newly-deployed shadow models cannot starve
  established challengers. A challenger qualifies for promotion AND gated
  hard-rule simplification (`simplified_challenger` profile) ONLY when ALL hold:
    1. pairwise common_games >= min_common_games (default 200)
    2. Brier gain >= 0.001 over BOTH `no_vig_market` AND `heuristic_v1`
    3. Log-Loss gain >= 0.003 over BOTH `no_vig_market` AND `heuristic_v1`
    4. Paired bootstrap P(Log-Loss better) >= min_bootstrap_prob_better (default 0.80)
       against BOTH `no_vig_market` AND `heuristic_v1`
    5. Accuracy non-inferiority vs `heuristic_v1` (drop <= 1.0%)
    6. Fail-closed positive CLV: when require_positive_clv=True, closing odds
       evidence MUST exist (clv_n >= min_clv_games) AND mean_clv > 0.0

No code ever auto-promotes a model or swaps rule profiles; this module emits
an auditable decision report pending explicit human approval.
"""

from __future__ import annotations

from datetime import datetime, timezone
import math
import re
import sqlite3
from pathlib import Path
from typing import Any

import numpy as np

from src.eval.metrics import model_metrics

CONTROL_MODEL_ID = "heuristic_v1"
MARKET_BASELINE_ID = "no_vig_market"

DEFAULT_MIN_COMMON_GAMES = 200
DEFAULT_MIN_CLV_GAMES = 30
DEFAULT_MIN_BRIER_GAIN = 0.001
DEFAULT_MIN_LOGLOSS_GAIN = 0.003
DEFAULT_MAX_ACCURACY_DROP = 0.01
DEFAULT_MIN_BOOTSTRAP_PROB_BETTER = 0.80
DEFAULT_CLV_EDGE_THRESHOLD = 0.02
DEFAULT_BOOTSTRAP_SAMPLES = 400

_EXPLICIT_TZ_RE = re.compile(r"(?:Z|[+-]\d{2}:?\d{2})$", re.I)


def _parse_ts(value: Any) -> float | None:
    """Parse an ISO-8601 timestamp with explicit timezone to UTC epoch seconds."""
    if not value or not isinstance(value, str):
        return None
    s = value.strip()
    if not s or not _EXPLICIT_TZ_RE.search(s):
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            return None
        return dt.astimezone(timezone.utc).timestamp()
    except (ValueError, TypeError):
        return None


def _safe_prob(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        p = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(p):
        return None
    if p > 1.0 and p <= 100.0:
        p = p / 100.0
    if p <= 0.0 or p >= 1.0:
        return None
    return p


def _paired_bootstrap_delta(
    baseline_losses: np.ndarray,
    challenger_losses: np.ndarray,
    n_boot: int,
    seed: int,
) -> dict[str, float | None]:
    """Paired bootstrap of (baseline - challenger) loss; positive means challenger wins."""
    n = len(baseline_losses)
    if n == 0:
        return {"mean_gain": None, "ci95_lo": None, "ci95_hi": None, "prob_better": None}
    diff = baseline_losses - challenger_losses
    obs = float(np.mean(diff))
    if n < 2 or n_boot <= 0:
        return {
            "mean_gain": obs,
            "ci95_lo": obs,
            "ci95_hi": obs,
            "prob_better": 1.0 if obs > 0 else 0.0,
        }
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, n, size=(n_boot, n))
    boot_means = np.mean(diff[idx], axis=1)
    lo, hi = np.percentile(boot_means, [2.5, 97.5])
    return {
        "mean_gain": obs,
        "ci95_lo": float(lo),
        "ci95_hi": float(hi),
        "prob_better": float(np.mean(boot_means > 0.0)),
    }


def _compute_model_clv(
    model_probs: list[float],
    market_open_probs: list[float],
    market_close_probs: list[float | None],
    edge_threshold: float,
) -> dict[str, Any]:
    """Compute mean CLV (closing no-vig minus open no-vig in model's favored direction).

    Exact ties (|p_model - p_open| < 1e-12) carry no directional bet signal and
    are excluded instead of biasing toward home.
    """
    all_clvs: list[float] = []
    value_clvs: list[float] = []
    for p_mod, p_open, p_close in zip(model_probs, market_open_probs, market_close_probs):
        if p_close is None:
            continue
        edge_home = p_mod - p_open
        if abs(edge_home) < 1e-12:
            continue
        clv = (p_close - p_open) if edge_home > 0 else (p_open - p_close)
        all_clvs.append(clv)
        if abs(edge_home) >= edge_threshold:
            value_clvs.append(clv)

    return {
        "clv_all_n": len(all_clvs),
        "mean_clv_all": float(np.mean(all_clvs)) if all_clvs else None,
        "clv_value_n": len(value_clvs),
        "mean_clv_value": float(np.mean(value_clvs)) if value_clvs else None,
        "clv_n": len(value_clvs) if value_clvs else len(all_clvs),
        "mean_clv": (
            float(np.mean(value_clvs))
            if value_clvs
            else (float(np.mean(all_clvs)) if all_clvs else None)
        ),
    }


def _loss_arrays(probs: list[float], y_arr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    p_arr = np.clip(np.asarray(probs, dtype=float), 1e-15, 1.0 - 1e-15)
    brier_vec = (p_arr - y_arr) ** 2
    ll_vec = -(y_arr * np.log(p_arr) + (1.0 - y_arr) * np.log(1.0 - p_arr))
    return brier_vec, ll_vec


def evaluate_shadow_tournament(
    records: list[dict[str, Any]],
    *,
    challenger_ids: list[str] | None = None,
    min_common_games: int = DEFAULT_MIN_COMMON_GAMES,
    min_clv_games: int = DEFAULT_MIN_CLV_GAMES,
    min_brier_gain: float = DEFAULT_MIN_BRIER_GAIN,
    min_logloss_gain: float = DEFAULT_MIN_LOGLOSS_GAIN,
    max_accuracy_drop: float = DEFAULT_MAX_ACCURACY_DROP,
    min_bootstrap_prob_better: float = DEFAULT_MIN_BOOTSTRAP_PROB_BETTER,
    clv_edge_threshold: float = DEFAULT_CLV_EDGE_THRESHOLD,
    require_positive_clv: bool = True,
    bootstrap_samples: int = DEFAULT_BOOTSTRAP_SAMPLES,
    seed: int = 42,
) -> dict[str, Any]:
    """Evaluate all models on settled common games with fail-closed promotion gates.

    Each challenger is evaluated on its own pairwise common games against
    (heuristic_v1, no_vig_market) so newly added shadow models cannot starve
    mature challengers; an all-models intersection leaderboard is also emitted.
    """
    if not records:
        return {
            "verdict": "INSUFFICIENT_DATA",
            "winner_model_id": None,
            "rule_simplification_eligible": False,
            "recommended_rule_profile": "default",
            "common_games": 0,
            "all_models_common_games": 0,
            "min_common_games": min_common_games,
            "leaderboard": [],
            "comparisons": {},
            "reasons": ["no_records_provided"],
        }

    if challenger_ids is None:
        seen: set[str] = set()
        for rec in records:
            models = rec.get("models") or {}
            for mid in models.keys():
                if mid not in (CONTROL_MODEL_ID, MARKET_BASELINE_ID):
                    seen.add(mid)
        active_challengers = sorted(seen)
    else:
        active_challengers = [
            m for m in challenger_ids if m not in (CONTROL_MODEL_ID, MARKET_BASELINE_ID)
        ]

    # Base pool: settled games with valid market baseline + heuristic_v1 control.
    base_rows: list[dict[str, Any]] = []
    for rec in records:
        y = rec.get("home_won")
        if y is None:
            continue
        p_mkt = _safe_prob(rec.get("market_no_vig_home_prob"))
        models = rec.get("models") or {}
        p_ctrl = _safe_prob(models.get(CONTROL_MODEL_ID))
        if p_mkt is None or p_ctrl is None:
            continue
        cleaned_models: dict[str, float] = {
            CONTROL_MODEL_ID: p_ctrl,
            MARKET_BASELINE_ID: p_mkt,
        }
        for cid in active_challengers:
            p_c = _safe_prob(models.get(cid))
            if p_c is not None:
                cleaned_models[cid] = p_c
        base_rows.append({
            "game_pk": str(rec.get("game_pk", "")),
            "date_ymd": str(rec.get("date_ymd", "")),
            "home_won": 1 if bool(y) else 0,
            "market_no_vig_home_prob": p_mkt,
            "closing_no_vig_home_prob": _safe_prob(rec.get("closing_no_vig_home_prob")),
            "models": cleaned_models,
        })

    if not base_rows:
        return {
            "verdict": "INSUFFICIENT_DATA",
            "winner_model_id": None,
            "rule_simplification_eligible": False,
            "recommended_rule_profile": "default",
            "common_games": 0,
            "all_models_common_games": 0,
            "min_common_games": min_common_games,
            "leaderboard": [],
            "comparisons": {},
            "reasons": ["no_common_settled_games_across_models"],
        }

    # Full-field intersection (all active challengers present simultaneously).
    all_common = [
        r for r in base_rows
        if all(cid in r["models"] for cid in active_challengers)
    ]

    # Leaderboard on all_common when non-empty, else on base_rows for control & market.
    lb_rows = all_common if all_common else base_rows
    lb_outcomes = [r["home_won"] for r in lb_rows]
    lb_open = [r["market_no_vig_home_prob"] for r in lb_rows]
    lb_close = [r["closing_no_vig_home_prob"] for r in lb_rows]
    lb_model_ids = (
        [CONTROL_MODEL_ID, MARKET_BASELINE_ID] + active_challengers
        if all_common
        else [CONTROL_MODEL_ID, MARKET_BASELINE_ID]
    )
    leaderboard_entries: list[dict[str, Any]] = []
    for mid in lb_model_ids:
        probs = [r["models"][mid] for r in lb_rows]
        m = model_metrics(probs, lb_outcomes)
        m.update(_compute_model_clv(probs, lb_open, lb_close, clv_edge_threshold))
        m["model_id"] = mid
        leaderboard_entries.append(m)

    leaderboard = sorted(
        leaderboard_entries,
        key=lambda item: (
            item["log_loss"] if item["log_loss"] is not None else math.inf,
            item["brier"] if item["brier"] is not None else math.inf,
        ),
    )

    effective_min_clv = min(max(1, int(min_clv_games)), max(1, int(min_common_games)))
    comparisons: dict[str, dict[str, Any]] = {}
    passing_challengers: list[str] = []
    any_sufficient_challenger = False
    any_beats_control = False
    challenger_metrics_map: dict[str, dict[str, Any]] = {}

    for idx_c, cid in enumerate(active_challengers):
        pair_rows = [r for r in base_rows if cid in r["models"]]
        n_pair = len(pair_rows)
        if n_pair == 0:
            comparisons[cid] = {
                "common_games": 0,
                "brier_gain_vs_market": None,
                "logloss_gain_vs_market": None,
                "brier_gain_vs_control": None,
                "logloss_gain_vs_control": None,
                "accuracy_delta_vs_control": None,
                "mean_clv": None,
                "clv_n": 0,
                "bootstrap_vs_market": None,
                "bootstrap_vs_control": None,
                "passed_promotion_gate": False,
                "gate_failures": ["no_common_settled_games"],
            }
            continue

        if n_pair >= min_common_games:
            any_sufficient_challenger = True

        y_list = [r["home_won"] for r in pair_rows]
        y_arr = np.asarray(y_list, dtype=float)
        open_list = [r["market_no_vig_home_prob"] for r in pair_rows]
        close_list = [r["closing_no_vig_home_prob"] for r in pair_rows]

        ctrl_probs = [r["models"][CONTROL_MODEL_ID] for r in pair_rows]
        mkt_probs = [r["models"][MARKET_BASELINE_ID] for r in pair_rows]
        chal_probs = [r["models"][cid] for r in pair_rows]

        ctrl_m = model_metrics(ctrl_probs, y_list)
        mkt_m = model_metrics(mkt_probs, y_list)
        cm = model_metrics(chal_probs, y_list)
        cm.update(_compute_model_clv(chal_probs, open_list, close_list, clv_edge_threshold))
        challenger_metrics_map[cid] = cm

        ctrl_br_vec, ctrl_ll_vec = _loss_arrays(ctrl_probs, y_arr)
        mkt_br_vec, mkt_ll_vec = _loss_arrays(mkt_probs, y_arr)
        chal_br_vec, chal_ll_vec = _loss_arrays(chal_probs, y_arr)

        brier_vs_mkt = float(mkt_m["brier"] - cm["brier"])
        ll_vs_mkt = float(mkt_m["log_loss"] - cm["log_loss"])
        brier_vs_ctrl = float(ctrl_m["brier"] - cm["brier"])
        ll_vs_ctrl = float(ctrl_m["log_loss"] - cm["log_loss"])
        acc_vs_ctrl = float(cm["accuracy"] - ctrl_m["accuracy"])

        boot_brier_mkt = _paired_bootstrap_delta(
            mkt_br_vec, chal_br_vec, bootstrap_samples, seed + idx_c * 17 + 1
        )
        boot_ll_mkt = _paired_bootstrap_delta(
            mkt_ll_vec, chal_ll_vec, bootstrap_samples, seed + idx_c * 17 + 2
        )
        boot_brier_ctrl = _paired_bootstrap_delta(
            ctrl_br_vec, chal_br_vec, bootstrap_samples, seed + idx_c * 17 + 3
        )
        boot_ll_ctrl = _paired_bootstrap_delta(
            ctrl_ll_vec, chal_ll_vec, bootstrap_samples, seed + idx_c * 17 + 4
        )

        beats_ctrl_brier = brier_vs_ctrl >= min_brier_gain
        beats_ctrl_ll = ll_vs_ctrl >= min_logloss_gain
        beats_mkt_brier = brier_vs_mkt >= min_brier_gain
        beats_mkt_ll = ll_vs_mkt >= min_logloss_gain
        acc_ok = acc_vs_ctrl >= -max_accuracy_drop

        gate_failures: list[str] = []
        if n_pair < min_common_games:
            gate_failures.append(f"common_games_{n_pair}_below_{min_common_games}")
        if not beats_ctrl_brier:
            gate_failures.append(f"brier_gain_vs_control_{brier_vs_ctrl:.5f}_below_{min_brier_gain}")
        if not beats_ctrl_ll:
            gate_failures.append(f"logloss_gain_vs_control_{ll_vs_ctrl:.5f}_below_{min_logloss_gain}")
        if not beats_mkt_brier:
            gate_failures.append(f"brier_gain_vs_market_{brier_vs_mkt:.5f}_below_{min_brier_gain}")
        if not beats_mkt_ll:
            gate_failures.append(f"logloss_gain_vs_market_{ll_vs_mkt:.5f}_below_{min_logloss_gain}")
        if not acc_ok:
            gate_failures.append(f"accuracy_drop_vs_control_{acc_vs_ctrl:.4f}_exceeds_{max_accuracy_drop}")

        # Paired bootstrap statistical significance gate (Log-Loss).
        if min_bootstrap_prob_better > 0.0:
            pb_mkt = boot_ll_mkt.get("prob_better")
            pb_ctrl = boot_ll_ctrl.get("prob_better")
            if pb_mkt is None or pb_mkt < min_bootstrap_prob_better:
                gate_failures.append(
                    f"bootstrap_ll_prob_better_vs_market_{pb_mkt}_below_{min_bootstrap_prob_better}"
                )
            if pb_ctrl is None or pb_ctrl < min_bootstrap_prob_better:
                gate_failures.append(
                    f"bootstrap_ll_prob_better_vs_control_{pb_ctrl}_below_{min_bootstrap_prob_better}"
                )

        # Fail-closed CLV gate: absent or undersampled closing-line evidence
        # NEVER passes when require_positive_clv is enabled.
        if require_positive_clv:
            if cm["clv_n"] == 0 or cm["mean_clv"] is None:
                gate_failures.append("clv_evidence_missing")
            elif cm["clv_n"] < effective_min_clv:
                gate_failures.append(f"clv_sample_{cm['clv_n']}_below_{effective_min_clv}")
            elif cm["mean_clv"] <= 0.0:
                gate_failures.append(f"mean_clv_nonpositive ({cm['mean_clv']:.5f})")

        passed_all = len(gate_failures) == 0
        if passed_all:
            passing_challengers.append(cid)
        if n_pair >= min_common_games and beats_ctrl_brier and beats_ctrl_ll:
            any_beats_control = True

        comparisons[cid] = {
            "common_games": n_pair,
            "metrics": cm,
            "brier_gain_vs_market": brier_vs_mkt,
            "logloss_gain_vs_market": ll_vs_mkt,
            "brier_gain_vs_control": brier_vs_ctrl,
            "logloss_gain_vs_control": ll_vs_ctrl,
            "accuracy_delta_vs_control": acc_vs_ctrl,
            "mean_clv": cm["mean_clv"],
            "clv_n": cm["clv_n"],
            "bootstrap_vs_market": {"brier": boot_brier_mkt, "log_loss": boot_ll_mkt},
            "bootstrap_vs_control": {"brier": boot_brier_ctrl, "log_loss": boot_ll_ctrl},
            "passed_promotion_gate": passed_all,
            "gate_failures": gate_failures,
        }

    max_common = max((c["common_games"] for c in comparisons.values()), default=len(base_rows))

    if passing_challengers:
        passing_challengers.sort(
            key=lambda cid: (
                challenger_metrics_map[cid]["log_loss"],
                challenger_metrics_map[cid]["brier"],
            )
        )
        winner = passing_challengers[0]
        verdict = "PROMOTE_CANDIDATE_PENDING_APPROVAL"
        simplify_ok = True
        reasons = [
            f"winner_{winner}_beats_market_and_control_on_n_{comparisons[winner]['common_games']}",
            "pending_explicit_human_approval",
        ]
    elif not active_challengers or not any_sufficient_challenger:
        verdict = "INSUFFICIENT_DATA"
        winner = None
        simplify_ok = False
        reasons = [f"common_games_{max_common}_below_minimum_{min_common_games}"]
    elif any_beats_control:
        verdict = "CONTINUE_SHADOW"
        winner = None
        simplify_ok = False
        reasons = ["challenger_beats_control_but_not_all_market_bootstrap_and_clv_gates"]
    else:
        verdict = "KEEP_V1"
        winner = None
        simplify_ok = False
        reasons = ["no_challenger_beats_control_and_market"]

    return {
        "verdict": verdict,
        "winner_model_id": winner,
        "rule_simplification_eligible": simplify_ok,
        "recommended_rule_profile": "simplified_challenger" if simplify_ok else "default",
        "common_games": max_common,
        "all_models_common_games": len(all_common),
        "min_common_games": min_common_games,
        "leaderboard": leaderboard,
        "comparisons": comparisons,
        "reasons": reasons,
    }


def _ro_uri(db_path: str) -> str:
    return f"{Path(db_path).resolve().as_uri()}?mode=ro"


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {str(r[1]) for r in rows}


def evaluate_shadow_tournament_db(
    db_path: str,
    *,
    challenger_ids: list[str] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Read-only SQLite shadow tournament evaluation across identical pregame run_ids.

    Enforces temporal validity (UTC epoch comparison as_of < first_pitch and
    producer_timestamp < first_pitch), rejects INELIGIBLE_TEMPORAL quality runs,
    requires control-row promotion_eligible = 1 when the column exists, and
    pairs market quotes using numeric UTC epoch timestamps.
    """
    conn = sqlite3.connect(_ro_uri(db_path), uri=True)
    conn.row_factory = sqlite3.Row
    try:
        pr_cols = _table_columns(conn, "prediction_runs")
        mp_cols = _table_columns(conn, "model_predictions")

        has_promo = "promotion_eligible" in mp_cols
        has_quality = "prediction_quality_status" in pr_cols
        has_producer = "producer_timestamp_utc" in pr_cols

        promo_sel = "mp.promotion_eligible" if has_promo else "1 AS promotion_eligible"
        quality_sel = "pr.prediction_quality_status" if has_quality else "NULL AS prediction_quality_status"
        producer_sel = "pr.producer_timestamp_utc" if has_producer else "NULL AS producer_timestamp_utc"

        pred_rows = conn.execute(
            f"""
            SELECT mp.run_id, mp.game_pk, mp.date_ymd, mp.model_id,
                   COALESCE(mp.final_home_probability, mp.calibrated_home_probability, mp.raw_home_probability) AS home_prob,
                   mp.market_no_vig_home_prob,
                   {promo_sel},
                   pr.as_of_utc, pr.first_pitch_utc,
                   {quality_sel}, {producer_sel},
                   go.home_team_id, go.winner_team_id
            FROM model_predictions mp
            INNER JOIN prediction_runs pr ON pr.run_id = mp.run_id
            INNER JOIN game_outcomes go ON go.game_pk = mp.game_pk
            WHERE go.winner_team_id IS NOT NULL
            ORDER BY mp.date_ymd, mp.game_pk, pr.as_of_utc
            """
        ).fetchall()

        quote_rows = conn.execute(
            """
            SELECT game_pk, home_no_vig_prob, fetched_at_utc, is_closing
            FROM market_quote_pairs
            WHERE is_eligible = 1 AND market = 'moneyline'
            """
        ).fetchall()
    finally:
        conn.close()

    quotes_by_game: dict[str, list[tuple[float, dict[str, Any]]]] = {}
    for q in quote_rows:
        d = dict(q)
        ts = _parse_ts(d.get("fetched_at_utc"))
        if ts is None:
            continue
        quotes_by_game.setdefault(str(d["game_pk"]), []).append((ts, d))
    for q_list in quotes_by_game.values():
        q_list.sort(key=lambda item: item[0])

    # Group by (game_pk, run_id), filtering strictly by numeric UTC temporal rules.
    runs_by_game: dict[str, dict[str, dict[str, Any]]] = {}
    for r in pred_rows:
        d = dict(r)
        as_of_ts = _parse_ts(d.get("as_of_utc"))
        fp_ts = _parse_ts(d.get("first_pitch_utc"))
        if as_of_ts is None or fp_ts is None or as_of_ts >= fp_ts:
            continue
        producer_ts = _parse_ts(d.get("producer_timestamp_utc"))
        if producer_ts is not None and producer_ts >= fp_ts:
            continue
        if d.get("prediction_quality_status") == "INELIGIBLE_TEMPORAL":
            continue

        gpk = str(d["game_pk"])
        rid = str(d["run_id"])
        bucket = runs_by_game.setdefault(gpk, {}).setdefault(
            rid,
            {
                "game_pk": gpk,
                "date_ymd": d["date_ymd"] or "",
                "as_of_utc": d["as_of_utc"],
                "as_of_ts": as_of_ts,
                "control_eligible": False,
                "home_won": 1 if str(d["winner_team_id"]) == str(d["home_team_id"]) else 0,
                "market_no_vig_home_prob": None,
                "closing_no_vig_home_prob": None,
                "models": {},
            },
        )
        mid = str(d["model_id"])
        prob = _safe_prob(d["home_prob"])
        if prob is not None:
            bucket["models"][mid] = prob
        if mid == CONTROL_MODEL_ID and bool(d.get("promotion_eligible")):
            bucket["control_eligible"] = True
        mkt_p = _safe_prob(d["market_no_vig_home_prob"])
        if mkt_p is not None and bucket["market_no_vig_home_prob"] is None:
            bucket["market_no_vig_home_prob"] = mkt_p

    records: list[dict[str, Any]] = []
    for gpk, runs_map in runs_by_game.items():
        # Earliest eligible pregame run where the control row is promotion-eligible.
        candidates = sorted(runs_map.values(), key=lambda x: x["as_of_ts"])
        chosen = next(
            (c for c in candidates if CONTROL_MODEL_ID in c["models"] and c["control_eligible"]),
            None,
        )
        if not chosen:
            continue

        # Pair open & closing quotes using exact numeric UTC epoch comparison.
        g_quotes = quotes_by_game.get(gpk, [])
        if chosen["market_no_vig_home_prob"] is None and g_quotes:
            as_of_ts = chosen["as_of_ts"]
            prior_q = [q for ts, q in g_quotes if ts <= as_of_ts]
            if prior_q:
                chosen["market_no_vig_home_prob"] = _safe_prob(prior_q[-1]["home_no_vig_prob"])

        closing_q = [q for _ts, q in g_quotes if q.get("is_closing")]
        if closing_q:
            chosen["closing_no_vig_home_prob"] = _safe_prob(closing_q[-1]["home_no_vig_prob"])

        records.append(chosen)

    return evaluate_shadow_tournament(records, challenger_ids=challenger_ids, **kwargs)
