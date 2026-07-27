import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPredictionSnapshot, projectDecisionFromSnapshot } from '../src/prediction_snapshot.js';
import {
  parseSnapshot,
  serializeSnapshot,
  writeSnapshotFile,
  readSnapshotFile
} from '../src/prediction_serializer.js';
import { replaySnapshot, replayTwice } from '../src/prediction_replay.js';

function samplePrediction() {
  return {
    gamePk: 555001,
    dateYmd: '2026-07-27',
    startTime: '2026-07-27T23:10:00Z',
    away: {
      id: 10,
      name: 'Away FC',
      abbreviation: 'AWY',
      winProbability: 44,
      pureModelProbability: 44
    },
    home: {
      id: 20,
      name: 'Home FC',
      abbreviation: 'HOM',
      winProbability: 56,
      pureModelProbability: 56
    },
    winner: { id: 20, name: 'Home FC', abbreviation: 'HOM', winProbability: 56 },
    modelBreakdown: {
      pureAwayProbability: 44,
      pureHomeProbability: 56
    },
    currentOdds: {
      awayMoneyline: 140,
      homeMoneyline: -160,
      awayMoneylineBook: 'Pinnacle',
      homeMoneylineBook: 'Pinnacle',
      moneylineBook: 'Pinnacle'
    },
    valuePick: {
      side: 'home',
      teamId: 20,
      teamName: 'Home FC',
      odds: -160,
      book: 'Pinnacle',
      modelProbability: 56,
      fairProbability: 58.5,
      edge: -2.5,
      kellyStakePercent: 0
    },
    betDecision: { status: 'NO BET', edge: -2.5, reasons: ['edge below threshold'] }
  };
}

test('snapshot hash is stable across serialize round-trip', () => {
  const snapshot = buildPredictionSnapshot({
    prediction: samplePrediction(),
    dateYmd: '2026-07-27',
    asOfUtc: '2026-07-27T18:00:00.000Z',
    versions: { modelVersion: 'test-1', calibrationVersion: 'cal-1' }
  });
  assert.equal(snapshot.schemaVersion, 1);
  assert.ok(snapshot.snapshotHash);
  const text = serializeSnapshot(snapshot);
  const parsed = parseSnapshot(text);
  assert.equal(parsed.snapshotHash, snapshot.snapshotHash);
});

test('replay projects decision fields and is deterministic twice', () => {
  const snapshot = buildPredictionSnapshot({
    prediction: samplePrediction(),
    dateYmd: '2026-07-27',
    asOfUtc: '2026-07-27T18:00:00.000Z'
  });
  const decision = projectDecisionFromSnapshot(snapshot);
  assert.equal(decision.valueSide, 'home');
  assert.equal(String(decision.valueTeamId), '20');
  assert.equal(decision.status, 'NO BET');
  assert.equal(decision.pureHomeProbability, 56);

  const twice = replayTwice(snapshot);
  assert.equal(twice.parity.ok, true);
  assert.equal(twice.a.decision.snapshotHash, twice.b.decision.snapshotHash);
});

test('write/read snapshot file preserves parity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlb-snap-'));
  try {
    const snapshot = buildPredictionSnapshot({
      prediction: samplePrediction(),
      dateYmd: '2026-07-27',
      asOfUtc: '2026-07-27T18:00:00.000Z'
    });
    const path = join(dir, 'snap.json');
    writeSnapshotFile(path, snapshot);
    const loaded = readSnapshotFile(path);
    const result = replaySnapshot(loaded);
    assert.equal(result.parity.ok, true);
    assert.equal(result.decision.gamePk, '555001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
