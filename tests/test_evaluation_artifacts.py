from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from scripts.build_evaluation_artifacts import build, markdown


def _db(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE picks (game_pk TEXT PRIMARY KEY, payload TEXT);
        CREATE TABLE feature_snapshots (
          game_pk TEXT, feature_group TEXT, date_ymd TEXT, payload TEXT, timestamp TEXT
        );
        CREATE TABLE prediction_runs (run_id TEXT, game_pk TEXT);
        CREATE TABLE bet_ledger (
          decision_id TEXT PRIMARY KEY,
          game_pk TEXT,
          date_ymd TEXT,
          market TEXT,
          team TEXT,
          side TEXT,
          odds REAL,
          model_prob REAL,
          edge REAL,
          units_staked REAL,
          status TEXT,
          result TEXT,
          units_pl REAL,
          clv REAL,
          selected_team_id TEXT,
          bookmaker TEXT,
          quote_id TEXT,
          calibration_version TEXT
        );
        """
    )
    conn.executemany(
        "INSERT INTO picks VALUES (?, ?)", [("g1", "{}"), ("g2", "{}")]
    )
    conn.executemany(
        """
        INSERT INTO bet_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                "d1", "g1", "2026-07-01", "moneyline", "Home", "home", -110,
                0.60, 0.06, 3.0, "settled", "win", 2.0, 0.02, "2", "Book", "q1", "cal-v1",
            ),
            (
                "d2", "g2", "2026-07-02", "moneyline", "Away", "away", 120,
                0.55, None, 1.0, "settled", "loss", -1.0, None, "1", "Book", "q2", "cal-v1",
            ),
        ],
    )
    conn.commit()
    conn.close()


def test_build_metrics_are_stake_weighted_and_missing_not_zero(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite"
    _db(path)
    report = build(path)

    ml = report["markets"]["moneyline"]
    assert ml["n_settled"] == 2
    assert ml["wins"] == 1
    assert ml["losses"] == 1
    assert ml["total_units_staked"] == 4.0
    assert ml["total_units_pl"] == 1.0
    assert ml["roi_stake_weighted"] == 0.25
    assert ml["edge_coverage"] == 1
    assert ml["average_edge"] == 0.06
    assert ml["clv_coverage"] == 1
    assert ml["average_clv"] == 0.02
    assert ml["brier_score"] is not None
    assert ml["log_loss"] is not None
    assert report["status"] == "partial"  # no prediction runs/snapshots in fixture
    assert report["population"]["usable_for_promotion"] is False


def test_empty_population_returns_null_metrics(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite"
    _db(path)
    conn = sqlite3.connect(path)
    conn.execute("DELETE FROM bet_ledger")
    conn.commit()
    conn.close()
    report = build(path)
    assert report["markets"] == {}
    assert report["status"] == "partial"
    text = markdown(report)
    assert "Status" in text
    assert "profitability claim" in text


def test_report_is_json_serializable(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite"
    _db(path)
    report = build(path)
    encoded = json.dumps(report)
    assert "roi_stake_weighted" in encoded
