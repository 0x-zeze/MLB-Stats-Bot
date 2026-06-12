import test from 'node:test';
import assert from 'node:assert/strict';

import { formatEvolveResult, predictionsHaveRawProbabilities } from '../src/index.js';

test('/evolve formatter shows stored totals when no new rows are ingested', () => {
  const text = formatEvolveResult({
    postgame: { dates_checked: 1, learned_games: 0 },
    cycle: {
      ingest: { evaluated: 0, skipped_duplicates: 12 },
      backfill: { updated: 0, totals_fixed: 0, yrfi_fixed: 0 },
      symbolic_candidates: 0,
      rule_candidates: 0,
      total_symbolic_candidates: 913,
      total_rule_candidates: 925,
      evolution_data_dir: '/tmp/evolution-data',
      summary: {
        total_predictions_evaluated: 913,
        lessons_generated: 913,
        language_losses_generated: 913,
        language_gradients_generated: 913,
        candidates_proposed: 925
      },
      calibration: { calibrated_markets: ['moneyline'] }
    },
    audit: {
      summary: { evaluated: 913, accuracy: 55.4, lessons: 913, language_losses: 913, language_gradients: 913, candidates: 925 },
      applied_updates: { rules_added: [], rules_released: [], weight_versions_added: [], active_control_count: 6, note: 'No eligible safe update.' }
    }
  });

  assert.match(text, /Evaluasi baru\/run ini \| 0/);
  assert.match(text, /Tidak ada evaluasi baru; 913 evaluasi historis tetap terbaca/);
  assert.match(text, /Evaluated \| 913/);
  assert.match(text, /Lessons \| 913/);
  assert.match(text, /Candidates unik \| 925/);
  assert.doesNotMatch(text, /Candidates unik \| 1838/);
});

test('/evolve formatter surfaces Python errors instead of normal all-zero success', () => {
  const text = formatEvolveResult({
    postgame: {},
    cycle: { error: 'evolution timeout' },
    audit: { raw: 'warning before json' }
  });

  assert.match(text, /Diagnostics/);
  assert.match(text, /Cycle \| evolution timeout/);
  assert.match(text, /Audit \| output Python tidak bisa diparse JSON/);
});

test('predictionsHaveRawProbabilities treats an empty array as missing (triggers regen)', () => {
  // Vacuous .every made [] return true, so a cached empty slate skipped
  // regeneration in /picks. An empty array must be treated as "no data".
  assert.equal(predictionsHaveRawProbabilities([]), false);
  assert.equal(predictionsHaveRawProbabilities(null), false);
  assert.equal(
    predictionsHaveRawProbabilities([{ away: { winProbabilityRaw: 60 }, home: { winProbabilityRaw: 40 } }]),
    true
  );
  assert.equal(
    predictionsHaveRawProbabilities([{ away: { winProbability: 60 }, home: { winProbability: 40 } }]),
    false
  );
});
