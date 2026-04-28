import unittest

from src.bullpen import BullpenUsage, bullpen_fatigue_adjustment
from src.park_factors import ParkFactors, park_factor_adjustment
from src.totals import (
    calculate_total_edge,
    poisson_total_probability,
    project_total_runs,
)
from src.weather import WeatherContext, weather_adjustment


class TotalRunsTests(unittest.TestCase):
    def test_project_total_runs(self) -> None:
        self.assertAlmostEqual(project_total_runs(4.8, 4.1), 8.9)

    def test_poisson_over_under_probability(self) -> None:
        over = poisson_total_probability(8.5, 8.5, "over")
        under = poisson_total_probability(8.5, 8.5, "under")
        self.assertGreater(over, 0.0)
        self.assertLess(over, 1.0)
        self.assertAlmostEqual(over + under, 1.0)

    def test_total_edge(self) -> None:
        self.assertAlmostEqual(calculate_total_edge(0.58, 0.52), 0.06)

    def test_weather_adjustment(self) -> None:
        hot_out = WeatherContext(
            home_team="A",
            away_team="B",
            temperature=86,
            wind_speed=12,
            wind_direction="out to center",
            humidity=60,
            air_pressure=29.80,
            roof="open",
        )
        cold_in = WeatherContext(
            home_team="A",
            away_team="B",
            temperature=45,
            wind_speed=12,
            wind_direction="in from center",
            humidity=45,
            air_pressure=30.10,
            roof="open",
        )
        self.assertGreater(weather_adjustment(hot_out), 0.0)
        self.assertLess(weather_adjustment(cold_in), 0.0)

    def test_park_factor_adjustment(self) -> None:
        hitter_park = ParkFactors(team="A", park="A Park", run_factor=110, home_run_factor=115)
        pitcher_park = ParkFactors(team="B", park="B Park", run_factor=92, home_run_factor=90)
        self.assertGreater(park_factor_adjustment(hitter_park), 0.0)
        self.assertLess(park_factor_adjustment(pitcher_park), 0.0)

    def test_bullpen_fatigue_adjustment(self) -> None:
        tired = BullpenUsage(
            team="A",
            bullpen_innings_last_3_days=13.0,
            relievers_used_yesterday=6,
            closer_available=False,
            high_leverage_available=False,
            back_to_back_usage=3,
            bullpen_era_last_7=5.20,
        )
        rested = BullpenUsage(team="B", bullpen_innings_last_3_days=5.0, relievers_used_yesterday=2)
        self.assertGreater(bullpen_fatigue_adjustment(tired), bullpen_fatigue_adjustment(rested))


if __name__ == "__main__":
    unittest.main()
