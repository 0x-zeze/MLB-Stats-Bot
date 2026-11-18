import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shrinkPitcherStats,
  guardFavoredCalibrationPercent
} from '../src/core/prediction_core.js';

import {
  __mlbTestInternals,
  detectSharpMoneySignal
} from '../src/mlb.js';

import {
  evaluateMoneyline,
  JS_HANDLERS
} from '../src/rule_engine.js';

const {
  americanToContinuousCents,
  blendHitterSeasonStats,
  parseRosterAndTransactions,
  blendTeamStatsWithPrior,
  combinePitcherStatSplits
} = __mlbTestInternals;

test('shrinkPitcherStats blends low-sample current season with prior season', () => {
  // Case 1: null stats -> returns null
  assert.equal(shrinkPitcherStats(null), null);

  // Case 2: empty stats with strong prior -> prior dominates
  const priorAce = { inningsPitched: '180.0', era: '2.50', whip: '0.98', strikeOuts: 210, baseOnBalls: 35, homeRuns: 16 };
  const earlySeason = shrinkPitcherStats({ priorSeason: priorAce });
  assert.ok(earlySeason.era < 3.2, `expected era < 3.2, got ${earlySeason.era}`);
  assert.ok(earlySeason.whip < 1.1, `expected whip < 1.1, got ${earlySeason.whip}`);

  // Case 3: Early season (IP = 15) with bad ERA (6.00), but prior ace (2.50)
  // Bayesian shrinkage pulls 6.00 down towards prior ace
  const earlyRough = {
    inningsPitched: '15.0',
    era: '6.00',
    whip: '1.50',
    strikeOuts: 15,
    baseOnBalls: 6,
    homeRuns: 3,
    priorSeason: priorAce
  };
  const shrunk = shrinkPitcherStats(earlyRough);
  assert.ok(shrunk.era < 4.5, `shrunk era ${shrunk.era} should be pulled down from 6.00 by ace prior`);
  assert.ok(shrunk.whip < 1.35, `shrunk whip ${shrunk.whip} should be pulled down from 1.50`);

  // Case 4: Deep sample (IP = 120) -> current season dominates
  const lateSeason = {
    inningsPitched: '120.0',
    era: '2.80',
    whip: '1.05',
    strikeOuts: 130,
    baseOnBalls: 25,
    homeRuns: 12,
    priorSeason: priorAce
  };
  const lateShrunk = shrinkPitcherStats(lateSeason);
  assert.ok(Math.abs(lateShrunk.era - 2.80) < 0.2, 'deep season sample dominates');
});

test('guardFavoredCalibrationPercent prevents non-monotonic map inversion', () => {
  // Raw favored side (62%) is protected from falling below 50%
  const guarded = guardFavoredCalibrationPercent(62.0, 48.0);
  assert.ok(guarded >= 50.1, `expected >= 50.1, got ${guarded}`);

  // Monotonic calibration preserves the calibrated value
  assert.equal(guardFavoredCalibrationPercent(62.0, 58.5), 58.5);
  assert.equal(guardFavoredCalibrationPercent(45.0, 43.0), 43.0);
  // 50-50 neutral stays 50
  assert.equal(guardFavoredCalibrationPercent(50.0, 50.0), 50.0);
});

test('blendHitterSeasonStats blends early-season hitter sample with prior year', () => {
  const priorStar = { atBats: 550, hits: 165, homeRuns: 35, walks: 70, strikeouts: 110, avg: '.300', obp: '.390', slg: '.550', ops: '.940' };
  
  // Early season (20 ABs) slump: .150 OPS .377
  const earlySlump = { atBats: 20, hits: 3, homeRuns: 0, walks: 2, strikeouts: 8, avg: '.150', obp: '.227', slg: '.150', ops: '.377' };
  const blended = blendHitterSeasonStats(earlySlump, priorStar);
  
  // Star prior prevents overreacting to 20 cold ABs
  assert.ok(blended.ops > 0.75, `blended OPS should stay above 0.75 for star hitter, got ${blended.ops}`);
  assert.ok(blended.obp > 0.32, `blended OBP should stay above 0.32, got ${blended.obp}`);

  // Deep season (400 ABs) uses current year
  const deepSeason = { atBats: 400, hits: 110, homeRuns: 20, walks: 40, strikeouts: 80, avg: '.275', obp: '.345', slg: '.475', ops: '.820' };
  const deepBlended = blendHitterSeasonStats(deepSeason, priorStar);
  assert.ok(Math.abs(deepBlended.ops - 0.82) < 0.03, 'deep season sample dominates');
});

test('parseRosterAndTransactions detects trades and new acquisitions', () => {
  const mockRoster = {
    roster: [
      { person: { id: 101, fullName: 'Star Slugger' }, position: { abbreviation: '1B' }, status: { description: 'Active' } },
      { person: { id: 102, fullName: 'Ace Pitcher' }, position: { abbreviation: 'P' }, status: { description: 'Active' } },
      { person: { id: 103, fullName: 'Speedy OF' }, position: { abbreviation: 'CF' }, status: { description: 'Active' } },
      { person: { id: 104, fullName: 'Solid Catcher' }, position: { abbreviation: 'C' }, status: { description: 'Active' } }
    ]
  };

  const mockTransactions = {
    transactions: [
      {
        person: { id: 101, fullName: 'Star Slugger' },
        typeCode: 'TR',
        description: 'Traded by Team B to Team A.',
        date: '2026-02-15'
      },
      {
        person: { id: 105, fullName: 'Reliever X' },
        typeCode: 'OPT',
        description: 'Optioned to AAA.',
        date: '2026-03-25'
      }
    ]
  };

  const result = parseRosterAndTransactions(mockRoster, mockTransactions, 120, '2026-04-01');
  assert.equal(result.rosterContext.activeCount, 4);
  assert.ok(result.rosterContext.recentAcquisitions.length >= 1, 'should identify traded star');
  assert.equal(result.rosterContext.recentAcquisitions[0].id, 101);
  assert.ok(result.rosterContext.turnoverScore > 0, 'turnover should be positive');
});

test('blendTeamStatsWithPrior smooths team run production in April/early May', () => {
  const currentEarly = {
    hitting: { gamesPlayed: 8, runs: 22, ops: '.620' },
    pitching: { gamesPlayed: 8, era: '5.80', whip: '1.55' },
    hittingAdvanced: { iso: 0.11 },
    pitchingAdvanced: {}
  };

  const priorPowerhouse = {
    hitting: { gamesPlayed: 162, runs: 850, ops: '.790' },
    pitching: { gamesPlayed: 162, era: '3.60', whip: '1.18' },
    hittingAdvanced: { iso: 0.19 },
    pitchingAdvanced: {}
  };

  const currentMap = new Map([[120, currentEarly]]);
  const priorMap = new Map([[120, priorPowerhouse]]);
  const blendedMap = blendTeamStatsWithPrior(currentMap, priorMap, new Map(), [120]);
  const blended = blendedMap.get(120);

  assert.ok(blended, 'team 120 should exist in blended map');
  // At 8 games, prior powerhouse provides stabilization
  const blendedOps = Number(blended.hitting.ops);
  assert.ok(blendedOps > 0.70, `blended OPS ${blendedOps} should be higher than early slump .620`);
  const blendedEra = Number(blended.pitching.era);
  assert.ok(blendedEra < 4.80, `blended ERA ${blendedEra} should be lower than early inflated 5.80`);
});

test('americanToContinuousCents produces smooth line across +-100 boundary', () => {
  // -110 is 10 cents favorite; +105 is -5 cents underdog
  // Difference between -110 and +105 is exactly 15 cents, not 215 cents!
  const centsMinus110 = americanToContinuousCents(-110);
  const centsPlus105 = americanToContinuousCents(105);
  const diff = Math.abs(centsMinus110 - centsPlus105);
  assert.equal(diff, 15, `expected 15 cents across boundary, got ${diff}`);

  // Test sharp money signal with cross-zero line move
  const signal = detectSharpMoneySignal(
    'away',
    { away: 105, home: -115 },
    { away: -110, home: 100 }
  );
  assert.equal(signal.magnitude, 15, `expected 15 cent move, got ${signal.magnitude}`);
  assert.equal(signal.direction, 'toward_model');
});

test('combinePitcherStatSplits aggregates multi-team traded pitcher splits', () => {
  const teamSplitA = {
    stat: {
      inningsPitched: '40.0',
      earnedRuns: 16,
      baseOnBalls: 12,
      strikeOuts: 45,
      homeRuns: 5,
      hits: 32,
      era: '3.60',
      whip: '1.10'
    },
    team: { id: 110 }
  };
  const teamSplitB = {
    stat: {
      inningsPitched: '30.0',
      earnedRuns: 9,
      baseOnBalls: 8,
      strikeOuts: 35,
      homeRuns: 3,
      hits: 22,
      era: '2.70',
      whip: '1.00'
    },
    team: { id: 120 }
  };

  const combined = combinePitcherStatSplits([teamSplitA, teamSplitB]);
  assert.equal(combined.inningsPitched, '70.0');
  assert.ok(Math.abs(Number(combined.era) - 3.21) < 0.05, `combined ERA should be ~3.21, got ${combined.era}`);
  assert.ok(Math.abs(Number(combined.whip) - 1.06) < 0.05, `combined WHIP should be ~1.06, got ${combined.whip}`);
  assert.equal(combined.strikeOuts, 80);
  assert.equal(combined.baseOnBalls, 20);
});

test('rule: crossBookSynthetic blocks VALUE on cross-book synthetic quote pair', () => {
  const handler = JS_HANDLERS.crossBookSynthetic;
  assert.ok(handler, 'handler must be registered');

  // Case 1: synthetic cross-book pair
  const syntheticContext = {
    item: {
      currentOdds: { awayMoneylineBook: 'draftkings', homeMoneylineBook: 'fanduel' }
    },
    option: { sameBookDevig: false }
  };
  const result1 = handler(syntheticContext, {});
  assert.equal(result1.fired, true, 'synthetic pair should fire');

  // Case 2: clean same-book pair
  const cleanContext = {
    item: {
      currentOdds: { awayMoneylineBook: 'pinnacle', homeMoneylineBook: 'pinnacle' }
    },
    option: { sameBookDevig: true }
  };
  const result2 = handler(cleanContext, {});
  assert.equal(result2.fired, false, 'clean same-book pair should not fire');
});

test('rule: adverseSelectionHighEdge blocks extreme edge >= 12% without confirmed lineups', () => {
  const handler = JS_HANDLERS.adverseSelectionHighEdge;
  assert.ok(handler, 'handler must be registered');

  // Case 1: 14% edge with unconfirmed lineup -> blocked
  const unconfirmedContext = {
    option: { edge: 14.0 },
    item: {
      lineups: {
        away: { confirmed: false, count: 0 },
        home: { confirmed: false, count: 0 }
      }
    }
  };
  const result1 = handler(unconfirmedContext, { max_unconfirmed_edge: 12.0 });
  assert.equal(result1.fired, true, 'should fire on unconfirmed lineup with high edge');

  // Case 2: 14% edge WITH confirmed lineup -> allowed through
  const confirmedContext = {
    option: { edge: 14.0 },
    item: {
      lineups: {
        away: { confirmed: true, count: 9 },
        home: { confirmed: true, count: 9 }
      }
    }
  };
  const result2 = handler(confirmedContext, { max_unconfirmed_edge: 12.0 });
  assert.equal(result2.fired, false, 'confirmed lineup should not fire');

  // Case 3: 5% edge without confirmed lineup -> allowed through
  const normalContext = {
    option: { edge: 5.0 },
    item: {
      lineups: {
        away: { confirmed: false, count: 0 },
        home: { confirmed: false, count: 0 }
      }
    }
  };
  const result3 = handler(normalContext, { max_unconfirmed_edge: 12.0 });
  assert.equal(result3.fired, false, 'normal edge should not fire');
});
