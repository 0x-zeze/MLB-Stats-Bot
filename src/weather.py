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
    """Return total-runs adjustment from weather.

    Granular wind model: decomposes wind direction into component vectors
    (out/in + cross). Wind blowing out at high velocity is the strongest
    run-boosting signal; cross-wind has a smaller effect.
    """
    if weather is None:
        return 0.0

    roof = weather.roof.strip().lower()
    roof_multiplier = 0.15 if roof in {"closed", "dome"} else 1.0

    temperature_adj = clamp((weather.temperature - 70.0) * 0.018, -0.45, 0.45)

    # Granular wind decomposition
    direction = weather.wind_direction.strip().lower()
    speed = weather.wind_speed

    wind_adj = 0.0
    if "out" in direction:
        # Wind blowing out: boosts fly balls, HR carry
        wind_adj = clamp(speed * 0.035, 0.0, 0.55)
        # Extra boost at high velocity (>15 mph)
        if speed > 15:
            wind_adj += clamp((speed - 15) * 0.015, 0.0, 0.15)
    elif "in" in direction:
        wind_adj = -clamp(speed * 0.035, 0.0, 0.55)
        if speed > 15:
            wind_adj -= clamp((speed - 15) * 0.012, 0.0, 0.12)
    elif "cross" in direction or "cf" in direction or "rf" in direction or "lf" in direction:
        # Cross-wind: smaller effect, disrupts fielding slightly
        wind_adj = clamp(speed * 0.008, 0.0, 0.15)
    elif direction and direction != "calm" and speed > 10:
        # Unknown direction with significant speed: small positive assumption
        wind_adj = clamp(speed * 0.005, 0.0, 0.10)

    # Humidity: high humidity increases air density reduction → more carry
    # Scales nonlinearly above 70%
    humidity_adj = clamp((weather.humidity - 50.0) * 0.004, -0.15, 0.20)
    if weather.humidity > 70:
        humidity_adj += clamp((weather.humidity - 70) * 0.003, 0.0, 0.08)

    # Pressure: low pressure = less air resistance = more carry
    pressure_adj = clamp((29.92 - weather.air_pressure) * 0.25, -0.18, 0.18)

    # Temperature × wind interaction: hot + wind out = compound effect
    interaction_adj = 0.0
    if weather.temperature > 85 and "out" in direction and speed > 10:
        interaction_adj = clamp((weather.temperature - 85) * speed * 0.0008, 0.0, 0.12)

    return (temperature_adj + wind_adj + humidity_adj + pressure_adj + interaction_adj) * roof_multiplier


def yrfi_weather_adjustment(weather: WeatherContext | None) -> float:
    """Return YRFI probability adjustment from weather conditions.

    First-inning specific: temperature and wind out boost YRFI,
    cold/wind in suppress it. Dome/closed roof neutralizes.
    Smaller magnitude than total-runs adjustment (~half scale).
    """
    if weather is None:
        return 0.0

    try:
        roof = weather.roof.strip().lower()
        if roof in {"closed", "dome"}:
            return 0.0  # Weather irrelevant under roof

        adj = 0.0

        # Temperature: hot = more YRFI, cold = less
        # Scale: ±0.03 max for first inning
        adj += clamp((weather.temperature - 70.0) * 0.006, -0.03, 0.03)

        # Wind out boosts YRFI, wind in suppresses
        direction = weather.wind_direction.strip().lower()
        if "out" in direction:
            adj += clamp(weather.wind_speed * 0.004, 0.0, 0.03)
        elif "in" in direction:
            adj -= clamp(weather.wind_speed * 0.004, 0.0, 0.03)

        # High humidity slightly increases fly ball carry
        adj += clamp((weather.humidity - 50.0) * 0.001, -0.01, 0.01)

        return clamp(adj, -0.05, 0.05)
    except Exception:
        return 0.0


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
