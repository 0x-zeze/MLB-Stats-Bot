"""FastAPI backend for the React MLB prediction control center."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .dashboard_service import (
    get_mock_backtest,
    get_model_performance,
    get_prediction_history,
    get_today_dashboard,
    load_dashboard_settings,
    rows_to_csv,
    run_dashboard_backtest,
    save_dashboard_settings,
)


class BacktestRequest(BaseModel):
    """Backtest request from the dashboard UI."""

    season: int | None = None
    start_date: str | None = None
    end_date: str | None = None
    market_type: str = "moneyline"


def request_payload(request: BacktestRequest) -> dict[str, Any]:
    """Support Pydantic v1 and v2 request serialization."""
    if hasattr(request, "model_dump"):
        return request.model_dump()
    return request.dict()


app = FastAPI(
    title="MLB Stats Bot Dashboard API",
    version="0.2.0",
    description="Prediction control-center API for MLB moneyline, totals, quality, and performance.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    """Health check used by local dev and VPS monitoring."""
    return {"status": "ok"}


@app.get("/api/settings")
def api_settings() -> dict[str, Any]:
    """Return dashboard thresholds and toggles."""
    return load_dashboard_settings()


@app.put("/api/settings")
def api_update_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """Update dashboard thresholds and toggles."""
    return save_dashboard_settings(settings)


@app.get("/api/today")
def api_today(date: str | None = None, source: str = "live") -> dict[str, Any]:
    """Return today's games, predictions, market comparison, and quality reports."""
    return get_today_dashboard(date_ymd=date, source=source)


@app.get("/api/history")
def api_history() -> dict[str, Any]:
    """Return historical prediction rows."""
    return {"rows": get_prediction_history()}


@app.get("/api/performance")
def api_performance() -> dict[str, Any]:
    """Return model performance and calibration summaries."""
    return get_model_performance()


@app.post("/api/backtest")
def api_backtest(request: BacktestRequest) -> dict[str, Any]:
    """Run a local CSV backtest for the selected market and date range."""
    return run_dashboard_backtest(request_payload(request))


@app.get("/api/backtest/mock")
def api_backtest_mock() -> dict[str, Any]:
    """Return mock backtest results for frontend development."""
    return get_mock_backtest()


def _csv_response(filename: str, text: str) -> Response:
    return Response(
        text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/export/today")
def export_today(date: str | None = None, source: str = "live") -> Response:
    """Export today's prediction cards as CSV."""
    payload = get_today_dashboard(date_ymd=date, source=source)
    return _csv_response("today_predictions.csv", rows_to_csv(payload.get("games", [])))


@app.get("/api/export/history")
def export_history() -> Response:
    """Export prediction history as CSV."""
    return _csv_response("prediction_history.csv", rows_to_csv(get_prediction_history()))


@app.get("/api/export/performance")
def export_performance() -> Response:
    """Export model performance sections as CSV-friendly rows."""
    performance = get_model_performance()
    rows = [performance.get("overall", {})]
    rows.extend(performance.get("by_market", []))
    rows.extend(performance.get("by_total_range", []))
    rows.extend(performance.get("calibration", []))
    return _csv_response("model_performance.csv", rows_to_csv(rows))


@app.post("/api/export/backtest")
def export_backtest(request: BacktestRequest) -> Response:
    """Run and export a backtest result table."""
    payload = run_dashboard_backtest(request_payload(request))
    return _csv_response("backtest_results.csv", rows_to_csv(payload.get("rows", [])))


@app.get("/api/export/backtest")
def export_backtest_default() -> Response:
    """Export a default moneyline backtest for simple browser downloads."""
    payload = run_dashboard_backtest({"market_type": "moneyline"})
    return _csv_response("backtest_results.csv", rows_to_csv(payload.get("rows", [])))
