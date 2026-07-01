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
        CREATE TABLE yrfi_results (
            game_pk TEXT PRIMARY KEY,
            date_ymd TEXT,
            pick TEXT,
            probability REAL,
            correct INTEGER,
            processed_at TEXT
        );
        """
    )
    return conn


def test_build_prediction_log_rows_from_sqlite_maps_ledger_and_yrfi(tmp_path):
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
    conn.execute(
        "INSERT INTO yrfi_results VALUES (?, ?, ?, ?, ?, ?)",
        ("1001", "2026-06-01", "YES", 61.5, 1, "processed"),
    )
    conn.execute(
        "INSERT INTO yrfi_results VALUES (?, ?, ?, ?, ?, ?)",
        ("1002", "2026-06-01", "NO", 44, 0, "processed"),
    )
    conn.commit()
    conn.close()

    rows = build_prediction_log_rows_from_sqlite(db_path)

    assert len(rows) == 4
    ledger_rows = [row for row in rows if row["market_type"] == "moneyline"]
    assert len(ledger_rows) == 2
    assert ledger_rows[0]["final_lean"] == "Home A"
    assert ledger_rows[0]["home_win_probability"] == 0.6
    assert ledger_rows[0]["model_edge"] == 0.06
    assert ledger_rows[0]["market_total"] == 8.5
    assert ledger_rows[1]["final_lean"] == "Away C"

    yrfi_rows = [row for row in rows if row["market_type"] == "yrfi"]
    assert [row["final_lean"] for row in yrfi_rows] == ["YES", "NO"]
    assert yrfi_rows[0]["result"] == "win"
    assert yrfi_rows[0]["profit_loss"] == 1.0
    assert yrfi_rows[0]["home_win_probability"] == 0.615
    assert yrfi_rows[1]["result"] == "loss"
    assert yrfi_rows[1]["profit_loss"] == -1.0

    assert len(settled_rows(rows)) == 4
    metrics = calculate_metrics(rows)
    assert metrics["bets"] == 4


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


def test_filter_rows_by_market_uses_market_type_and_yes_no():
    rows = [
        {"market_type": "moneyline", "final_lean": "Home"},
        {"market_type": "yrfi", "final_lean": "YES"},
        {"market_type": "", "final_lean": "NO"},
    ]

    assert [row["final_lean"] for row in filter_rows_by_market(rows, "moneyline")] == ["Home"]
    assert [row["final_lean"] for row in filter_rows_by_market(rows, "yrfi")] == ["YES", "NO"]
