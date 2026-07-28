import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { Storage } from '../src/storage.js';

function freshStorage() {
  const tempDir = resolve(process.cwd(), '.tmp-live-snapshot-tests');
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(
    tempDir,
    `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  return { storage: new Storage(statePath), tempDir };
}

function prediction() {
  const away = { id: 101, name: 'Away', abbreviation: 'AWY', winProbability: 47 };
  const home = { id: 202, name: 'Home', abbreviation: 'HOM', winProbability: 53 };
  return {
    gamePk: 7001,
    dateYmd: '2026-07-27',
    startTime: '2026-07-27T23:00:00Z',
    status: 'Scheduled',
    away,
    home,
    winner: home,
    reasons: ['test'],
    modelBreakdown: { pureAwayProbability: 47, pureHomeProbability: 53 },
    currentOdds: {
      awayMoneyline: 110,
      homeMoneyline: -130,
      awayMoneylineBook: 'Pinnacle',
      homeMoneylineBook: 'Pinnacle',
      moneylineBook: 'Pinnacle'
    },
    valuePick: {
      side: 'home',
      teamId: 202,
      teamName: 'Home',
      odds: -130,
      modelProbability: 53,
      fairProbability: 54,
      edge: -1,
      kellyStakePercent: 0,
      book: 'Pinnacle',
      quoteId: 'quote-7001-home'
    },
    betDecision: { status: 'NO BET', reasons: [], edge: -1 }
  };
}

test('savePredictions captures immutable snapshot hash and prediction run', () => {
  const { storage, tempDir } = freshStorage();
  try {
    const pred = prediction();
    pred.coreInputs = {
      game: {
        gamePk: 7001,
        gameDate: '2026-07-27T23:00:00Z',
        officialDate: '2026-07-27',
        teams: {
          away: { team: { id: 101 } },
          home: { team: { id: 202 } }
        }
      },
      teamStats: {},
      standings: {},
      pitcherStats: {},
      pitcherDetails: {},
      pitcherRecentStarts: {},
      bullpenProfiles: {},
      scheduleFatigueProfiles: {},
      headToHead: { games: 0 },
      injuryProfiles: {},
      lineupProfiles: { away: null, home: null },
      modelMemory: {},
      rollingTeamStats: {},
      evolutionControls: {},
      parkFactorBaselines: []
    };
    storage.savePredictions('2026-07-27', [pred]);

    const saved = storage.getPrediction(7001);
    assert.ok(saved.snapshotHash);
    assert.match(saved.calibrationVersion, /^cal-moneyline-/);
    assert.equal(saved.asOfUtc, saved.predictionTimestampUtc);

    const run = storage.db
      .prepare('SELECT * FROM prediction_runs WHERE game_pk = ?')
      .get('7001');
    assert.ok(run);
    assert.equal(run.snapshot_hash, saved.snapshotHash);
    assert.equal(run.calibration_version, saved.calibrationVersion);

    const feature = storage.db
      .prepare(
        `SELECT * FROM feature_snapshots
         WHERE game_pk = ? AND feature_group = 'prediction_decision_snapshot'`
      )
      .get('7001');
    assert.ok(feature);
    const payload = JSON.parse(feature.payload);
    assert.equal(payload.snapshotHash, saved.snapshotHash);
    assert.equal(payload.coreInputs.game.gamePk, 7001);
    assert.equal(payload.calibrationArtifact.market, 'moneyline');
    assert.ok(Array.isArray(payload.calibrationArtifact.mapping));

    const files = storage.db
      .prepare(
        `SELECT COUNT(*) AS c FROM feature_snapshots
         WHERE game_pk = ? AND feature_group = 'prediction_decision_snapshot'`
      )
      .get('7001');
    assert.equal(files.c, 1);
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('snapshot capture is write-once across prediction refreshes', () => {
  const { storage, tempDir } = freshStorage();
  try {
    const first = prediction();
    storage.savePredictions('2026-07-27', [first]);
    const firstFeature = storage.db
      .prepare(
        `SELECT payload, timestamp FROM feature_snapshots
         WHERE game_pk = ? AND feature_group = 'prediction_decision_snapshot'`
      )
      .get('7001');

    const refreshed = prediction();
    refreshed.away.winProbability = 40;
    refreshed.home.winProbability = 60;
    refreshed.modelBreakdown = { pureAwayProbability: 40, pureHomeProbability: 60 };
    storage.savePredictions('2026-07-27', [refreshed]);
    const secondFeature = storage.db
      .prepare(
        `SELECT payload, timestamp FROM feature_snapshots
         WHERE game_pk = ? AND feature_group = 'prediction_decision_snapshot'`
      )
      .get('7001');

    assert.equal(secondFeature.payload, firstFeature.payload);
    assert.equal(secondFeature.timestamp, firstFeature.timestamp);
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
