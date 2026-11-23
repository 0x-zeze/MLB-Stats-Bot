"""Phase 4 unit, mathematical property, and bit-exact JS <-> Python parity tests.

Covers:
  4.1 Feature Vector v2.0 bit-exact SHA-256 hash & flattened parity (JS <-> Python)
  4.3 Shallow Monotone GBDT + fixed market offset:
      - Bit-exact JS <-> Python artifact hash & inference parity (< 1e-12),
        including native missing_dir routing
      - Universal strict monotone constraint enforcement across depth-3 trees
      - Non-linear 2-way interaction learning beating both market & linear offset
  4.4 Shadow Tournament Evaluator & Gated Rule Simplification:
      - Common-game alignment & insufficient-data (<200) gate
      - Full promotion & rule_simplification_eligible gate (Brier, Log-Loss, Acc, CLV)
      - Negative CLV blocking promotion even when Brier/Log-Loss improve
      - End-to-end read-only SQLite DB tournament evaluation
      - recommend.py fail-closed market increment gate for market_residual_gbdt_v2
"""

from __future__ import annotations

import json
import math
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np

from src.core.feature_vector_py import (
    FEATURE_VECTOR_V2_FEATURE_NAMES,
    FEATURE_VECTOR_V2_SCHEMA_VERSION,
    buildFeatureVectorV2,
    flattenFeatureVector,
)
from src.eval.metrics import brier_score, log_loss
from src.eval.recommend import recommend
from src.eval.shadow_tournament import (
    evaluate_shadow_tournament,
    evaluate_shadow_tournament_db,
)
from src.models.train_market_residual_gbdt_v2 import (
    MARKET_RESIDUAL_GBDT_V2_MODEL_ID,
    fit_monotone_residual_gbdt,
    score_gbdt_artifact,
    train_market_residual_gbdt_v2,
)
from src.models.train_market_residual_v2 import (
    _fit_offset_logistic,
    _sigmoid,
    train_market_residual_v2,
)

REPO_ROOT = Path(__file__).resolve().parents[1]


def _rich_core_inputs() -> dict:
    return {
        "game": {
            "gamePk": 778899,
            "officialDate": "2026-08-15",
            "gameDate": "2026-08-15T23:10:00Z",
            "venue": {"id": 19, "name": "Coors Field"},
            "weather": {"temp": "84", "wind": "12 mph, Out to CF"},
            "teams": {
                "away": {"team": {"id": 119}, "probablePitcher": {"id": 600001, "pitchHand": {"code": "R"}}},
                "home": {"team": {"id": 115}, "probablePitcher": {"id": 600002, "pitchHand": {"code": "L"}}},
            },
        },
        "teamStats": {
            "119": {"hitting": {"gamesPlayed": 110, "runs": 550, "ops": "0.780"}, "pitching": {"era": "3.60", "whip": "1.18"}},
            "115": {"hitting": {"gamesPlayed": 110, "runs": 528, "ops": "0.750"}, "pitching": {"era": "5.04", "whip": "1.42"}},
        },
        "standings": {
            "119": {
                "leagueRecord": {"wins": 68, "losses": 42},
                "gamesPlayed": 110,
                "runDifferential": 130,
                "records": {"splitRecords": [{"type": "lastTen", "pct": 0.7}, {"type": "left", "pct": 0.64}, {"type": "right", "pct": 0.61}]},
            },
            "115": {
                "leagueRecord": {"wins": 45, "losses": 65},
                "gamesPlayed": 110,
                "runDifferential": -120,
                "records": {"splitRecords": [{"type": "lastTen", "pct": 0.4}, {"type": "left", "pct": 0.38}, {"type": "right", "pct": 0.42}]},
            },
        },
        "pitcherStats": {
            "600001": {
                "era": "3.15", "whip": "1.08", "strikeoutsMinusWalksPercentage": 0.19, "homeRunsPer9": 0.82,
                "inningsPitched": "132.1", "gamesStarted": 21,
                "priorSeason": {"inningsPitched": "185.0", "gamesStarted": 30},
            },
            "600002": {
                "era": "4.85", "whip": "1.38", "strikeoutsMinusWalksPercentage": 0.09, "homeRunsPer9": 1.55,
                "inningsPitched": "96.0", "gamesStarted": 19,
            },
        },
        "pitcherRecentStarts": {
            "600001": {"games": 3, "innings": 19.0, "era": "2.84", "whip": "1.00", "restDays": 5},
            "600002": {"games": 3, "innings": 14.0, "era": "5.14", "whip": "1.45", "restDays": 5},
        },
        "bullpenProfiles": {
            "119": {"fatigueScore": 1.2, "backToBackRelievers": 0, "reliefEra": 3.25, "reliefWhip": 1.12},
            "115": {"fatigueScore": 3.4, "backToBackRelievers": 2, "reliefEra": 4.95, "reliefWhip": 1.44},
        },
        "scheduleFatigueProfiles": {
            "119": {"restDays": 1, "roadStreak": 4, "travelMiles": 1050, "timezoneShiftHours": 1, "fatigueScore": 0.42},
            "115": {"restDays": 0, "roadStreak": 0, "travelMiles": 0, "timezoneShiftHours": 0, "fatigueScore": 0.10},
        },
        "lineupProfiles": {
            "away": {
                "confirmed": True, "count": 9, "qualityScore": 0.08,
                "platoonOps": 0.790, "platoonWoba": 0.342,
                "platoonOpsDelta": 0.025, "platoonWobaDelta": 0.012,
                "topOrderOps": 0.855,
            },
            "home": {
                "confirmed": True, "count": 9, "qualityScore": -0.02,
                "platoonOps": 0.715, "platoonWoba": 0.308,
                "platoonOpsDelta": -0.018, "platoonWobaDelta": -0.008,
                "topOrderOps": 0.760,
            },
        },
        "statcast": {
            "teams": {"119": {"xwoba": 0.348, "barrelRate": 0.102}, "115": {"xwoba": 0.301, "barrelRate": 0.071}},
            "pitchers": {"600001": {"xera": 3.05}, "600002": {"xera": 4.92}},
        },
        "parkFactorBaselines": [
            {"id": 19, "value": {"runFactor": 1.24, "homeRunFactor": 1.18}},
            {"id": 115, "value": {"runFactor": 1.24, "homeRunFactor": 1.18}},
            {"id": 119, "value": {"runFactor": 0.96, "homeRunFactor": 1.02}},
        ],
        "headToHead": {"games": 5, "homeProbability": 40.0},
        "injuryProfiles": {"119": [{"position": "OF"}], "115": [{"position": "SS"}, {"position": "1B"}]},
        "rollingTeamStats": {},
    }


def _run_node_json(script: str, payload: dict) -> dict:
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        check=True,
    )
    return json.loads(proc.stdout)


class Phase4FeatureVectorParityTest(unittest.TestCase):
    def test_v2_feature_vector_hash_and_values_match_js_bit_exact(self) -> None:
        cases = [
            (
                _rich_core_inputs(),
                {"asOfUtc": "2026-08-15T20:10:00Z", "firstPitchUtc": "2026-08-15T23:10:00Z"},
            ),
            # Sparse + south wind + opener + missing stats case.
            (
                {
                    "game": {
                        "gamePk": 990011,
                        "officialDate": "2026-04-12",
                        "weather": {"temp": "58", "wind": "9 mph, south"},
                        "teams": {
                            "away": {"team": {"id": 111}, "probablePitcher": {"id": 7001, "pitchHand": {"code": "L"}}},
                            "home": {"team": {"id": 147}},
                        },
                    },
                    "openerSituations": {"away": {"isOpener": True}},
                    "parkFactorBaselines": [{"id": 147, "value": {"runFactor": 103, "homeRunFactor": 112}}],
                },
                {"asOfUtc": "2026-04-12T16:00:00Z", "firstPitchUtc": "2026-04-12T17:05:00Z"},
            ),
        ]

        js_script = """
import { readFileSync } from 'node:fs';
import { buildFeatureVectorV2, flattenFeatureVector } from './src/core/feature_vector.js';
const payload = JSON.parse(readFileSync(0, 'utf8'));
const out = payload.cases.map(([inputs, ctx]) => {
  const vec = buildFeatureVectorV2(inputs, ctx);
  return { hash: vec.featureVectorHash, schema: vec.schemaVersion, flat: flattenFeatureVector(vec) };
});
process.stdout.write(JSON.stringify({ out }));
"""
        js_res = _run_node_json(js_script, {"cases": cases})["out"]

        for idx, (inputs, ctx) in enumerate(cases):
            py_vec = buildFeatureVectorV2(inputs, ctx)
            py_flat = flattenFeatureVector(py_vec)
            self.assertEqual(py_vec["schemaVersion"], FEATURE_VECTOR_V2_SCHEMA_VERSION)
            self.assertEqual(py_vec["featureVectorHash"], js_res[idx]["hash"])
            self.assertEqual(set(py_flat.keys()), set(js_res[idx]["flat"].keys()))
            for key, py_val in py_flat.items():
                js_val = js_res[idx]["flat"][key]
                if isinstance(py_val, float) and isinstance(js_val, (int, float)):
                    self.assertAlmostEqual(py_val, float(js_val), places=12, msg=f"case {idx} key {key}")
                else:
                    self.assertEqual(py_val, js_val, msg=f"case {idx} key {key}")


class Phase4GbdtMathAndParityTest(unittest.TestCase):
    def test_gbdt_js_python_artifact_hash_and_inference_parity(self) -> None:
        rng = np.random.default_rng(123)
        features = ["platoonDeltaDiff", "homeParkAdjOps", "awayStarterHr9", "windHittingOut"]
        n = 560
        X = np.column_stack([
            rng.normal(0.0, 0.04, size=n),
            rng.normal(0.73, 0.05, size=n),
            rng.uniform(0.5, 2.0, size=n),
            rng.integers(0, 2, size=n).astype(float),
        ])
        # Inject real NaNs so native missing_dir routing is learned and verified.
        X[rng.random(n) < 0.14, 0] = np.nan
        X[rng.random(n) < 0.14, 2] = np.nan

        mkt_p = rng.uniform(0.32, 0.68, size=n)
        mkt_logits = np.log(mkt_p / (1.0 - mkt_p))
        eff_platoon = np.where(np.isnan(X[:, 0]), -0.05, X[:, 0])
        eff_hr9 = np.where(np.isnan(X[:, 2]), 1.9, X[:, 2])
        true_z = mkt_logits + 22.0 * eff_platoon + 1.15 * (eff_hr9 - 1.1) * X[:, 3]
        y = (rng.random(n) < (1.0 / (1.0 + np.exp(-true_z)))).astype(float)

        artifact = fit_monotone_residual_gbdt(
            X[:400], y[:400], mkt_logits[:400], features,
            X_val=X[400:], y_val=y[400:], market_logits_val=mkt_logits[400:],
            max_depth=2, l2_leaf=6.0, learning_rate=0.08, max_trees=45,
            min_child_hessian=2.0, min_gain=0.02,
        )
        self.assertGreater(artifact["tree_count"], 5)
        self.assertEqual(artifact["model_id"], MARKET_RESIDUAL_GBDT_V2_MODEL_ID)

        # Build test rows covering complete + missing feature combinations.
        test_rows = [
            ({"platoonDeltaDiff": 0.03, "missing_platoonDeltaDiff": 0, "homeParkAdjOps": 0.78, "missing_homeParkAdjOps": 0, "awayStarterHr9": 1.65, "missing_awayStarterHr9": 0, "windHittingOut": 1, "missing_windHittingOut": 0}, 0.52),
            ({"platoonDeltaDiff": None, "missing_platoonDeltaDiff": 1, "homeParkAdjOps": 0.70, "missing_homeParkAdjOps": 0, "awayStarterHr9": None, "missing_awayStarterHr9": 1, "windHittingOut": 0, "missing_windHittingOut": 0}, 0.44),
            ({"platoonDeltaDiff": -0.02, "missing_platoonDeltaDiff": 0, "homeParkAdjOps": 0.74, "missing_homeParkAdjOps": 0, "awayStarterHr9": 0.85, "missing_awayStarterHr9": 0, "windHittingOut": 1, "missing_windHittingOut": 0}, 0.63),
        ]

        js_script = """
import { readFileSync } from 'node:fs';
import { verifyMarketResidualGbdtV2Artifact, scoreMarketResidualGbdtV2 } from './src/core/market_residual_gbdt_v2.js';
const payload = JSON.parse(readFileSync(0, 'utf8'));
const verify = verifyMarketResidualGbdtV2Artifact(payload.artifact);
const scores = payload.rows.map(([vec, pMkt]) => scoreMarketResidualGbdtV2(payload.artifact, vec, pMkt));
process.stdout.write(JSON.stringify({ verify, scores }));
"""
        js_out = _run_node_json(js_script, {"artifact": artifact, "rows": test_rows})
        self.assertTrue(js_out["verify"]["ok"], f"JS verify failed: {js_out['verify']}")

        for idx, (vec, p_mkt) in enumerate(test_rows):
            py_s = score_gbdt_artifact(artifact, vec, p_mkt)
            js_s = js_out["scores"][idx]
            self.assertTrue(py_s["available"])
            self.assertTrue(js_s["available"])
            self.assertAlmostEqual(py_s["homeProbability"], js_s["homeProbability"], places=12)
            self.assertAlmostEqual(py_s["residualLogit"], js_s["residualLogit"], places=12)

    def test_monotone_constraints_hold_universally_across_depth3_trees(self) -> None:
        rng = np.random.default_rng(77)
        features = ["homeParkAdjOps", "homeStarterEra", "windSpeed"]
        n = 500
        X = np.column_stack([
            rng.uniform(0.62, 0.86, size=n),
            rng.uniform(2.2, 6.2, size=n),
            rng.uniform(0.0, 22.0, size=n),
        ])
        mkt_logits = rng.normal(0.0, 0.35, size=n)
        # Deliberately include non-monotone wiggle to verify constraint prevents inversion.
        true_z = (
            mkt_logits
            + 5.0 * (X[:, 0] - 0.74)
            - 0.45 * (X[:, 1] - 4.0)
            + 0.4 * np.sin((X[:, 0] - 0.74) * 30.0)
        )
        y = (rng.random(n) < (1.0 / (1.0 + np.exp(-true_z)))).astype(float)

        artifact = fit_monotone_residual_gbdt(
            X, y, mkt_logits, features,
            monotone_constraints={"homeParkAdjOps": 1, "homeStarterEra": -1, "windSpeed": 0},
            max_depth=3, l2_leaf=4.0, learning_rate=0.1, max_trees=35,
            min_child_hessian=2.0, min_gain=0.01,
        )
        self.assertGreater(artifact["tree_count"], 5)

        # Sweep homeParkAdjOps (+1): must NEVER decrease P_home for any background.
        ops_grid = np.linspace(0.60, 0.90, 40)
        for _ in range(15):
            era_bg = float(rng.uniform(2.2, 6.2))
            wind_bg = float(rng.uniform(0.0, 22.0))
            p_mkt = float(rng.uniform(0.35, 0.65))
            preds = [
                score_gbdt_artifact(
                    artifact,
                    {"homeParkAdjOps": float(v), "homeStarterEra": era_bg, "windSpeed": wind_bg},
                    p_mkt,
                )["homeProbability"]
                for v in ops_grid
            ]
            for a, b in zip(preds[:-1], preds[1:]):
                self.assertGreaterEqual(b, a - 1e-12)

        # Sweep homeStarterEra (-1): must NEVER increase P_home for any background.
        era_grid = np.linspace(2.0, 6.5, 40)
        for _ in range(15):
            ops_bg = float(rng.uniform(0.62, 0.86))
            wind_bg = float(rng.uniform(0.0, 22.0))
            p_mkt = float(rng.uniform(0.35, 0.65))
            preds = [
                score_gbdt_artifact(
                    artifact,
                    {"homeParkAdjOps": ops_bg, "homeStarterEra": float(v), "windSpeed": wind_bg},
                    p_mkt,
                )["homeProbability"]
                for v in era_grid
            ]
            for a, b in zip(preds[:-1], preds[1:]):
                self.assertLessEqual(b, a + 1e-12)

    def test_shallow_gbdt_captures_nonlinear_interaction_better_than_linear_and_market(self) -> None:
        rng = np.random.default_rng(2026)
        features = ["awayStarterHr9", "windHittingOut", "parkHrExcess"]
        n_total = 1100
        n_train = 750
        n_val = 150

        hr9_diff = rng.uniform(-1.0, 1.0, size=n_total)
        wind_out = rng.choice([-1.0, 1.0], size=n_total)
        park_hr = rng.uniform(-0.2, 0.2, size=n_total)
        X = np.column_stack([hr9_diff, wind_out, park_hr])
        mkt_p = rng.uniform(0.38, 0.62, size=n_total)
        mkt_logits = np.log(mkt_p / (1.0 - mkt_p))

        # Pure 2-way XOR-like interaction: zero marginal linear effect on either feature alone!
        true_z = mkt_logits + 1.45 * hr9_diff * wind_out
        y = (rng.random(n_total) < (1.0 / (1.0 + np.exp(-true_z)))).astype(float)

        X_tr, y_tr, m_tr = X[:n_train], y[:n_train], mkt_logits[:n_train]
        X_va, y_va, m_va = X[n_train:n_train + n_val], y[n_train:n_train + n_val], mkt_logits[n_train:n_train + n_val]
        X_te, y_te, m_te = X[n_train + n_val:], y[n_train + n_val:], mkt_logits[n_train + n_val:]
        p_mkt_te = mkt_p[n_train + n_val:]

        # Fit linear market-offset residual baseline (cannot represent XOR interaction).
        b_lin, w_lin = _fit_offset_logistic(X_tr, y_tr, m_tr, c=1.0)
        p_lin_te = _sigmoid(m_te + b_lin + X_te @ w_lin)

        # Fit shallow depth-2 GBDT (unconstrained on interaction inputs).
        gbdt = fit_monotone_residual_gbdt(
            X_tr, y_tr, m_tr, features,
            X_val=X_va, y_val=y_va, market_logits_val=m_va,
            monotone_constraints={},
            max_depth=2, l2_leaf=5.0, learning_rate=0.08, max_trees=60,
            min_child_hessian=2.0, min_gain=0.02,
        )
        p_gbdt_te = [
            score_gbdt_artifact(
                gbdt,
                {name: float(X_te[i, j]) for j, name in enumerate(features)},
                float(p_mkt_te[i]),
            )["homeProbability"]
            for i in range(len(y_te))
        ]
        y_te_int = [int(v) for v in y_te]

        ll_mkt = log_loss(p_mkt_te, y_te_int)
        ll_lin = log_loss(p_lin_te, y_te_int)
        ll_gbdt = log_loss(p_gbdt_te, y_te_int)
        br_mkt = brier_score(p_mkt_te, y_te_int)
        br_gbdt = brier_score(p_gbdt_te, y_te_int)

        self.assertLess(ll_gbdt, ll_mkt - 0.02)
        self.assertLess(ll_gbdt, ll_lin - 0.02)
        self.assertLess(br_gbdt, br_mkt - 0.008)


class Phase4ShadowTournamentAndRecommendTest(unittest.TestCase):
    def _synthetic_records(
        self,
        n: int,
        *,
        positive_clv: bool = True,
        challenger_wins: bool = True,
        mkt_noise: float = 0.135,
    ) -> list[dict]:
        rng = np.random.default_rng(99)
        recs = []
        for i in range(n):
            p_true = float(rng.uniform(0.24, 0.76))
            y = 1 if rng.random() < p_true else 0
            # Market noisier than true prob; control noisier still.
            p_mkt = float(np.clip(p_true + rng.normal(0.0, mkt_noise), 0.12, 0.88))
            p_ctrl = float(np.clip(p_true + rng.normal(0.0, mkt_noise + 0.04), 0.12, 0.88))
            if challenger_wins:
                p_gbdt = float(np.clip(p_true + rng.normal(0.0, 0.015), 0.12, 0.88))
                p_lin = float(np.clip(p_true + rng.normal(0.0, 0.055), 0.12, 0.88))
            else:
                p_gbdt = float(np.clip(p_true + rng.normal(0.0, 0.18), 0.12, 0.88))
                p_lin = float(np.clip(p_true + rng.normal(0.0, 0.16), 0.12, 0.88))

            # Closing line moves toward p_gbdt if positive_clv else away from p_gbdt.
            direction = 1.0 if p_gbdt >= p_mkt else -1.0
            shift = (0.018 if positive_clv else -0.018) * direction
            p_close = float(np.clip(p_mkt + shift, 0.10, 0.90))

            recs.append({
                "game_pk": str(10000 + i),
                "date_ymd": f"2026-07-{(i % 28) + 1:02d}",
                "home_won": y,
                "market_no_vig_home_prob": p_mkt,
                "closing_no_vig_home_prob": p_close,
                "models": {
                    "heuristic_v1": p_ctrl,
                    "market_residual_v2": p_lin,
                    "market_residual_gbdt_v2": p_gbdt,
                },
            })
        return recs

    def test_insufficient_data_blocks_promotion_and_rule_simplification(self) -> None:
        recs = self._synthetic_records(120, positive_clv=True, challenger_wins=True)
        res = evaluate_shadow_tournament(recs, min_common_games=200)
        self.assertEqual(res["verdict"], "INSUFFICIENT_DATA")
        self.assertIsNone(res["winner_model_id"])
        self.assertFalse(res["rule_simplification_eligible"])
        self.assertEqual(res["recommended_rule_profile"], "default")
        self.assertEqual(res["common_games"], 120)

    def test_passing_challenger_unlocks_promotion_candidate_and_rule_simplification(self) -> None:
        recs = self._synthetic_records(240, positive_clv=True, challenger_wins=True)
        res = evaluate_shadow_tournament(recs, min_common_games=200)
        self.assertEqual(res["verdict"], "PROMOTE_CANDIDATE_PENDING_APPROVAL")
        self.assertEqual(res["winner_model_id"], "market_residual_gbdt_v2")
        self.assertTrue(res["rule_simplification_eligible"])
        self.assertEqual(res["recommended_rule_profile"], "simplified_challenger")
        comp = res["comparisons"]["market_residual_gbdt_v2"]
        self.assertTrue(comp["passed_promotion_gate"])
        self.assertGreater(comp["brier_gain_vs_market"], 0.001)
        self.assertGreater(comp["logloss_gain_vs_market"], 0.003)
        self.assertGreater(comp["mean_clv"], 0.0)

    def test_negative_clv_blocks_promotion_and_keeps_default_rules(self) -> None:
        recs = self._synthetic_records(240, positive_clv=False, challenger_wins=True)
        res = evaluate_shadow_tournament(recs, min_common_games=200)
        self.assertEqual(res["verdict"], "CONTINUE_SHADOW")
        self.assertIsNone(res["winner_model_id"])
        self.assertFalse(res["rule_simplification_eligible"])
        self.assertEqual(res["recommended_rule_profile"], "default")
        failures = res["comparisons"]["market_residual_gbdt_v2"]["gate_failures"]
        self.assertTrue(any("mean_clv_nonpositive" in f for f in failures))

    def test_losing_challenger_returns_keep_v1(self) -> None:
        recs = self._synthetic_records(220, positive_clv=False, challenger_wins=False)
        res = evaluate_shadow_tournament(recs, min_common_games=200)
        self.assertEqual(res["verdict"], "KEEP_V1")
        self.assertFalse(res["rule_simplification_eligible"])

    def test_sqlite_db_shadow_tournament_evaluation(self) -> None:
        recs = self._synthetic_records(210, positive_clv=True, challenger_wins=True)
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = str(Path(tmpdir) / "tournament.db")
            conn = sqlite3.connect(db_path)
            conn.executescript(
                """
                CREATE TABLE prediction_runs (
                    run_id TEXT PRIMARY KEY,
                    game_pk TEXT,
                    date_ymd TEXT,
                    as_of_utc TEXT,
                    first_pitch_utc TEXT
                );
                CREATE TABLE model_predictions (
                    run_id TEXT,
                    game_pk TEXT,
                    date_ymd TEXT,
                    model_id TEXT,
                    raw_home_probability REAL,
                    calibrated_home_probability REAL,
                    final_home_probability REAL,
                    market_no_vig_home_prob REAL
                );
                CREATE TABLE game_outcomes (
                    game_pk TEXT PRIMARY KEY,
                    home_team_id TEXT,
                    winner_team_id TEXT
                );
                CREATE TABLE market_quote_pairs (
                    game_pk TEXT,
                    market TEXT,
                    is_eligible INTEGER,
                    home_no_vig_prob REAL,
                    fetched_at_utc TEXT,
                    is_closing INTEGER
                );
                """
            )
            for rec in recs:
                gpk = rec["game_pk"]
                rid = f"run-{gpk}"
                date_ymd = rec["date_ymd"]
                as_of = f"{date_ymd}T18:00:00Z"
                first_pitch = f"{date_ymd}T23:05:00Z"
                conn.execute(
                    "INSERT INTO prediction_runs VALUES (?, ?, ?, ?, ?)",
                    (rid, gpk, date_ymd, as_of, first_pitch),
                )
                winner = "100" if rec["home_won"] == 1 else "200"
                conn.execute("INSERT INTO game_outcomes VALUES (?, '100', ?)", (gpk, winner))
                conn.execute(
                    "INSERT INTO market_quote_pairs VALUES (?, 'moneyline', 1, ?, ?, 0)",
                    (gpk, rec["market_no_vig_home_prob"], f"{date_ymd}T17:55:00Z"),
                )
                conn.execute(
                    "INSERT INTO market_quote_pairs VALUES (?, 'moneyline', 1, ?, ?, 1)",
                    (gpk, rec["closing_no_vig_home_prob"], f"{date_ymd}T23:00:00Z"),
                )
                for mid, prob in rec["models"].items():
                    conn.execute(
                        "INSERT INTO model_predictions VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (rid, gpk, date_ymd, mid, prob, prob, prob, rec["market_no_vig_home_prob"]),
                    )
            conn.commit()
            conn.close()

            report = evaluate_shadow_tournament_db(db_path, min_common_games=200)
            self.assertEqual(report["common_games"], 210)
            self.assertEqual(report["verdict"], "PROMOTE_CANDIDATE_PENDING_APPROVAL")
            self.assertEqual(report["winner_model_id"], "market_residual_gbdt_v2")
            self.assertTrue(report["rule_simplification_eligible"])

    def test_recommend_enforces_market_increment_gate_for_gbdt(self) -> None:
        ctrl = {"n": 100, "brier": 0.245, "log_loss": 0.685, "accuracy": 0.56}
        chal = {"n": 100, "brier": 0.238, "log_loss": 0.672, "accuracy": 0.58}
        mkt_better = {"n": 100, "brier": 0.2375, "log_loss": 0.671, "accuracy": 0.58}
        mkt_worse = {"n": 100, "brier": 0.241, "log_loss": 0.679, "accuracy": 0.57}

        # Missing market comparison -> fail-closed (shadow, not promote).
        r_missing = recommend(
            ctrl, chal,
            challenger_model_id=MARKET_RESIDUAL_GBDT_V2_MODEL_ID,
            market_holdout=None,
            fold_stability_ok=True, subgroup_failure=False, replay_verified=True, human_approved=True,
        )
        self.assertFalse(r_missing["promotion_eligible"])
        self.assertEqual(r_missing["recommendation"], "RUN V2 IN SHADOW")

        # Market beats challenger -> KEEP V1.
        r_no_inc = recommend(
            ctrl, chal,
            challenger_model_id=MARKET_RESIDUAL_GBDT_V2_MODEL_ID,
            market_holdout=mkt_better,
            fold_stability_ok=True, subgroup_failure=False, replay_verified=True, human_approved=True,
        )
        self.assertFalse(r_no_inc["promotion_eligible"])
        self.assertEqual(r_no_inc["recommendation"], "KEEP V1")

        # Challenger beats both control AND market + human approved -> PROMOTE MARKET RESIDUAL GBDT V2.
        r_ok = recommend(
            ctrl, chal,
            challenger_model_id=MARKET_RESIDUAL_GBDT_V2_MODEL_ID,
            market_holdout=mkt_worse,
            fold_stability_ok=True, subgroup_failure=False, replay_verified=True, human_approved=True,
        )
        self.assertTrue(r_ok["promotion_eligible"])
        self.assertEqual(r_ok["recommendation"], "PROMOTE MARKET RESIDUAL GBDT V2")


class Phase4DeepAuditRegressionsTest(unittest.TestCase):
    def test_audit4_opener_ratio_last_start_date_and_naive_ts_parity(self) -> None:
        ci = _rich_core_inputs()
        ci["pitcherStats"]["600001"] = {
            "era": "3.20", "whip": "1.10", "gamesStarted": 2, "gamesPitched": 24, "inningsPitched": "30.0"
        }
        ci["game"]["teams"]["home"]["note"] = "Home opener celebration"
        ci["pitcherRecentStarts"]["600002"] = {
            "games": 3, "innings": 18.0, "era": "4.10", "whip": "1.30", "lastStartDate": "2026-08-11"
        }
        ctx = {"asOfUtc": "2026-08-15T20:10:00", "firstPitchUtc": "2026-08-15T23:10:00Z"}

        js_script = """
import { readFileSync } from 'node:fs';
import { buildFeatureVectorV2, flattenFeatureVector } from './src/core/feature_vector.js';
const { ci, ctx } = JSON.parse(readFileSync(0, 'utf8'));
const vec = buildFeatureVectorV2(ci, ctx);
process.stdout.write(JSON.stringify({ hash: vec.featureVectorHash, flat: flattenFeatureVector(vec) }));
"""
        js_res = _run_node_json(js_script, {"ci": ci, "ctx": ctx})
        py_vec = buildFeatureVectorV2(ci, ctx)
        self.assertEqual(py_vec["featureVectorHash"], js_res["hash"])
        self.assertEqual(py_vec["awayStarterProjectedIp"]["value"], 1.75)
        self.assertIsNone(py_vec["leadTimeMinutes"]["value"])
        self.assertEqual(py_vec["leadTimeMinutes"]["missing"], 1)

    def test_audit5a_unseen_missingness_routes_to_majority_hessian_child(self) -> None:
        rng = np.random.default_rng(314)
        n = 300
        # 85% of samples on the RIGHT (x > 0), 15% on the LEFT (x < 0) with strong negative residual.
        is_minority = np.arange(n) < 45
        x = np.where(is_minority, rng.uniform(-2.0, -1.0, size=n), rng.uniform(0.5, 2.0, size=n))
        X = x.reshape(-1, 1)
        mkt_logits = np.zeros(n, dtype=float)
        y = np.where(is_minority, 0.0, 0.65)
        y = (rng.random(n) < y).astype(float)

        art = fit_monotone_residual_gbdt(
            X, y, mkt_logits, ["signal"],
            monotone_constraints={},
            max_depth=1, l2_leaf=2.0, learning_rate=0.1, max_trees=3,
            min_child_hessian=2.0, min_gain=0.01,
        )
        self.assertGreater(art["tree_count"], 0)
        root = art["trees"][0]["nodes"][0]
        self.assertFalse(root["leaf"])
        # Majority of Hessian is in the right branch -> unseen missingness must route RIGHT!
        self.assertEqual(root["missing_dir"], "right")

    def test_audit3a_missing_clv_fails_closed_when_required(self) -> None:
        recs = Phase4ShadowTournamentAndRecommendTest()._synthetic_records(
            240, positive_clv=True, challenger_wins=True
        )
        for r in recs:
            r["closing_no_vig_home_prob"] = None

        res = evaluate_shadow_tournament(recs, min_common_games=200, require_positive_clv=True)
        self.assertNotEqual(res["verdict"], "PROMOTE_CANDIDATE_PENDING_APPROVAL")
        self.assertFalse(res["rule_simplification_eligible"])
        self.assertEqual(res["recommended_rule_profile"], "default")
        failures = res["comparisons"]["market_residual_gbdt_v2"]["gate_failures"]
        self.assertIn("clv_evidence_missing", failures)

    def test_audit3d_new_challenger_does_not_starve_mature_challenger(self) -> None:
        recs = Phase4ShadowTournamentAndRecommendTest()._synthetic_records(
            240, positive_clv=True, challenger_wins=True
        )
        # Simulate market_residual_gbdt_v2 only launched on the last 15 games while
        # market_residual_v2 has all 240 games (make market_residual_v2 strong).
        for idx, r in enumerate(recs):
            gbdt_p = r["models"]["market_residual_gbdt_v2"]
            r["models"]["market_residual_v2"] = gbdt_p
            if idx < 225:
                del r["models"]["market_residual_gbdt_v2"]

        res = evaluate_shadow_tournament(recs, min_common_games=200)
        self.assertEqual(res["all_models_common_games"], 15)
        self.assertEqual(res["comparisons"]["market_residual_v2"]["common_games"], 240)
        self.assertEqual(res["comparisons"]["market_residual_gbdt_v2"]["common_games"], 15)
        self.assertEqual(res["verdict"], "PROMOTE_CANDIDATE_PENDING_APPROVAL")
        self.assertEqual(res["winner_model_id"], "market_residual_v2")
        self.assertTrue(res["rule_simplification_eligible"])

    def test_audit3bc_db_tournament_enforces_eligibility_and_utc_epoch_quote_pairing(self) -> None:
        recs = Phase4ShadowTournamentAndRecommendTest()._synthetic_records(
            220, positive_clv=True, challenger_wins=True
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = str(Path(tmpdir) / "strict_tournament.db")
            conn = sqlite3.connect(db_path)
            conn.executescript(
                """
                CREATE TABLE prediction_runs (
                    run_id TEXT PRIMARY KEY,
                    game_pk TEXT,
                    date_ymd TEXT,
                    as_of_utc TEXT,
                    first_pitch_utc TEXT,
                    producer_timestamp_utc TEXT,
                    prediction_quality_status TEXT
                );
                CREATE TABLE model_predictions (
                    run_id TEXT,
                    game_pk TEXT,
                    date_ymd TEXT,
                    model_id TEXT,
                    raw_home_probability REAL,
                    calibrated_home_probability REAL,
                    final_home_probability REAL,
                    market_no_vig_home_prob REAL,
                    promotion_eligible INTEGER
                );
                CREATE TABLE game_outcomes (
                    game_pk TEXT PRIMARY KEY,
                    home_team_id TEXT,
                    winner_team_id TEXT
                );
                CREATE TABLE market_quote_pairs (
                    game_pk TEXT,
                    market TEXT,
                    is_eligible INTEGER,
                    home_no_vig_prob REAL,
                    fetched_at_utc TEXT,
                    is_closing INTEGER
                );
                """
            )
            for idx, rec in enumerate(recs):
                gpk = rec["game_pk"]
                rid = f"run-{gpk}"
                date_ymd = rec["date_ymd"]
                # Mix Z and +00:00 and .000Z formats to test numeric UTC epoch comparison!
                as_of = f"{date_ymd}T18:00:00Z"
                first_pitch = f"{date_ymd}T23:05:00Z"
                # First 10 rows are non-eligible control rows or INELIGIBLE_TEMPORAL -> MUST be excluded!
                promo_ctrl = 0 if idx < 5 else 1
                quality = "INELIGIBLE_TEMPORAL" if 5 <= idx < 10 else "PROMOTION_ELIGIBLE"
                conn.execute(
                    "INSERT INTO prediction_runs VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (rid, gpk, date_ymd, as_of, first_pitch, as_of, quality),
                )
                winner = "100" if rec["home_won"] == 1 else "200"
                conn.execute("INSERT INTO game_outcomes VALUES (?, '100', ?)", (gpk, winner))
                # Pre-as_of quote with +00:00 offset, plus a post-as_of quote that MUST be ignored for open.
                conn.execute(
                    "INSERT INTO market_quote_pairs VALUES (?, 'moneyline', 1, ?, ?, 0)",
                    (gpk, rec["market_no_vig_home_prob"], f"{date_ymd}T17:55:00+00:00"),
                )
                conn.execute(
                    "INSERT INTO market_quote_pairs VALUES (?, 'moneyline', 1, ?, ?, 0)",
                    (gpk, 0.99, f"{date_ymd}T19:00:00.000Z"),
                )
                conn.execute(
                    "INSERT INTO market_quote_pairs VALUES (?, 'moneyline', 1, ?, ?, 1)",
                    (gpk, rec["closing_no_vig_home_prob"], f"{date_ymd}T23:00:00+00:00"),
                )
                for mid, prob in rec["models"].items():
                    # Shadow rows legitimately carry promotion_eligible = 0!
                    promo = promo_ctrl if mid == "heuristic_v1" else 0
                    conn.execute(
                        "INSERT INTO model_predictions VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
                        (rid, gpk, date_ymd, mid, prob, prob, prob, promo),
                    )
            conn.commit()
            conn.close()

            report = evaluate_shadow_tournament_db(db_path, min_common_games=200)
            # 10 ineligible rows excluded => exactly 210 clean common games!
            self.assertEqual(report["common_games"], 210)
            self.assertEqual(report["verdict"], "PROMOTE_CANDIDATE_PENDING_APPROVAL")

    def test_audit3d_bootstrap_gate_blocks_noisy_point_estimate(self) -> None:
        # Weak signal vs market (mkt_noise=0.06) may show tiny point gain but fails bootstrap prob_better >= 0.80.
        recs = Phase4ShadowTournamentAndRecommendTest()._synthetic_records(
            220, positive_clv=True, challenger_wins=True, mkt_noise=0.06
        )
        res = evaluate_shadow_tournament(recs, min_common_games=200, min_bootstrap_prob_better=0.85)
        self.assertNotEqual(res["verdict"], "PROMOTE_CANDIDATE_PENDING_APPROVAL")
        self.assertFalse(res["rule_simplification_eligible"])

    def test_audit1_and_6_end_to_end_sqlite_v2_hydration_for_gbdt_and_linear(self) -> None:
        """End-to-end DB trainer test: prediction_runs stores v1.0, feature_snapshots stores coreInputs."""
        from datetime import datetime, timedelta, timezone
        from src.core.feature_vector_py import buildFeatureVector

        migrations_dir = REPO_ROOT / "src" / "storage" / "migrations"
        rng = np.random.default_rng(2026)

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = str(Path(tmpdir) / "e2e_v2.sqlite")
            conn = sqlite3.connect(db_path)
            try:
                conn.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS schema_migrations (
                        id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS feature_snapshots (
                        game_pk TEXT NOT NULL,
                        feature_group TEXT NOT NULL,
                        date_ymd TEXT,
                        payload TEXT NOT NULL,
                        timestamp TEXT,
                        PRIMARY KEY (game_pk, feature_group)
                    );
                    """
                )
                for fname in sorted(p.name for p in migrations_dir.glob("*.sql")):
                    if fname.replace(".sql", "") in {"004_append_only_picks", "005_shadow_ledger"}:
                        continue
                    conn.executescript((migrations_dir / fname).read_text(encoding="utf-8"))

                base_dt = datetime(2026, 4, 1, 12, 0, 0, tzinfo=timezone.utc)
                n_games = 160
                for i in range(n_games):
                    gpk = 50000 + i
                    day = base_dt + timedelta(days=i // 2)
                    first_pitch = day + timedelta(hours=11)
                    as_of = day + timedelta(hours=7)
                    ci = _rich_core_inputs()
                    ci["game"]["gamePk"] = gpk
                    ci["game"]["officialDate"] = day.strftime("%Y-%m-%d")
                    ci["game"]["gameDate"] = first_pitch.isoformat().replace("+00:00", "Z")
                    # Plant strong v2-only signal in platoonWobaDelta (absent in v1.0!).
                    p_delta = float(rng.uniform(-0.045, 0.045))
                    ci["lineupProfiles"]["home"]["platoonWobaDelta"] = p_delta
                    ci["lineupProfiles"]["away"]["platoonWobaDelta"] = -p_delta
                    mkt_p = float(rng.uniform(0.38, 0.62))
                    mkt_logit = math.log(mkt_p / (1.0 - mkt_p))
                    true_p = 1.0 / (1.0 + math.exp(-(mkt_logit + 28.0 * (2.0 * p_delta))))
                    home_won = rng.random() < true_p

                    # Store ONLY v1.0 in prediction_runs (matching live storage.js!),
                    # and frozen coreInputs in feature_snapshots.
                    flat_v1 = flattenFeatureVector(buildFeatureVector(ci))
                    snap_hash = f"snap-{gpk:06d}"
                    rid = f"run-{gpk}"
                    conn.execute(
                        "INSERT INTO prediction_runs (run_id, game_pk, market, date_ymd, "
                        "prediction_timestamp_utc, as_of_utc, first_pitch_utc, created_at, "
                        "model_id, information_state, producer_timestamp_utc, feature_hash, "
                        "snapshot_hash, normalized_feature_vector, feature_manifest_version, core_inputs_hash) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            rid, str(gpk), "moneyline", day.strftime("%Y-%m-%d"),
                            as_of.isoformat().replace("+00:00", "Z"),
                            as_of.isoformat().replace("+00:00", "Z"),
                            first_pitch.isoformat().replace("+00:00", "Z"),
                            as_of.isoformat().replace("+00:00", "Z"),
                            "heuristic_v1", "confirmed_lineup",
                            as_of.isoformat().replace("+00:00", "Z"),
                            flat_v1["featureVectorHash"], snap_hash,
                            json.dumps(flat_v1), "mlb-feature-vector-v1.0", f"ci-{gpk}",
                        ),
                    )
                    conn.execute(
                        "INSERT INTO feature_snapshots (game_pk, feature_group, date_ymd, payload, timestamp) "
                        "VALUES (?, 'prediction_decision_snapshot', ?, ?, ?)",
                        (
                            str(gpk), day.strftime("%Y-%m-%d"),
                            json.dumps({"snapshotHash": snap_hash, "coreInputs": ci}),
                            as_of.isoformat().replace("+00:00", "Z"),
                        ),
                    )
                    conn.execute(
                        "INSERT INTO model_predictions (run_id, game_pk, date_ymd, model_id, "
                        "model_impl_version, feature_schema_version, raw_home_probability, "
                        "raw_away_probability, calibrated_home_probability, calibrated_away_probability, "
                        "final_home_probability, final_away_probability, pick_side, pick_team_id, "
                        "pick_probability, status, as_of_utc, first_pitch_utc, information_state, "
                        "promotion_eligible, created_at) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            rid, str(gpk), day.strftime("%Y-%m-%d"), "heuristic_v1",
                            "moneyline-core-v1.0", "mlb-control-features-v1.0",
                            mkt_p, 1.0 - mkt_p, mkt_p, 1.0 - mkt_p, mkt_p, 1.0 - mkt_p,
                            "home" if mkt_p >= 0.5 else "away", "115" if mkt_p >= 0.5 else "119",
                            max(mkt_p, 1.0 - mkt_p), "NO_BET",
                            as_of.isoformat().replace("+00:00", "Z"),
                            first_pitch.isoformat().replace("+00:00", "Z"),
                            "confirmed_lineup", 1, as_of.isoformat().replace("+00:00", "Z"),
                        ),
                    )
                    conn.execute(
                        "INSERT INTO game_outcomes (game_pk, date_ymd, home_team_id, away_team_id, "
                        "home_score, away_score, winner_team_id, loser_team_id, recorded_at) "
                        "VALUES (?,?,?,?,?,?,?,?,?)",
                        (
                            str(gpk), day.strftime("%Y-%m-%d"), "115", "119",
                            5 if home_won else 2, 2 if home_won else 5,
                            "115" if home_won else "119", "119" if home_won else "115",
                            (first_pitch + timedelta(hours=4)).isoformat().replace("+00:00", "Z"),
                        ),
                    )
                    conn.execute(
                        "INSERT INTO market_quote_pairs (quote_pair_id, game_pk, bookmaker, market, "
                        "home_odds, away_odds, home_implied_prob, away_implied_prob, overround, "
                        "home_no_vig_prob, away_no_vig_prob, fetched_at_utc, is_eligible, created_at) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)",
                        (
                            f"qp-{gpk}", str(gpk), "pinnacle", "moneyline",
                            -110, -110, mkt_p, 1.0 - mkt_p, 0.04,
                            mkt_p, 1.0 - mkt_p,
                            (as_of - timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
                            as_of.isoformat().replace("+00:00", "Z"),
                        ),
                    )
                conn.commit()
            finally:
                conn.close()

            # 1) End-to-end GBDT v2.0 training from DB:
            gbdt_rep = train_market_residual_gbdt_v2(
                db_path, feature_schema_version=FEATURE_VECTOR_V2_SCHEMA_VERSION
            )
            self.assertEqual(gbdt_rep["status"], "trained", f"gbdt failed: {gbdt_rep.get('reasons')}")
            self.assertEqual(gbdt_rep["v2_hydration_summary"]["hydrated_from_snapshots"], n_games)
            self.assertEqual(gbdt_rep["artifact"]["feature_schema_version"], FEATURE_VECTOR_V2_SCHEMA_VERSION)
            self.assertEqual(len(gbdt_rep["artifact"]["feature_names"]), 107)
            self.assertGreater(gbdt_rep["artifact"]["tree_count"], 0)
            self.assertFalse(gbdt_rep["artifact"]["zero_trees_market_efficient"])

            # Verify JS accepts the DB-trained GBDT artifact!
            js_verify = _run_node_json(
                """
import { readFileSync } from 'node:fs';
import { verifyMarketResidualGbdtV2Artifact } from './src/core/market_residual_gbdt_v2.js';
const { artifact } = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(verifyMarketResidualGbdtV2Artifact(artifact)));
""",
                {"artifact": gbdt_rep["artifact"]},
            )
            self.assertTrue(js_verify["ok"], f"JS verify failed on DB-trained GBDT: {js_verify}")

            # 2) End-to-end linear market_residual_v2 v2.0 training from DB:
            lin_rep = train_market_residual_v2(
                db_path, feature_schema_version=FEATURE_VECTOR_V2_SCHEMA_VERSION
            )
            self.assertEqual(lin_rep["status"], "trained", f"linear v2 failed: {lin_rep.get('reasons')}")
            self.assertEqual(lin_rep["v2_hydration_summary"]["hydrated_from_snapshots"], n_games)
            self.assertEqual(lin_rep["artifact"]["feature_schema_version"], FEATURE_VECTOR_V2_SCHEMA_VERSION)
            # Learned positive weight on v2-only platoonDeltaDiff!
            self.assertGreater(lin_rep["artifact"]["coefficients"]["platoonDeltaDiff"], 0.05)


if __name__ == "__main__":
    unittest.main()
