import unittest

from src.evolution.lesson_generator import generate_lesson, generate_self_questions


class LessonGeneratorTests(unittest.TestCase):
    def test_wrong_prediction_generates_lesson(self):
        evaluation = {"game_id": "game-1", "date": "2026-04-30", "market": "totals", "prediction": "Over 8.5", "result": "loss", "confidence": "medium"}
        loss = {"loss_type": "overconfidence", "loss_summary": "Too confident.", "numeric_context": {"projected_total": 9, "market_total": 8.5, "actual_total": 6, "data_quality": 72}}
        gradient = {"gradient": "Cap confidence when edge is weak."}

        lesson = generate_lesson(evaluation, loss, gradient)

        self.assertEqual(lesson["result"], "loss")
        self.assertEqual(lesson["category"], "confidence")
        self.assertFalse(lesson["production_update_allowed"])
        self.assertTrue(generate_self_questions(evaluation))


if __name__ == "__main__":
    unittest.main()
