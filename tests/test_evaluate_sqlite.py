import csv
import sqlite3

from src.evaluate import (
    build_prediction_log_rows_from_sqlite,
    calculate_metrics,
    filter_rows_by_market,
    load_prediction_log,
    settled_rows,
)


def _create_live_schema(path):
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE picks (
            game_pk TEXT PRIMARY KEY,
            date_ymd TEXT,
            matchup TEXT,
            pick_confidence TEXT,
            payload TEXT
        );
        CREATE TABLE bet_ledger (
            decision_id TEXT PRIMARY KEY,
            game_pk TEXT,
            date_ymd TEXT,
            market TEXT,
            team TEXT,
            side TEXT,
            line REAL,
            odds REAL,
            fair_prob REAL,
            model_prob REAL,
            edge REAL,
            units_staked REAL,
            status TEXT,
            result TEXT,
            units_pl REAL,
            clv REAL,
            recommended_at TEXT,
            settled_at TEXT
        );
        """
    )
    return conn


def test_build_prediction_log_rows_from_sqlite_maps_ledger(tmp_path):
    db_path = tmp_path / "state.sqlite"
    conn = _create_live_schema(db_path)
    conn.execute(
        "INSERT INTO picks VALUES (?, ?, ?, ?, ?)",
        (
            "1001",
            "2026-06-01",
            "Away A @ Home A",
            "High",
            '{"pick":{"name":"Home A","confidence":"High"},"marketTotal":8.5}',
        ),
    )
    conn.execute(
        "INSERT INTO picks VALUES (?, ?, ?, ?, ?)",
        ("1002", "2026-06-01", "Away B @ Home B", "Low", '{bad json'),
    )
    conn.execute(
        "INSERT INTO picks VALUES (?, ?, ?, ?, ?)",
        ("1003", "2026-06-01", "Away C @ Home C", "Medium", "{}"),
    )
    conn.execute(
        """
        INSERT INTO bet_ledger VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("d1", "1001", "2026-06-01", "moneyline", "Home A", "home", None, -120, 54, 60, 6, 2, "settled", "win", 1.667, 0.03, "rec", "set"),
    )
    conn.execute(
        """
        INSERT INTO bet_ledger VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("d2", "1002", "2026-06-01", "moneyline", "Away B", "away", None, 110, 48, 58, 10, 1, "settled", "push", 0, -0.01, "rec", "set"),
    )
    conn.execute(
        """
        INSERT INTO bet_ledger VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("d3", "1003", "2026-06-01", "moneyline", "Away C", "away", None, 105, 51, 0.57, 0.06, 1, "settled", "loss", -1, None, "rec", "set"),
    )
    conn.commit()
    conn.close()

    rows = build_prediction_log_rows_from_sqlite(db_path)

    assert len(rows) == 2
    ledger_rows = [row for row in rows if row["market_type"] == "moneyline"]
    assert len(ledger_rows) == 2
    assert ledger_rows[0]["final_lean"] == "Home A"
    assert ledger_rows[0]["home_win_probability"] == 0.6
    assert ledger_rows[0]["model_edge"] == 0.06
    assert ledger_rows[0]["market_total"] == 8.5
    assert ledger_rows[1]["final_lean"] == "Away C"

    assert len(settled_rows(rows)) == 2
    metrics = calculate_metrics(rows)
    assert metrics["bets"] == 2


def test_load_prediction_log_prefers_sqlite_then_csv(tmp_path):
    db_path = tmp_path / "state.sqlite"
    conn = _create_live_schema(db_path)
    conn.execute(
        "INSERT INTO picks VALUES (?, ?, ?, ?, ?)",
        ("1001", "2026-06-01", "Away @ Home", "High", '{"pick":{"name":"Home"}}'),
    )
    conn.execute(
        """
        INSERT INTO bet_ledger VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("d1", "1001", "2026-06-01", "moneyline", "Home", "home", None, -120, 54, 60, 6, 2, "settled", "win", 1.667, 0.03, "rec", "set"),
    )
    conn.commit()
    conn.close()

    csv_path = tmp_path / "predictions.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["final_lean", "result"])
        writer.writeheader()
        writer.writerow({"final_lean": "CSV", "result": "loss"})

    rows = load_prediction_log(csv_path, sqlite_path=db_path)
    assert rows[0]["final_lean"] == "Home"

    csv_rows = load_prediction_log(csv_path, sqlite_path=tmp_path / "missing.sqlite")
    assert csv_rows[0]["final_lean"] == "CSV"

    assert load_prediction_log(tmp_path / "missing.csv", sqlite_path=tmp_path / "missing.sqlite") == []


def test_filter_rows_by_market_returns_all_rows():
    rows = [
        {"market_type": "moneyline", "final_lean": "Home"},
        {"market_type": "moneyline", "final_lean": "Away"},
    ]

    assert [row["final_lean"] for row in filter_rows_by_market(rows, "moneyline")] == ["Home", "Away"]


def test_calculate_metrics_uses_stake_weighted_roi_and_separate_units_per_bet():
    rows = [
        {"result": "win", "profit_loss": 9.0, "units_staked": 9.0, "model_prob": 0.6},
        {"result": "loss", "profit_loss": -1.0, "units_staked": 1.0, "model_prob": 0.4},
    ]
    metrics = calculate_metrics(rows)
    assert metrics["roi"] == 0.8
    assert metrics["units_per_bet"] == 4.0
    assert metrics["total_units_staked"] == 10.0


def test_calculate_metrics_returns_null_roi_without_stake_data():
    rows = [
        {"result": "win", "profit_loss": 1.5, "units_staked": "", "model_prob": 0.6},
        {"result": "loss", "profit_loss": -1.0, "units_staked": "", "model_prob": 0.4},
    ]
    metrics = calculate_metrics(rows)
    assert metrics["roi"] is None
    assert metrics["units_per_bet"] == 0.25
    assert metrics["total_units_staked"] is None


def test_market_baselines_compare_same_period_fair_and_model_probabilities():
    from src.evaluate import market_baselines

    rows = [
        {"market_type": "moneyline", "result": "win", "fair_prob": 0.60, "model_prob": 0.55},
        {"market_type": "moneyline", "result": "loss", "fair_prob": 0.70, "model_prob": 0.65},
    ]
    baseline = market_baselines(rows)
    assert baseline["comparable_moneyline_rows"] == 2
    assert baseline["market_favorite_accuracy"] == 0.5
    assert baseline["brier_improvement_vs_market"] is not None
    assert baseline["log_loss_improvement_vs_market"] is not None


def test_settled_rows_exclude_push_from_financial_metrics():
    rows = [
        {"result": "push", "profit_loss": 0.0, "units_staked": 1.0, "model_prob": 0.5},
        {"result": "win", "profit_loss": 1.0, "units_staked": 1.0, "model_prob": 0.6},
    ]
    metrics = calculate_metrics(rows)
    assert metrics["bets"] == 1
    assert metrics["roi"] == 1.0
