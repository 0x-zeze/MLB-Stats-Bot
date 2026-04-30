import unittest

from evolution_helpers import sample_trajectory
from src.evolution.tool_usage_analyzer import analyze_tool_usage


class ToolUsageAnalyzerTests(unittest.TestCase):
    def test_missing_weather_creates_tool_usage_warning(self):
        report = analyze_tool_usage(sample_trajectory())

        self.assertIn("get_weather_context", report["missing_tools"])
        self.assertLess(report["tool_usage_quality"], 100)
        self.assertIn("Weather", report["recommendation"])


if __name__ == "__main__":
    unittest.main()
