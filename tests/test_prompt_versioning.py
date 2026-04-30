import unittest

from evolution_helpers import isolated_evolution_store
from src.evolution.prompt_versioning import create_prompt_candidate, get_prompt_versions, rollback_prompt_version


class PromptVersioningTests(unittest.TestCase):
    def test_prompt_versioning_never_overwrites_active_prompt_and_preserves_rollback(self):
        with isolated_evolution_store():
            before = get_prompt_versions()["active_version"]
            candidate = create_prompt_candidate(
                reason="Improve uncertainty wording.",
                changes=["Mention whether lean is model-driven or data-quality-limited."],
                source_losses=["loss-1"],
                source_gradients=["grad-1"],
            )
            after = get_prompt_versions()
            rollback = rollback_prompt_version(before)

        self.assertEqual(before, after["active_version"])
        self.assertEqual(candidate["status"], "candidate")
        self.assertTrue(candidate["rollback_supported"])
        self.assertEqual(rollback["active_version"], before)


if __name__ == "__main__":
    unittest.main()
