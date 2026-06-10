import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readPredictionOutcomes } from '../src/evolutionContext.js';

test('evolution context reads CSV outcomes by header with quoted JSON', () => {
  const previousDir = process.env.MLB_EVOLUTION_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'evolution-context-'));
  process.env.MLB_EVOLUTION_DATA_DIR = dir;

  try {
    writeFileSync(
      join(dir, 'prediction_outcomes.csv'),
      'game_id,date,market,prediction,confidence,result,actual_score,actual_total,profit_loss,clv,brier_score,baseline_brier_score,brier_delta_llm,calibration_bucket,evaluation_json\n' +
        '1,2026-05-01,moneyline,"Alpha, Team",medium,win,4-2,6,1.0,,0.16,0.25,-0.09,confidence:medium,"{""edge"": 3.2, ""main_factors"": [""market, edge""]}"\n',
      'utf8'
    );

    const rows = readPredictionOutcomes();

    assert.equal(rows.length, 1);
    assert.equal(rows[0].prediction, 'Alpha, Team');
    assert.equal(rows[0].evaluation.edge, 3.2);
    assert.deepEqual(rows[0].evaluation.main_factors, ['market, edge']);
  } finally {
    if (previousDir === undefined) delete process.env.MLB_EVOLUTION_DATA_DIR;
    else process.env.MLB_EVOLUTION_DATA_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
