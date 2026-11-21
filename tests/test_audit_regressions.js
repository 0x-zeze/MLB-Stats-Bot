import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { predictGameMoneylineCore } from '../src/core/prediction_core.js';
import { calibratePercent } from '../src/calibration.js';
import { loadEvolutionControls, moneylineWeightMultiplier } from '../src/evolutionControls.js';
import { applyMoneylineValueMarket } from '../src/mlb.js';
import { Storage } from '../src/storage.js';
import { formatAuditCard } from '../src/auditCard.js';
import {
  validateTemporalSnapshot,
  TemporalLeakageError,
  TEMPORAL_CODES
} from '../src/data/temporal_validator.js';

function makeCoreBundle(overrides = {}) {
  const game = {
    gamePk: 777001,
    officialDate: '2026-07-21',
    gameDate: '2026-07-21T23:05:00Z',
    venue: { id: 119, name: 'Dodger Stadium' },
    weather: { temp: '72', wind: '5 mph' },
    status: { detailedState: 'Scheduled' },
    teams: {
      away: {
        team: { id: 147, name: 'Yankees', abbreviation: 'NYY' },
        leagueRecord: { wins: 50, losses: 50 },
        probablePitcher: { id: 111, fullName: 'Away Starter', pitchHand: { code: 'R' } }
      },
      home: {
        team: { id: 119, name: 'Dodgers', abbreviation: 'LAD' },
        leagueRecord: { wins: 50, losses: 50 },
        probablePitcher: { id: 222, fullName: 'Home Starter', pitchHand: { code: 'R' } }
      }
    }
  };
  return {
    game,
    teamStats: new Map([
      [147, { hitting: { gamesPlayed: 100, runs: 450, ops: '.730' }, pitching: { gamesPlayed: 100, runs: 450, era: '4.10' } }],
      [119, { hitting: { gamesPlayed: 100, runs: 450, ops: '.730' }, pitching: { gamesPlayed: 100, runs: 450, era: '4.10' } }]
    ]),
    standings: new Map([
      [147, { leagueRecord: { wins: 50, losses: 50 } }],
      [119, { leagueRecord: { wins: 50, losses: 50 } }]
    ]),
    pitcherStats: new Map([
      [111, { era: '4.00', whip: '1.25' }],
      [222, { era: '4.00', whip: '1.25' }]
    ]),
    pitcherDetails: new Map(),
    pitcherRecentStarts: new Map(),
    bullpenProfiles: new Map(),
    scheduleFatigueProfiles: new Map(),
    headToHead: { games: 0 },
    injuryProfiles: new Map(),
    lineupProfiles: { away: null, home: null },
    modelMemory: {},
    rollingTeamStats: new Map(),
    evolutionControls: loadEvolutionControls(),
    parkFactorBaselines: new Map([[119, { runFactor: 1.0, homeRunFactor: 1.0 }]]),
    calibratePercent,
    nowMs: new Date('2026-07-21T12:00:00Z'),
    moneylineWeightMultiplierFn: moneylineWeightMultiplier,
    ...overrides
  };
}

test('prediction_core does not coerce null reliefEra/lineup metrics to 0 and keeps HR/9 sign & opener filtering accurate', () => {
  const baseline = predictGameMoneylineCore(makeCoreBundle());
  const withNulls = predictGameMoneylineCore(
    makeCoreBundle({
      bullpenProfiles: new Map([
        [147, { reliefEra: null, highLeverageArmsUnavailable: 0, pitchesLast3Days: 60 }],
        [119, { reliefEra: 4.1, highLeverageArmsUnavailable: 0, pitchesLast3Days: 60 }]
      ]),
      lineupProfiles: {
        away: { confirmed: true, confirmedBatters: 9, leadoffObp: null, platoonOps: null, topOrderOps: null },
        home: { confirmed: true, confirmedBatters: 9, leadoffObp: 0.33, platoonOps: 0.73, topOrderOps: 0.75 }
      }
    })
  );
  // Before fix, Number(null) === 0 gave away a fake 0.00 bullpen ERA and huge phantom bullpen edge.
  assert.ok(Math.abs(withNulls.modelBreakdown.bullpenEdge - baseline.modelBreakdown.bullpenEdge) < 0.05);
  assert.ok(Math.abs(withNulls.modelBreakdown.lineupEdge - baseline.modelBreakdown.lineupEdge) < 0.2);

  // Rolling HR/9: lower HR/9 allowed by home pitching must HELP home (higher preventionEdge), not hurt.
  const lowHomeHr = predictGameMoneylineCore(
    makeCoreBundle({
      rollingTeamStats: new Map([
        [147, { games: 14, pitching: { era: '4.10', whip: '1.25', homeRunsPer9: 1.8, strikeoutWalkRatio: 2.2 } }],
        [119, { games: 14, pitching: { era: '4.10', whip: '1.25', homeRunsPer9: 0.5, strikeoutWalkRatio: 2.2 } }]
      ])
    })
  );
  assert.ok(lowHomeHr.modelBreakdown.preventionEdge > 0);

  // "Home Opener" news headline must NOT trigger opener detection.
  const homeOpenerNews = predictGameMoneylineCore(
    makeCoreBundle({
      injuryProfiles: new Map([
        [119, { headlines: ['Dodgers sell out Home Opener against Yankees'] }]
      ])
    })
  );
  assert.equal(homeOpenerNews.homeOpenerSituation?.isOpener ?? false, false);
});

test('applyMoneylineValueMarket disagreementAwayBypass triggers for model-away vs market-home favorite', () => {
  const game = {
    status: 'Scheduled',
    away: { id: 1, name: 'Away Team', abbreviation: 'AWY', winProbability: 58, starter: { fullName: 'A' }, record: { wins: 50, losses: 40, pct: '.556' } },
    home: { id: 2, name: 'Home Team', abbreviation: 'HOM', winProbability: 42, starter: { fullName: 'H' }, record: { wins: 48, losses: 42, pct: '.533' } },
    currentOdds: {
      awayMoneyline: 125,
      homeMoneyline: -145,
      moneylineBook: 'FanDuel'
    },
    pick: { side: 'away', name: 'Away Team', winProbability: 58, confidence: 'High', rawEdge: 0.2 },
    modelBreakdown: { rawEdge: 0.2, dampenedEdge: 0.12 },
    lineups: {
      away: { confirmed: true, confirmedBatters: 9 },
      home: { confirmed: true, confirmedBatters: 9 }
    },
    dataQuality: { score: 90, missingFields: [] }
  };

  applyMoneylineValueMarket(game);
  assert.equal(game.valuePick?.side, 'away');
  // Away is +125 (> +115 normal cap), but model picks away (58%) while market favors home,
  // so disagreementAwayBypass raises the away cap to +130 instead of blocking at +115.
  const reasons = game.betDecision?.reasons || [];
  assert.equal(reasons.some((r) => r.includes('exceeds +115 limit')), false);
});

test('Storage savePredictions persists candidate features, processPostGameOutcome records non-bet memory, and invalid odds are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlb-audit-reg-'));
  try {
    const storage = new Storage(join(dir, 'state.json'));
    try {
      const pred = {
        gamePk: 555001,
        dateYmd: '2026-07-21',
        gameDate: '2026-07-21T23:05:00Z',
        asOfUtc: '2026-07-21T15:00:00Z',
        matchup: 'Yankees @ Dodgers',
        away: { id: 147, name: 'Yankees', abbreviation: 'NYY', winProbability: 45, bullpen: { reliefEra: 3.9 }, lineup: { confirmed: true } },
        home: { id: 119, name: 'Dodgers', abbreviation: 'LAD', winProbability: 55, bullpen: { reliefEra: 3.4 }, lineup: { confirmed: true } },
        pick: { id: 119, side: 'home', name: 'Dodgers', winProbability: 55, confidence: 'Medium', rawEdge: 0.1 },
        modelBreakdown: { rawEdge: 0.1, dampenedEdge: 0.05 },
        candidateFeatures: { bullpen_quality: { status: 'available' }, confirmed_lineup_profile: { status: 'available' } }
      };

      assert.doesNotThrow(() => storage.savePredictions('2026-07-21', [pred]));
      const featureRows = storage.db
        .prepare('SELECT feature_group FROM feature_snapshots WHERE game_pk = ?')
        .all('555001');
      assert.ok(featureRows.length >= 1, 'candidate feature snapshots must be saved');

      // Invalid American odds in (-100, 100) must be rejected (return null).
      const badBet = storage.recordBet(
        {
          ...pred,
          betDecision: { status: 'VALUE', reasons: [] },
          valuePick: {
            side: 'home',
            teamName: 'Dodgers',
            odds: 50,
            fairProbability: 50,
            modelProbability: 55,
            edge: 5,
            kellyStakePercent: 1.5
          }
        },
        '2026-07-21'
      );
      assert.equal(badBet, null);

      // Non-bet finished game should still update matchup memory.
      const res = storage.processPostGameOutcome(pred, {
        gamePk: 555001,
        away: { id: 147, name: 'Yankees', abbreviation: 'NYY', score: 2 },
        home: { id: 119, name: 'Dodgers', abbreviation: 'LAD', score: 5 },
        winner: { id: 119, name: 'Dodgers', side: 'home' },
        loser: { id: 147, name: 'Yankees', side: 'away' }
      });
      assert.equal(res.processed, true);
      assert.equal(res.memoryRecorded, true);
      assert.ok(storage.readMemory().totalPicks >= 1, 'non-bet game should record matchup memory');
    } finally {
      storage.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatAuditCard never renders null% or fabricated 0.0% when numeric fields are null', () => {
  const card = {
    mp: {
      game_pk: '900001',
      date_ymd: '2026-08-20',
      model_id: 'heuristic_v1',
      model_version: 'moneyline-core-v1.0',
      as_of_utc: '2026-08-20T12:00:00Z',
      first_pitch_utc: '2026-08-20T23:00:00Z',
      raw_away_probability: null,
      raw_home_probability: null,
      calibrated_away_probability: null,
      calibrated_home_probability: null,
      pick_side: 'home',
      pick_probability: null,
      status: 'NO BET',
      reason_codes: '["insufficient edge"]'
    },
    matchup: 'NYY @ LAD',
    home: { name: 'Dodgers', abbreviation: 'LAD' },
    away: { name: 'Yankees', abbreviation: 'NYY' },
    breakdown: null,
    betDecision: { status: 'NO BET', edge: null, odds: null, kellyStakePercent: null, reasons: ['insufficient edge'] },
    quality: null,
    fallbacks: null,
    market: { atPrediction: null, closing: null, source: null },
    outcome: null,
    ledger: null,
    snapshotPath: null
  };
  const rendered = formatAuditCard(card);
  assert.equal(rendered.includes('null%'), false);
  assert.equal(rendered.includes('NaN'), false);
  assert.equal(rendered.includes('0.0%'), false);
  assert.ok(rendered.includes('tidak terekam'));
});

test('validateTemporalSnapshot rejects AS_OF_AFTER_FIRST_PITCH in both non-strict and strict modes', () => {
  const snapshot = {
    asOfUtc: '2026-07-21T23:30:00Z',
    firstPitchUtc: '2026-07-21T23:05:00Z',
    features: {
      pitcher_era: { value: 3.5, availableAt: '2026-07-21T12:00:00Z' }
    }
  };
  const nonStrict = validateTemporalSnapshot(snapshot, null, { strict: false });
  assert.equal(nonStrict.ok, false);
  assert.equal(nonStrict.liveSafe, false);
  assert.equal(nonStrict.promotionEligible, false);
  assert.ok(nonStrict.errors.some((e) => e.code === TEMPORAL_CODES.AS_OF_AFTER_FIRST_PITCH));

  assert.throws(
    () => validateTemporalSnapshot(snapshot, null, { strict: true }),
    (err) => err instanceof TemporalLeakageError && err.code === TEMPORAL_CODES.AS_OF_AFTER_FIRST_PITCH
  );
});
