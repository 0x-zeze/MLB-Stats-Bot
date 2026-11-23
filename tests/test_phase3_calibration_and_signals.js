import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RAW_PROBABILITY_MIN,
  RAW_PROBABILITY_MAX,
  CALIBRATED_PROBABILITY_MIN,
  CALIBRATED_PROBABILITY_MAX,
  predictGameMoneylineCore,
  projectStarterInnings,
  starterSeasonEdge,
  bullpenAvailabilityEdge,
  computePlatoonEdge,
  lineupWinEdge,
  teamHomeParkFactors,
  parkAdjustedRpg,
  parkAdjustedOps,
  parkAdjustedIso,
  parkAdjustedEra,
  parkAdjustedWhip,
  parkAdjustedHr9,
  blendedTeamOffenseEdge,
  blendedTeamPreventionEdge,
  skellamWinProbability,
  computeExpectedRunsModel
} from '../src/core/prediction_core.js';
import {
  applyParametricCalibration,
  validateParametricCalibration,
  buildCalibrationArtifact,
  computeCalibrationContentHash,
  computeCalibrationArtifactHash,
  calibrateProbabilityWithArtifact,
  verifyCalibrationArtifact
} from '../src/calibration.js';
import { applyOofCalibration } from '../src/core/calibration_proposal.js';
import {
  kellyUncertaintyMultiplier,
  __mlbTestInternals
} from '../src/mlb.js';
import { buildPickConfidence } from '../src/confidence_signals.js';

const { extractLineupProfile } = __mlbTestInternals;

const PARK_BASELINES = new Map([
  [115, { runFactor: 1.15, homeRunFactor: 1.12, label: 'Coors Field' }],
  [136, { runFactor: 0.94, homeRunFactor: 0.95, label: 'T-Mobile Park' }],
  [119, { runFactor: 0.99, homeRunFactor: 1.02, label: 'Dodger Stadium' }],
  [147, { runFactor: 1.01, homeRunFactor: 1.08, label: 'Yankee Stadium' }]
]);

function makeBundle(overrides = {}) {
  const base = {
    game: {
      gamePk: 940001,
      officialDate: '2026-07-15',
      gameDate: '2026-07-15T23:10:00Z',
      venue: { id: 119, name: 'Dodger Stadium' },
      weather: { temp: '72', wind: '5 mph' },
      status: { detailedState: 'Scheduled' },
      teams: {
        away: {
          team: { id: 147, name: 'New York Yankees', abbreviation: 'NYY' },
          leagueRecord: { wins: 50, losses: 50 },
          probablePitcher: { id: 1001, fullName: 'Away Starter', pitchHand: { code: 'R' } }
        },
        home: {
          team: { id: 119, name: 'Los Angeles Dodgers', abbreviation: 'LAD' },
          leagueRecord: { wins: 50, losses: 50 },
          probablePitcher: { id: 2002, fullName: 'Home Starter', pitchHand: { code: 'L' } }
        }
      }
    },
    teamStats: new Map([
      [147, {
        hitting: { gamesPlayed: 100, runs: 440, ops: '.720' },
        pitching: { era: '4.20', whip: '1.30' },
        hittingAdvanced: { iso: 0.15, strikeoutsPerPlateAppearance: 0.22, walksPerPlateAppearance: 0.085 },
        pitchingAdvanced: { strikeoutsMinusWalksPercentage: 0.12, homeRunsPer9: 1.1 }
      }],
      [119, {
        hitting: { gamesPlayed: 100, runs: 440, ops: '.720' },
        pitching: { era: '4.20', whip: '1.30' },
        hittingAdvanced: { iso: 0.15, strikeoutsPerPlateAppearance: 0.22, walksPerPlateAppearance: 0.085 },
        pitchingAdvanced: { strikeoutsMinusWalksPercentage: 0.12, homeRunsPer9: 1.1 }
      }]
    ]),
    standings: new Map([
      [147, {
        leagueRecord: { wins: 50, losses: 50 },
        gamesPlayed: 100,
        runsScored: 440,
        runsAllowed: 440,
        runDifferential: 0,
        records: { splitRecords: [{ type: 'left', pct: 0.5 }, { type: 'right', pct: 0.5 }] }
      }],
      [119, {
        leagueRecord: { wins: 50, losses: 50 },
        gamesPlayed: 100,
        runsScored: 440,
        runsAllowed: 440,
        runDifferential: 0,
        records: { splitRecords: [{ type: 'left', pct: 0.5 }, { type: 'right', pct: 0.5 }] }
      }]
    ]),
    pitcherStats: new Map([
      [1001, { inningsPitched: '108.0', gamesStarted: 20, era: '4.20', whip: '1.30', strikeOuts: 105, baseOnBalls: 35, strikeoutsMinusWalksPercentage: 0.12, homeRunsPer9: 1.1 }],
      [2002, { inningsPitched: '108.0', gamesStarted: 20, era: '4.20', whip: '1.30', strikeOuts: 105, baseOnBalls: 35, strikeoutsMinusWalksPercentage: 0.12, homeRunsPer9: 1.1 }]
    ]),
    pitcherDetails: new Map([
      [1001, { pitchHand: { code: 'R' } }],
      [2002, { pitchHand: { code: 'L' } }]
    ]),
    pitcherRecentStarts: new Map(),
    bullpenProfiles: new Map([
      [147, { teamId: 147, fatigueScore: 1, backToBackRelievers: 0, highPitchRelievers: 0, reliefEra: 4.2, reliefWhip: 1.3, reliefKbb: 2.3, reliefHr9: 1.1 }],
      [119, { teamId: 119, fatigueScore: 1, backToBackRelievers: 0, highPitchRelievers: 0, reliefEra: 4.2, reliefWhip: 1.3, reliefKbb: 2.3, reliefHr9: 1.1 }]
    ]),
    scheduleFatigueProfiles: new Map(),
    headToHead: { games: 0 },
    injuryProfiles: new Map(),
    lineupProfiles: { away: null, home: null },
    modelMemory: {},
    rollingTeamStats: new Map(),
    evolutionControls: {},
    parkFactorBaselines: PARK_BASELINES,
    calibratePercent: (raw) => raw,
    nowMs: new Date('2026-07-15T12:00:00Z')
  };
  return { ...base, ...overrides };
}

test('3.1 relaxed probability clamp [15%, 85%] removes artificial 35%/65% wall on extreme mismatches', () => {
  assert.equal(RAW_PROBABILITY_MIN, 15);
  assert.equal(RAW_PROBABILITY_MAX, 85);
  assert.equal(CALIBRATED_PROBABILITY_MIN, 15);
  assert.equal(CALIBRATED_PROBABILITY_MAX, 85);

  // Extreme mismatch: dominant 75-25 home powerhouse + ace SP + rested elite pen
  // vs weak 25-75 away club + 6.50 ERA starter + exhausted bad pen.
  const mismatch = makeBundle({
    teamStats: new Map([
      [147, {
        hitting: { gamesPlayed: 100, runs: 310, ops: '.615' },
        pitching: { era: '5.80', whip: '1.58' },
        hittingAdvanced: { iso: 0.1, strikeoutsPerPlateAppearance: 0.28, walksPerPlateAppearance: 0.06 },
        pitchingAdvanced: { strikeoutsMinusWalksPercentage: 0.05, homeRunsPer9: 1.7 }
      }],
      [119, {
        hitting: { gamesPlayed: 100, runs: 610, ops: '.860' },
        pitching: { era: '2.85', whip: '1.05' },
        hittingAdvanced: { iso: 0.23, strikeoutsPerPlateAppearance: 0.17, walksPerPlateAppearance: 0.11 },
        pitchingAdvanced: { strikeoutsMinusWalksPercentage: 0.21, homeRunsPer9: 0.7 }
      }]
    ]),
    standings: new Map([
      [147, { leagueRecord: { wins: 25, losses: 75 }, gamesPlayed: 100, runsScored: 310, runsAllowed: 590, runDifferential: -280, records: { splitRecords: [{ type: 'lastTen', pct: 0.2 }, { type: 'away', pct: 0.22 }] } }],
      [119, { leagueRecord: { wins: 75, losses: 25 }, gamesPlayed: 100, runsScored: 610, runsAllowed: 310, runDifferential: 300, records: { splitRecords: [{ type: 'lastTen', pct: 0.8 }, { type: 'home', pct: 0.78 }] } }]
    ]),
    pitcherStats: new Map([
      [1001, { inningsPitched: '90.0', gamesStarted: 20, era: '6.50', whip: '1.68', strikeOuts: 60, baseOnBalls: 45, strikeoutsMinusWalksPercentage: 0.04, homeRunsPer9: 1.9 }],
      [2002, { inningsPitched: '135.0', gamesStarted: 20, era: '2.10', whip: '0.90', strikeOuts: 175, baseOnBalls: 25, strikeoutsMinusWalksPercentage: 0.28, homeRunsPer9: 0.55 }]
    ]),
    bullpenProfiles: new Map([
      [147, { teamId: 147, fatigueScore: 5, backToBackRelievers: 3, highPitchRelievers: 2, reliefEra: 5.5, reliefWhip: 1.55, reliefKbb: 1.5, reliefHr9: 1.6 }],
      [119, { teamId: 119, fatigueScore: 0, backToBackRelievers: 0, highPitchRelievers: 0, reliefEra: 2.6, reliefWhip: 1.0, reliefKbb: 3.6, reliefHr9: 0.6 }]
    ]),
    lineupProfiles: {
      away: { confirmed: true, count: 9, qualityScore: -0.11, platoonWoba: 0.275, platoonOps: 0.625 },
      home: { confirmed: true, count: 9, qualityScore: 0.12, platoonWoba: 0.375, platoonOps: 0.855 }
    }
  });

  const out = predictGameMoneylineCore(mismatch);
  assert.ok(out.raw.homeProbability > 65, `expected raw home prob > 65% on heavy mismatch, got ${out.raw.homeProbability}`);
  assert.ok(out.raw.homeProbability <= 85);
  assert.ok(out.calibrated.homeProbability > 65);
  assert.ok(out.calibrated.awayProbability < 35 && out.calibrated.awayProbability >= 15);
  assert.ok(Math.abs(out.calibrated.homeProbability + out.calibrated.awayProbability - 100) < 1e-9);
});

test('3.2 Platt & Beta-Logit calibration in JS: monotonicity, artifact verification, and proposal support', () => {
  // Validation guards
  assert.equal(validateParametricCalibration({ method: 'platt', a: 0.72, b: -0.05 }).valid, true);
  assert.equal(validateParametricCalibration({ method: 'platt', a: -0.1, b: 0 }).valid, false);
  assert.equal(validateParametricCalibration({ method: 'beta_logit', a: 0.65, b: 0.85, c: 0.02 }).valid, true);
  assert.equal(validateParametricCalibration({ method: 'beta_logit', a: 0, b: 0, c: 0 }).valid, false);
  assert.equal(validateParametricCalibration({ method: 'beta_logit', a: -0.2, b: 0.8, c: 0 }).valid, false);

  // Strict monotonicity across [0.10, 0.90] for both Platt and Beta-Logit
  const platt = { method: 'platt', a: 0.65, b: -0.04 };
  const betaLogit = { method: 'beta_logit', a: 0.55, b: 0.85, c: 0.03 };
  const grid = [0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9];
  for (let i = 1; i < grid.length; i += 1) {
    assert.ok(
      applyParametricCalibration(platt, grid[i]) > applyParametricCalibration(platt, grid[i - 1]),
      'Platt must be strictly monotonic increasing'
    );
    assert.ok(
      applyParametricCalibration(betaLogit, grid[i]) > applyParametricCalibration(betaLogit, grid[i - 1]),
      'Beta-Logit must be strictly monotonic increasing'
    );
  }

  // Exact identity check: a=1, b=0 (Platt) and a=1, b=1, c=0 (Beta-Logit)
  assert.ok(Math.abs(applyParametricCalibration({ method: 'platt', a: 1, b: 0 }, 0.63) - 0.63) < 1e-12);
  assert.ok(Math.abs(applyParametricCalibration({ method: 'beta_logit', a: 1, b: 1, c: 0 }, 0.63) - 0.63) < 1e-12);

  // Proposal module supports beta_logit with exact same formula
  const propOut = applyOofCalibration({ method: 'beta_logit', params: { a: 0.55, b: 0.85, c: 0.03 } }, 0.62);
  assert.ok(Math.abs(propOut - applyParametricCalibration(betaLogit, 0.62)) < 1e-12);

  // Full active parametric calibration artifact lifecycle + tamper verification
  const seed = {
    market: 'moneyline',
    mapping: null,
    parametric: platt,
    shrinkFactor: 0.5,
    modelId: 'heuristic_v1',
    modelImplVersion: 'moneyline-core-v1.0',
    featureSchemaVersion: 'mlb-control-features-v1.0',
    population: 'all_game',
    trainingCutoff: '2026-07-01',
    method: 'platt',
    samples: 240,
    datasetHash: 'ds-phase3-001'
  };
  const expectedContentHash = computeCalibrationContentHash(seed);
  const artifact = buildCalibrationArtifact({
    market: 'moneyline',
    mapping: platt,
    meta: {
      markets: {
        moneyline: {
          status: 'success',
          samples: 240,
          method: 'platt',
          bindings: {
            modelId: 'heuristic_v1',
            modelImplVersion: 'moneyline-core-v1.0',
            featureSchemaVersion: 'mlb-control-features-v1.0',
            population: 'all_game',
            trainingCutoff: '2026-07-01',
            method: 'platt',
            datasetHash: 'ds-phase3-001',
            contentHash: expectedContentHash
          }
        }
      }
    }
  });
  assert.equal(artifact.mode, 'parametric');
  assert.equal(artifact.integrityStatus, 'active');
  assert.equal(artifact.promotionSafe, true);
  assert.equal(verifyCalibrationArtifact(artifact).ok, true);

  const calVal = calibrateProbabilityWithArtifact(0.7, artifact);
  assert.ok(Math.abs(calVal - applyParametricCalibration(platt, 0.7)) < 1e-12);

  // Tampering parametric slope must fail artifact verification
  const tampered = { ...artifact, parametric: { ...platt, a: 1.5 } };
  assert.equal(verifyCalibrationArtifact(tampered).ok, false);
  assert.ok(verifyCalibrationArtifact(tampered).reasons.includes('calibration_content_hash_mismatch'));

  // Low-sample parametric (< 60) triggers parametric_low_sample_shrink and promotionSafe=false
  const lowSampleArt = buildCalibrationArtifact({
    market: 'moneyline',
    mapping: platt,
    meta: { markets: { moneyline: { status: 'success', samples: 40, method: 'platt' } } }
  });
  assert.equal(lowSampleArt.mode, 'parametric_low_sample_shrink');
  assert.equal(lowSampleArt.promotionSafe, false);
  assert.ok(computeCalibrationArtifactHash(artifact).length === 24);
});

test('3.3a continuous starter/bullpen IP coupling replaces binary 4.8 IP cliff with per-team scaling', () => {
  const openerIp = projectStarterInnings(null, null, { isOpener: true }, null);
  const shortSp = projectStarterInnings({ inningsPitched: '80.0', gamesStarted: 20 }, { games: 5, innings: 20 }, { isOpener: false }, null);
  const avgSp = projectStarterInnings({ inningsPitched: '108.0', gamesStarted: 20 }, { games: 5, innings: 27 }, { isOpener: false }, null);
  const workhorseSp = projectStarterInnings({ inningsPitched: '136.0', gamesStarted: 20 }, { games: 5, innings: 34 }, { isOpener: false }, null);
  const shortRestWorkhorse = projectStarterInnings(
    { inningsPitched: '136.0', gamesStarted: 20 },
    { games: 5, innings: 34 },
    { isOpener: false },
    { restDays: 3 }
  );

  assert.equal(openerIp.projectedIp, 1.75);
  assert.ok(openerIp.bullpenShare > 0.8);
  assert.ok(shortSp.projectedIp < avgSp.projectedIp && avgSp.projectedIp < workhorseSp.projectedIp);
  assert.ok(shortRestWorkhorse.projectedIp < workhorseSp.projectedIp);
  assert.ok(Math.abs(workhorseSp.starterShare + workhorseSp.bullpenShare - 1.0) < 1e-4);

  // Per-team asymmetric bullpen exposure:
  // Away has a terrible/exhausted bullpen; Home has an average bullpen.
  // When Away uses an opener (awayBullpenShare=0.81) while Home starts a workhorse (0.28),
  // Away's bad bullpen hurts Away MUCH MORE than when Away also starts a workhorse!
  const homePen = { fatigueScore: 0, backToBackRelievers: 0, highPitchRelievers: 0, reliefEra: 4.2, reliefWhip: 1.3, reliefKbb: 2.3, reliefHr9: 1.1 };
  const awayBadPen = { fatigueScore: 2, backToBackRelievers: 1, highPitchRelievers: 1, reliefEra: 5.2, reliefWhip: 1.48, reliefKbb: 1.7, reliefHr9: 1.5 };

  const awayOpenerBpEdge = bullpenAvailabilityEdge(homePen, awayBadPen, {
    homeBullpenShare: 0.28,
    awayBullpenShare: 0.81
  });
  const awayWorkhorseBpEdge = bullpenAvailabilityEdge(homePen, awayBadPen, {
    homeBullpenShare: 0.28,
    awayBullpenShare: 0.28
  });
  assert.ok(
    awayOpenerBpEdge > awayWorkhorseBpEdge,
    `expected away opener to magnify away bad-pen drag (${awayOpenerBpEdge} > ${awayWorkhorseBpEdge})`
  );
});

test('3.3b confirmationEdge is separated from mean probability shift into confidence/Kelly signal', () => {
  const confirmedAgreeBundle = makeBundle({
    pitcherStats: new Map([
      [1001, { inningsPitched: '108.0', gamesStarted: 20, era: '5.10', whip: '1.45', strikeOuts: 85, baseOnBalls: 42, strikeoutsMinusWalksPercentage: 0.08, homeRunsPer9: 1.4 }],
      [2002, { inningsPitched: '108.0', gamesStarted: 20, era: '3.10', whip: '1.08', strikeOuts: 140, baseOnBalls: 28, strikeoutsMinusWalksPercentage: 0.19, homeRunsPer9: 0.75 }]
    ]),
    lineupProfiles: {
      away: { confirmed: true, count: 9, qualityScore: -0.05 },
      home: { confirmed: true, count: 9, qualityScore: 0.08 }
    }
  });

  const out = predictGameMoneylineCore(confirmedAgreeBundle);
  const mb = out.modelBreakdown;
  assert.equal(mb.confirmationEdge, 0, 'confirmationEdge must not shift mean probability');
  assert.equal(out.confirmationEdge, 0);
  assert.equal(mb.lineupAgreesWithMatchup, true);
  assert.ok(mb.confirmationSignal >= 0.75, `expected high confirmationSignal, got ${mb.confirmationSignal}`);

  // Exact audit-card sum parity still holds to machine precision!
  const recordScale = mb.recordDominated ? 0.45 : 1.0;
  const auditSum =
    mb.offenseEdge +
    mb.preventionEdge +
    mb.starterEdge +
    mb.lineupEdge +
    mb.bullpenEdge +
    mb.fatigueEdge +
    (mb.log5Edge + mb.formEdge + mb.h2hEdge + mb.memoryEdge + mb.platoonEdge) * recordScale +
    mb.homeFieldEdge +
    mb.weatherEdge +
    mb.confirmationEdge;
  assert.ok(Math.abs(auditSum - mb.rawEdge) < 1e-12, `audit sum ${auditSum} != rawEdge ${mb.rawEdge}`);

  // Opposite confirmed lineup lowers Kelly multiplier and lineup confidence score!
  const opposingItem = {
    featureFallbacks: { count: 0 },
    lineups: { away: { confirmed: true, count: 9 }, home: { confirmed: true, count: 9 } },
    modelBreakdown: { ...mb, lineupAgreesWithMatchup: false, lineupOpposesMatchup: true, confirmationSignal: 0.35 }
  };
  const agreeingItem = {
    featureFallbacks: { count: 0 },
    lineups: { away: { confirmed: true, count: 9 }, home: { confirmed: true, count: 9 } },
    modelBreakdown: { ...mb, lineupAgreesWithMatchup: true, lineupOpposesMatchup: false, confirmationSignal: 0.9 }
  };
  assert.equal(kellyUncertaintyMultiplier(agreeingItem), 1.0);
  assert.equal(kellyUncertaintyMultiplier(opposingItem), 0.92);

  const confAgree = buildPickConfidence(agreeingItem, 'home');
  const confOppose = buildPickConfidence(opposingItem, 'home');
  assert.ok(confAgree.score > confOppose.score, 'agreeing confirmationSignal must raise confidence score');
});

test('3.3c parallel Expected Runs (lambda_home, lambda_away) -> Skellam/Pythagenpat reflects run environment & pitching', () => {
  // Skellam variance property: same +20% run-ratio advantage has HIGHER win prob
  // in a low-scoring pitcher's duel (3.6 vs 3.0) than in a Coors shootout (6.0 vs 5.0)!
  const lowScoreWin = skellamWinProbability(3.6, 3.0, 0.5);
  const highScoreWin = skellamWinProbability(6.0, 5.0, 0.5);
  assert.ok(lowScoreWin > 0.5 && highScoreWin > 0.5);
  // Wait: Poisson SNR for fixed ratio (1.2x) scales as sqrt(lambda): wait —
  // (6.0-5.0)/sqrt(11) = 0.3015 > (3.6-3.0)/sqrt(6.6) = 0.2335!
  // Whereas for fixed RUN DIFFERENCE (+1.0 run), low-scoring (4.0 vs 3.0) has
  // HIGHER win probability than high-scoring (6.5 vs 5.5)! Let's verify that exact physics!
  const lowFixedDiff = skellamWinProbability(4.0, 3.0, 0.5);
  const highFixedDiff = skellamWinProbability(6.5, 5.5, 0.5);
  assert.ok(
    lowFixedDiff > highFixedDiff,
    `fixed +1 run edge must yield higher win prob in low-scoring game (${lowFixedDiff} > ${highFixedDiff})`
  );

  // Full expectedRuns output inside predictGameMoneylineCore
  const out = predictGameMoneylineCore(makeBundle());
  const er = out.expectedRuns;
  assert.ok(er);
  assert.ok(er.homeLambda > er.awayLambda, 'even teams at home must give home slightly higher expected runs');
  assert.ok(er.skellamHomeProbability > 50 && er.skellamHomeProbability < 58);
  assert.ok(Math.abs(er.skellamHomeProbability + er.skellamAwayProbability - 100) < 0.2);

  // Coors Field elevates both team lambdas vs neutral park
  const coorsEr = computeExpectedRunsModel({
    gameParkRunFactor: 1.15,
    weatherAdj: 0.35
  });
  const pitcherParkEr = computeExpectedRunsModel({
    gameParkRunFactor: 0.94,
    weatherAdj: -0.3
  });
  assert.ok(coorsEr.totalLambda > pitcherParkEr.totalLambda + 1.5);
});

test('3.4a park-adjusted team stats remove Coors Field / pitcher-park distortion', () => {
  const coorsFactors = teamHomeParkFactors(PARK_BASELINES, 115); // Coors 1.15 -> eff 1.075
  const seattleFactors = teamHomeParkFactors(PARK_BASELINES, 136); // T-Mobile 0.94 -> eff 0.97
  assert.ok(Math.abs(coorsFactors.effectiveRunFactor - 1.075) < 1e-9);
  assert.ok(Math.abs(seattleFactors.effectiveRunFactor - 0.97) < 1e-9);

  // Two clubs with IDENTICAL raw RPG (4.50) and OPS (.730),
  // Home = Seattle (pitcher park 0.94), Away = Colorado (Coors 1.15).
  // Once park-adjusted, Seattle's offense is genuinely STRONGER than Colorado's!
  const identicalStats = {
    hitting: { gamesPlayed: 100, runs: 450, ops: '.730' },
    pitching: { era: '4.30', whip: '1.30' },
    hittingAdvanced: { iso: 0.15, strikeoutsPerPlateAppearance: 0.22, walksPerPlateAppearance: 0.085 },
    pitchingAdvanced: { strikeoutsMinusWalksPercentage: 0.12, homeRunsPer9: 1.1 }
  };
  const offEdge = blendedTeamOffenseEdge(identicalStats, identicalStats, null, null, {
    homeParkFactors: seattleFactors,
    awayParkFactors: coorsFactors
  });
  assert.ok(offEdge.edge > 0, `expected pitcher-park club offense to beat Coors club on equal raw stats, got ${offEdge.edge}`);

  // Conversely, on IDENTICAL raw ERA (4.30), Colorado's pitchers actually performed
  // better relative to Coors Field than Seattle's pitchers at T-Mobile Park!
  const prevEdge = blendedTeamPreventionEdge(identicalStats, identicalStats, null, null, {
    homeParkFactors: seattleFactors,
    awayParkFactors: coorsFactors
  });
  assert.ok(prevEdge.edge < 0, `expected Coors pitching to rate better on equal raw ERA, got ${prevEdge.edge}`);
});

test('3.4b lineup-weighted platoon split replaces standings Win% without double-counting in lineupWinEdge', () => {
  // Confirm lineupWinEdge no longer changes when only platoonOps changes (zero double-counting!)
  const lHomeA = { confirmed: true, count: 9, qualityScore: 0.05, topOrderOps: 0.78, platoonOps: 0.85 };
  const lHomeB = { confirmed: true, count: 9, qualityScore: 0.05, topOrderOps: 0.78, platoonOps: 0.62 };
  const lAway = { confirmed: true, count: 9, qualityScore: 0.05, topOrderOps: 0.78, platoonOps: 0.72 };
  assert.equal(lineupWinEdge(lHomeA, lAway, [], []), lineupWinEdge(lHomeB, lAway, [], []));

  // computePlatoonEdge uses actual 9-batter platoonWoba/platoonOps when present, ignoring noisy standings!
  const noisyStandingsHome = { records: { splitRecords: [{ type: 'right', pct: 0.30 }] } };
  const noisyStandingsAway = { records: { splitRecords: [{ type: 'left', pct: 0.70 }] } };
  const resWoba = computePlatoonEdge(
    { platoonWoba: 0.36, platoonOps: 0.82, platoonCoverage: 1.0 },
    { platoonWoba: 0.29, platoonOps: 0.66, platoonCoverage: 1.0 },
    noisyStandingsHome,
    noisyStandingsAway,
    { pitchHand: { code: 'L' } },
    { pitchHand: { code: 'R' } }
  );
  assert.equal(resWoba.source, 'lineup_weighted_woba');
  assert.ok(resWoba.edge > 0.05, `lineup platoonWoba must override opposite noisy standings split, got ${resWoba.edge}`);

  // Falls back cleanly to standings split ONLY when lineup platoon splits are absent
  const resFallback = computePlatoonEdge(
    { confirmed: true, count: 9 },
    { confirmed: true, count: 9 },
    noisyStandingsHome,
    noisyStandingsAway,
    { pitchHand: { code: 'L' } },
    { pitchHand: { code: 'R' } }
  );
  assert.equal(resFallback.source, 'standings_fallback');
  assert.ok(resFallback.edge < 0);

  // extractLineupProfile computes platoonOps, platoonWoba, and Bayesian handedness prior for rookies
  const makePlayer = (id, slot, batSide, ops, obp, slg) => ({
    person: { id, fullName: `Batter ${slot}`, batSide: { code: batSide } },
    battingOrder: String(slot * 100),
    seasonStats: { batting: { plateAppearances: 200, atBats: 180, ops: String(ops), obp: String(obp), slg: String(slg), homeRuns: 10 } }
  });
  const players = {};
  for (let s = 1; s <= 9; s += 1) {
    players[`ID${s}`] = makePlayer(s, s, 'L', 0.74, 0.33, 0.41);
  }
  const vsRhp = extractLineupProfile({ players }, { oppPitchHand: 'R' });
  const vsLhp = extractLineupProfile({ players }, { oppPitchHand: 'L' });
  assert.ok(vsRhp.platoonOps > vsLhp.platoonOps, 'all-LHB lineup must project higher platoonOps vs RHP than LHP');
  assert.ok(vsRhp.platoonWoba > vsLhp.platoonWoba, 'all-LHB lineup must project higher platoonWoba vs RHP than LHP');
  assert.ok(vsRhp.platoonWobaDelta > 0 && vsLhp.platoonWobaDelta < 0);
  assert.ok(vsRhp.platoonCoverage > 0);
});

test('Fase 3 Audit #1: park adjustment never distorts league-average DEFAULTS fallbacks or TBD starters', () => {
  const coors = teamHomeParkFactors(PARK_BASELINES, 115);
  const seattle = teamHomeParkFactors(PARK_BASELINES, 136);

  // Missing stats MUST return exact league DEFAULTS regardless of team home park!
  assert.equal(parkAdjustedRpg({}, coors), 4.4);
  assert.equal(parkAdjustedOps({}, coors), 0.72);
  assert.equal(parkAdjustedIso({}, coors), 0.15);
  assert.equal(parkAdjustedEra({}, coors), 4.2);
  assert.equal(parkAdjustedWhip({}, coors), 1.3);
  assert.equal(parkAdjustedHr9({}, coors), 1.1);
  assert.equal(parkAdjustedEra({}, seattle), 4.2);

  // TBD / opener starter (pitcherStats: null) must NOT get a phantom Coors ERA discount!
  const coorsTbd = computeExpectedRunsModel({
    homePitcherStats: null,
    awayPitcherStats: null,
    homeParkFactors: coors,
    awayParkFactors: seattle
  });
  assert.equal(coorsTbd.homeBlendedEra, 4.2);
  assert.equal(coorsTbd.awayBlendedEra, 4.2);
});

test('Fase 3 Audit #2: asymmetric starter IP coupling never dilutes opposing ace when one side uses an opener', () => {
  const strongStarter = {
    inningsPitched: '136.0',
    gamesStarted: 20,
    era: '3.20',
    whip: '1.10',
    strikeOuts: 130,
    baseOnBalls: 35,
    strikeoutsMinusWalksPercentage: 0.17,
    homeRunsPer9: 0.9
  };
  // Home uses opener (null stats, share 1.75/9) vs Away strong starter pitching 6.8 IP (share 6.8/9).
  const openerVsWorkhorseAce = starterSeasonEdge(null, strongStarter, {
    homeStarterShare: 1.75 / 9,
    awayStarterShare: 6.8 / 9
  });
  // Baseline: both sides average 5.4 IP share.
  const baselineVsAce = starterSeasonEdge(null, strongStarter, {
    homeStarterShare: 5.4 / 9,
    awayStarterShare: 5.4 / 9
  });
  // Away starter's 6.8 IP workload MUST strengthen Away's edge (more negative), never shrink it!
  assert.ok(
    openerVsWorkhorseAce < baselineVsAce,
    `expected opposing 6.8 IP ace to have stronger edge (${openerVsWorkhorseAce} < ${baselineVsAce})`
  );
  // Symmetric check: Home using a weak starter pitching MORE innings vs an average
  // away starter hurts Home more strictly according to Home starter's inning share.
  const weakStarter = {
    inningsPitched: '70.0',
    gamesStarted: 20,
    era: '5.10',
    whip: '1.46',
    strikeOuts: 60,
    baseOnBalls: 32,
    strikeoutsMinusWalksPercentage: 0.08,
    homeRunsPer9: 1.45
  };
  const shortHomeVsAvg = starterSeasonEdge(weakStarter, null, {
    homeStarterShare: 3.5 / 9,
    awayStarterShare: 5.4 / 9
  });
  const longHomeVsAvg = starterSeasonEdge(weakStarter, null, {
    homeStarterShare: 6.2 / 9,
    awayStarterShare: 5.4 / 9
  });
  assert.ok(
    longHomeVsAvg < shortHomeVsAvg,
    `expected bad home starter pitching MORE innings to hurt home more (${longHomeVsAvg} < ${shortHomeVsAvg})`
  );
});

test('Fase 3 Audit #3: pure platoon delta eliminates offense triple-counting and refuses fake fallback when batSide & splits absent', () => {
  // Hitters with strong overall OPS (.850) but NO platoonSplits and NO batSide.code:
  // extractLineupProfile MUST return null platoon metrics (not fake platoon from overall OPS!).
  const playersNoHand = {};
  for (let s = 1; s <= 9; s += 1) {
    playersNoHand[`ID${s}`] = {
      person: { id: s, fullName: `Hitter ${s}` },
      battingOrder: String(s * 100),
      seasonStats: { batting: { plateAppearances: 200, atBats: 180, ops: '0.850', obp: '0.380', slg: '0.470', homeRuns: 15 } }
    };
  }
  const noPlatoonEvidence = extractLineupProfile({ players: playersNoHand }, { oppPitchHand: 'R' });
  assert.equal(noPlatoonEvidence.platoonOps, null);
  assert.equal(noPlatoonEvidence.platoonWoba, null);
  assert.equal(noPlatoonEvidence.platoonOpsDelta, null);
  assert.equal(noPlatoonEvidence.platoonWobaDelta, null);
  assert.equal(noPlatoonEvidence.platoonCoverage, 0);

  // Two lineups with wildly different overall talent (.850 vs .650) but ZERO platoon split delta:
  // computePlatoonEdge MUST return 0 (overall talent lives in offenseEdge & lineupEdge, not platoonEdge!).
  const zeroDeltaEdge = computePlatoonEdge(
    { platoonOps: 0.85, platoonWoba: 0.37, platoonOpsDelta: 0, platoonWobaDelta: 0, platoonCoverage: 1.0 },
    { platoonOps: 0.65, platoonWoba: 0.28, platoonOpsDelta: 0, platoonWobaDelta: 0, platoonCoverage: 1.0 },
    null,
    null,
    null,
    null
  );
  assert.equal(zeroDeltaEdge.source, 'lineup_weighted_woba_delta');
  assert.equal(zeroDeltaEdge.edge, 0);

  // Genuine platoon split advantage (+0.025 wOBA delta vs -0.015 wOBA delta) drives clean positive edge.
  const realDeltaEdge = computePlatoonEdge(
    { platoonOps: 0.78, platoonWoba: 0.345, platoonOpsDelta: 0.055, platoonWobaDelta: 0.025, platoonCoverage: 1.0 },
    { platoonOps: 0.70, platoonWoba: 0.305, platoonOpsDelta: -0.035, platoonWobaDelta: -0.015, platoonCoverage: 1.0 },
    null,
    null,
    null,
    null
  );
  assert.equal(realDeltaEdge.source, 'lineup_weighted_woba_delta');
  assert.ok(realDeltaEdge.edge > 0.05);
});

test('Fase 3 Audit #4: confirmationSignal respects pick side sign (opposing value pick is NOT boosted when lineup confirms opponent)', () => {
  const baseItem = {
    lineups: { away: { confirmed: true, count: 9 }, home: { confirmed: true, count: 9 } },
    injuries: { away: [], home: [] },
    headToHead: { games: 0 },
    modelBreakdown: {
      starterEdge: 0.15,
      offenseEdge: 0.1,
      lineupEdge: 0.05,
      matchupEdge: 0.3, // favors HOME
      bullpenEdge: 0,
      formEdge: 0,
      h2hEdge: 0,
      platoonEdge: 0,
      fatigueEdge: 0
    }
  };
  const confirmedAgreeHome = {
    ...baseItem,
    modelBreakdown: {
      ...baseItem.modelBreakdown,
      lineupAgreesWithMatchup: true,
      lineupOpposesMatchup: false,
      confirmationSignal: 0.9
    }
  };
  const neutralConfirm = {
    ...baseItem,
    modelBreakdown: {
      ...baseItem.modelBreakdown,
      lineupAgreesWithMatchup: false,
      lineupOpposesMatchup: false,
      confirmationSignal: 0.55
    }
  };

  // For HOME pick: confirmed lineup agreeing with HOME boosts HOME confidence.
  const homeConfirmed = buildPickConfidence(confirmedAgreeHome, 'home');
  const homeNeutral = buildPickConfidence(neutralConfirm, 'home');
  assert.ok(homeConfirmed.score > homeNeutral.score);

  // For AWAY pick (underdog opposing HOME): confirmed lineup agreeing with HOME MUST LOWER Away confidence!
  const awayConfirmedOpp = buildPickConfidence(confirmedAgreeHome, 'away');
  const awayNeutral = buildPickConfidence(neutralConfirm, 'away');
  assert.ok(
    awayConfirmedOpp.score < awayNeutral.score,
    `expected opposing confirmed lineup to lower Away confidence (${awayConfirmedOpp.score} < ${awayNeutral.score})`
  );
});

test('Fase 3 Audit #6: isotonic map contentHash stays pure even if metadata contains unused parametric block', () => {
  const isoMap = [[0.35, 0.38], [0.5, 0.5], [0.65, 0.61]];
  const pureIso = buildCalibrationArtifact({
    market: 'moneyline',
    mapping: isoMap,
    meta: { markets: { moneyline: { status: 'success', samples: 200 } } }
  });
  const isoWithUnusedParam = buildCalibrationArtifact({
    market: 'moneyline',
    mapping: isoMap,
    meta: {
      markets: {
        moneyline: {
          status: 'success',
          samples: 200,
          parametric: { method: 'platt', a: 0.7, b: 0 }
        }
      }
    }
  });
  assert.equal(isoWithUnusedParam.mode, 'map');
  assert.equal(isoWithUnusedParam.parametric, undefined);
  assert.equal(isoWithUnusedParam.contentHash, pureIso.contentHash);
});

