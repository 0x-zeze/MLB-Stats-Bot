"""Weather context and run-environment adjustments."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .data_loader import read_csv
from .utils import clamp, clean_name, data_path, safe_float


@dataclass(frozen=True)
class WeatherContext:
    """Weather features available before first pitch."""

    home_team: str
    away_team: str
    temperature: float = 70.0
    wind_speed: float = 0.0
    wind_direction: str = "calm"
    humidity: float = 50.0
    air_pressure: float = 29.92
    roof: str = "open"


def weather_adjustment(weather: WeatherContext | None) -> float:
    """Return total-runs adjustment from weather."""
    if weather is None:
        return 0.0

    roof = weather.roof.strip().lower()
    roof_multiplier = 0.15 if roof in {"closed", "dome"} else 1.0

    temperature_adj = clamp((weather.temperature - 70.0) * 0.018, -0.45, 0.45)
    direction = weather.wind_direction.strip().lower()
    if "out" in direction:
      wind_adj = clamp(weather.wind_speed * 0.035, 0.0, 0.55)
    elif "in" in direction:
      wind_adj = -clamp(weather.wind_speed * 0.035, 0.0, 0.55)
    else:
      wind_adj = 0.0

    humidity_adj = clamp((weather.humidity - 50.0) * 0.004, -0.15, 0.20)
    pressure_adj = clamp((29.92 - weather.air_pressure) * 0.25, -0.18, 0.18)
    return (temperature_adj + wind_adj + humidity_adj + pressure_adj) * roof_multiplier


def _key(home_team: str, away_team: str) -> str:
    return f"{clean_name(home_team)}|{clean_name(away_team)}"


def load_weather_contexts(path: str | Path | None = None) -> dict[str, WeatherContext]:
    """Load weather contexts keyed by home|away team."""
    source = Path(path) if path else data_path("sample_weather.csv")
    contexts: dict[str, WeatherContext] = {}
    for row in read_csv(source):
        context = WeatherContext(
            home_team=row["home_team"],
            away_team=row["away_team"],
            temperature=safe_float(row.get("temperature"), 70.0),
            wind_speed=safe_float(row.get("wind_speed"), 0.0),
            wind_direction=row.get("wind_direction", "calm"),
            humidity=safe_float(row.get("humidity"), 50.0),
            air_pressure=safe_float(row.get("air_pressure"), 29.92),
            roof=row.get("roof", "open"),
        )
        contexts[_key(context.home_team, context.away_team)] = context
    return contexts


def get_weather_context(
    contexts: dict[str, WeatherContext], home_team: str, away_team: str
) -> WeatherContext | None:
    """Find weather context for a matchup."""
    return contexts.get(_key(home_team, away_team))
