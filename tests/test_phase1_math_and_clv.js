import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dampenRawEdge,
  pitcherRestProfile,
  predictGameMoneylineCore,
  runEnvironmentEdgeScale,
  weatherRunAdjustment
} from '../src/core/prediction_core.js';
import { buildContributions } from '../src/auditCard.js';
import { calibratePercent } from '../src/calibration.js';
import { loadEvolutionControls, moneylineWeightMultiplier } from '../src/evolutionControls.js';
import {
  applyClvGateToPrediction,
  clvGateReason,
  DEFAULT_CLV_GATE,
  evaluateClvGate,
  summarizeClv,
  summarizeShadowRecoveryClv
} from '../src/clv_gate.js';
import { applyMoneylineValueMarket } from '../src/mlb.js';

function baseBundle(overrides = {}) {
  const game = {
    gamePk: 881001,
    officialDate: '2026-07-21',
    gameDate: '2026-07-21T23:05:00Z',
    venue: { id: 119, name: 'Dodger Stadium' },
    weather: { temp: '70', wind: '0 mph' },
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
    },
    ...(overrides.game || {})
  };
  return {
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
    ...overrides,
    game
  };
}

function makeValueGame() {
  const game = {
    gamePk: 920001,
    dateYmd: '2026-08-15',
    status: 'Scheduled',
    matchup: 'Away Team @ Home Team',
    away: {
      id: 1,
      name: 'Away Team',
      abbreviation: 'AWY',
      winProbability: 38,
      starter: { fullName: 'Away Starter' },
      record: { wins: 32, losses: 43, pct: '.427' }
    },
    home: {
      id: 2,
      name: 'Home Team',
      abbreviation: 'HOM',
      winProbability: 62,
      starter: { fullName: 'Home Starter' },
      record: { wins: 46, losses: 29, pct: '.613' }
    },
    winner: { id: 2, name: 'Home Team', abbreviation: 'HOM', winProbability: 62 },
    pick: { id: 2, name: 'Home Team', abbreviation: 'HOM', winProbability: 62, confidence: 'model' },
    currentOdds: {
      awayMoneyline: 145,
      homeMoneyline: -125,
      moneylineBook: 'FanDuel',
      oddsFetchedAt: new Date().toISOString()
    },
    modelBreakdown: {
      rawEdge: 0.55,
      matchupEdge: 0.3,
      recordContextEdge: 0.02,
      recordDominated: false,
      starterEdge: 0.2,
      offenseEdge: 0.1,
      bullpenEdge: 0.05,
      lineupEdge: 0.05
    }
  };
  applyMoneylineValueMarket(game);
  return game;
}

test('1.1 dampenRawEdge is strictly monotonic, odd-symmetric, and concave with no cliff drops', () => {
  let prev = -Infinity;
  for (let i = -200; i <= 200; i += 1) {
    const e = i / 100;
    const { dampenedEdge, dampeningFactor } = dampenRawEdge(e);
    assert.ok(dampenedEdge > prev, `dampenedEdge must strictly increase at e=${e}`);
    assert.ok(dampeningFactor > 0 && dampeningFactor <= 0.66);
    prev = dampenedEdge;
  }

  // Legacy cliffs at 0.25 and 0.50 previously caused downward jumps.
  assert.ok(dampenRawEdge(0.26).dampenedEdge > dampenRawEdge(0.24).dampenedEdge);
  assert.ok(dampenRawEdge(0.51).dampenedEdge > dampenRawEdge(0.49).dampenedEdge);

  // Odd symmetry.
  assert.equal(dampenRawEdge(-0.42).dampenedEdge, -dampenRawEdge(0.42).dampenedEdge);
  // Concave factor strictly declines with magnitude.
  assert.ok(dampenRawEdge(0.8).dampeningFactor < dampenRawEdge(0.2).dampeningFactor);
});

test('1.2 weather/park run-environment scales edge symmetrically toward 50% in high-scoring games and preserves auditCard sum', () => {
  // Word-boundary check: "South" must NOT trigger wind-out.
  assert.equal(weatherRunAdjustment({ temp: '70', wind: '15 mph South' }), 0);
  assert.ok(weatherRunAdjustment({ temp: '85', wind: '15 mph Out to CF' }) > 0.3);
  assert.ok(weatherRunAdjustment({ temp: '55', wind: '15 mph In from CF' }) < -0.3);

  // High-scoring environment compresses scale < 1; low-scoring sharpens scale > 1.
  assert.ok(runEnvironmentEdgeScale(0.45, 1.15) < 1.0);
  assert.ok(runEnvironmentEdgeScale(-0.40, 0.90) > 1.0);
  assert.equal(runEnvironmentEdgeScale(0, 1.0), 1.0);

  // Home favorite scenario: wind-out compresses home prob closer to 50% (rawHomeProb decreases).
  const homeFavNeutral = predictGameMoneylineCore(
    baseBundle({
      pitcherStats: new Map([
        [111, { era: '5.20', whip: '1.45' }],
        [222, { era: '2.80', whip: '1.00' }]
      ]),
      game: { weather: { temp: '70', wind: '0 mph' } }
    })
  );
  const homeFavHotWindOut = predictGameMoneylineCore(
    baseBundle({
      pitcherStats: new Map([
        [111, { era: '5.20', whip: '1.45' }],
        [222, { era: '2.80', whip: '1.00' }]
      ]),
      game: { weather: { temp: '92', wind: '18 mph Out to CF' } }
    })
  );
  assert.ok(homeFavNeutral.raw.homeProbability > 55);
  assert.ok(homeFavHotWindOut.raw.homeProbability < homeFavNeutral.raw.homeProbability);

  // Away favorite scenario: wind-out MUST ALSO compress away favorite toward 50% (rawHomeProb INCREASES!).
  // Before Fase 1, weatherComponent always hurt home even when away was favored.
  const awayFavBase = {
    teamStats: new Map([
      [147, { hitting: { gamesPlayed: 100, runs: 540, ops: '.810' }, pitching: { gamesPlayed: 100, runs: 360, era: '3.40' } }],
      [119, { hitting: { gamesPlayed: 100, runs: 390, ops: '.670' }, pitching: { gamesPlayed: 100, runs: 520, era: '4.95' } }]
    ]),
    pitcherStats: new Map([
      [111, { era: '2.60', whip: '0.98' }],
      [222, { era: '5.40', whip: '1.50' }]
    ])
  };
  const awayFavNeutral = predictGameMoneylineCore(
    baseBundle({
      ...awayFavBase,
      game: { weather: { temp: '70', wind: '0 mph' } }
    })
  );
  const awayFavHotWindOut = predictGameMoneylineCore(
    baseBundle({
      ...awayFavBase,
      game: { weather: { temp: '92', wind: '18 mph Out to CF' } }
    })
  );
  assert.ok(awayFavNeutral.raw.homeProbability < 45);
  assert.ok(awayFavHotWindOut.raw.homeProbability > awayFavNeutral.raw.homeProbability);

  // Audit card contribution sum MUST remain exact to rawEdge.
  const contrib = buildContributions(homeFavHotWindOut.modelBreakdown);
  assert.equal(contrib.complete, true);
});

test('1.3 pitcherRestProfile rewards 5-7d extra rest and only penalizes short rest (<=3d) or long layoff (>=10d)', () => {
  const p = { fullName: 'Ace Pitcher' };
  const dateYmd = '2026-07-21';
  assert.equal(pitcherRestProfile(p, { lastStartDate: '2026-07-17' }, dateYmd).multiplier, 0.85); // 3d short rest
  assert.equal(pitcherRestProfile(p, { lastStartDate: '2026-07-16' }, dateYmd).multiplier, 1.0);  // 4d normal
  assert.equal(pitcherRestProfile(p, { lastStartDate: '2026-07-15' }, dateYmd).multiplier, 1.02); // 5d extra
  assert.equal(pitcherRestProfile(p, { lastStartDate: '2026-07-14' }, dateYmd).multiplier, 1.02); // 6d extra
  assert.equal(pitcherRestProfile(p, { lastStartDate: '2026-07-13' }, dateYmd).multiplier, 1.02); // 7d extra
  assert.equal(pitcherRestProfile(p, { lastStartDate: '2026-07-12' }, dateYmd).multiplier, 1.0);  // 8d extended neutral
  assert.equal(pitcherRestProfile(p, { lastStartDate: '2026-07-10' }, dateYmd).multiplier, 0.93); // 10d layoff rust

  // End-to-end check: home SP on 6d extra rest beats identical away SP on 4d normal rest.
  const out = predictGameMoneylineCore(
    baseBundle({
      pitcherRecentStarts: new Map([
        [111, { lastStartDate: '2026-07-16', games: 3, innings: 18 }], // 4d normal
        [222, { lastStartDate: '2026-07-14', games: 3, innings: 18 }]  // 6d extra
      ])
    })
  );
  assert.ok(out.modelBreakdown.fatigueEdge > 0);
});

test('1.4 CLV gate separates noise from significant degradation, throttles smoothly, and auto-recovers via post-block shadow CLV', () => {
  // 1) Noisy tiny negative average (alternating +1.5 / -1.6 -> avg -0.05, |t| << 0.75): must stay OPEN.
  const noisyRows = [];
  for (let i = 0; i < 24; i += 1) {
    noisyRows.push({
      status: 'settled',
      market: 'moneyline',
      clv: i % 2 === 0 ? 1.5 : -1.6
    });
  }
  const noisySummary = summarizeClv(noisyRows);
  const noisyEval = evaluateClvGate(noisySummary, DEFAULT_CLV_GATE);
  assert.equal(noisyEval.status, 'open');
  assert.equal(noisyEval.blocked, false);
  assert.equal(noisyEval.stakeMultiplier, 1.0);

  // 2) Moderate negative evidence (t between -0.75 and -1.25) -> 0.5x throttle, stays VALUE.
  const moderateSummary = { sample: 25, avgClv: -0.4, seClv: 0.4 }; // t = -1.0
  const moderateEval = evaluateClvGate(moderateSummary, DEFAULT_CLV_GATE);
  assert.equal(moderateEval.status, 'throttled');
  assert.equal(moderateEval.blocked, false);
  assert.equal(moderateEval.stakeMultiplier, 0.5);

  const throttledGame = makeValueGame();
  assert.equal(throttledGame.betDecision.status, 'VALUE');
  const origStake = throttledGame.valuePick.kellyStakePercent;
  const origEdge = throttledGame.betDecision.edge;
  applyClvGateToPrediction(throttledGame, moderateSummary, DEFAULT_CLV_GATE);
  assert.equal(throttledGame.betDecision.status, 'VALUE');
  assert.equal(throttledGame.betDecision.edge, origEdge);
  assert.ok(throttledGame.valuePick.kellyStakePercent < origStake);
  assert.equal(throttledGame.betDecision.clvGate.stakeMultiplier, 0.5);

  // 3) Stronger negative evidence (t = -1.4) -> 0.25x throttle.
  const heavyThrottleEval = evaluateClvGate({ sample: 25, avgClv: -0.56, seClv: 0.4 }, DEFAULT_CLV_GATE);
  assert.equal(heavyThrottleEval.status, 'throttled');
  assert.equal(heavyThrottleEval.stakeMultiplier, 0.25);

  // 4) Statistically significant negative CLV (t <= -1.65) without shadow recovery -> BLOCK.
  const realBadRows = [];
  for (let i = 0; i < 24; i += 1) {
    realBadRows.push({
      status: 'settled',
      market: 'moneyline',
      clv: -0.8 + (i % 3) * 0.1,
      settled_at: `2026-08-01T12:${String(i).padStart(2, '0')}:00Z`
    });
  }
  const badSummary = summarizeClv(realBadRows);
  assert.ok(badSummary.tStat <= -1.65);
  assert.ok(clvGateReason(badSummary, DEFAULT_CLV_GATE));

  // Stale shadow rows BEFORE the latest real settled bet must NOT unlock the block!
  const staleShadowRows = [];
  for (let i = 0; i < 12; i += 1) {
    staleShadowRows.push({
      status: 'settled',
      market: 'moneyline',
      clv: 1.2,
      settled_at: `2026-07-15T12:${String(i).padStart(2, '0')}:00Z`
    });
  }
  const staleShadowSummary = summarizeShadowRecoveryClv(realBadRows, staleShadowRows);
  assert.equal(evaluateClvGate(badSummary, DEFAULT_CLV_GATE, staleShadowSummary).blocked, true);

  // 5) Fresh post-block shadow rows with positive CLV (n >= 10) unlock PROBATION RECOVERY at 0.5x stake!
  const freshShadowRows = [];
  for (let i = 0; i < 12; i += 1) {
    freshShadowRows.push({
      status: 'settled',
      market: 'moneyline',
      clv: 0.65,
      settled_at: `2026-08-05T12:${String(i).padStart(2, '0')}:00Z`
    });
  }
  const freshShadowSummary = summarizeShadowRecoveryClv(realBadRows, freshShadowRows);
  assert.equal(freshShadowSummary.sample, 10);
  const recoveredEval = evaluateClvGate(badSummary, DEFAULT_CLV_GATE, freshShadowSummary);
  assert.equal(recoveredEval.status, 'probation_recovery');
  assert.equal(recoveredEval.blocked, false);
  assert.equal(recoveredEval.recoveredViaShadow, true);
  assert.equal(recoveredEval.stakeMultiplier, 0.5);

  const recoveredGame = makeValueGame();
  applyClvGateToPrediction(recoveredGame, badSummary, DEFAULT_CLV_GATE, freshShadowSummary);
  assert.equal(recoveredGame.betDecision.status, 'VALUE');
  assert.equal(recoveredGame.betDecision.clvGate.recoveredViaShadow, true);
  assert.equal(recoveredGame.betDecision.clvGate.stakeMultiplier, 0.5);

  // 6) Audit fix #1: Probation recovery must NOT re-lock after 1 or 5 successful real probation bets settle!
  const realAfter1Probation = [
    ...realBadRows,
    { status: 'settled', market: 'moneyline', clv: 0.9, settled_at: '2026-08-06T22:00:00Z' }
  ];
  const summaryAfter1 = summarizeClv(realAfter1Probation);
  const recAfter1 = summarizeShadowRecoveryClv(realAfter1Probation, freshShadowRows);
  assert.equal(evaluateClvGate(summaryAfter1, DEFAULT_CLV_GATE, recAfter1).status, 'probation_recovery');

  // If probation real bets turn sharply negative, gate must re-block promptly!
  const realFailedProbation = [
    ...realBadRows,
    ...Array.from({ length: 6 }, (_, i) => ({
      status: 'settled',
      market: 'moneyline',
      clv: -2.0,
      settled_at: `2026-08-0${6 + i}T22:00:00Z`
    }))
  ];
  const summaryFailed = summarizeClv(realFailedProbation);
  const recFailed = summarizeShadowRecoveryClv(realFailedProbation, freshShadowRows);
  assert.equal(evaluateClvGate(summaryFailed, DEFAULT_CLV_GATE, recFailed).blocked, true);
});

test('1.5 audit regressions: idempotent applyClvGateToPrediction, non-Map/100-scale park lookup, and recovery multiplier clamping', () => {
  // Idempotent throttling & full stake restoration when gate re-opens.
  const game = makeValueGame();
  const baseStake = game.valuePick.kellyStakePercent;
  const throttleSummary = { sample: 25, avgClv: -0.4, seClv: 0.4 }; // t = -1.0 -> 0.5x
  applyClvGateToPrediction(game, throttleSummary, DEFAULT_CLV_GATE);
  const stakeOnce = game.valuePick.kellyStakePercent;
  applyClvGateToPrediction(game, throttleSummary, DEFAULT_CLV_GATE);
  applyClvGateToPrediction(game, throttleSummary, DEFAULT_CLV_GATE);
  assert.equal(game.valuePick.kellyStakePercent, stakeOnce, 'repeated throttling must be idempotent');
  assert.equal(game.betDecision.clvGate.originalStakePercent, baseStake);

  // Restores baseStake when gate becomes open again.
  applyClvGateToPrediction(game, { sample: 25, avgClv: 0.5, seClv: 0.3 }, DEFAULT_CLV_GATE);
  assert.equal(game.valuePick.kellyStakePercent, baseStake);
  assert.equal(game.betDecision.clvGate.status, 'open');

  // 100-scale parkRunFactor normalization & Map / Array / plain-object parkFactorBaselines parity.
  assert.equal(runEnvironmentEdgeScale(0.2, 115), runEnvironmentEdgeScale(0.2, 1.15));
  const coorsMap = predictGameMoneylineCore(
    baseBundle({ parkFactorBaselines: new Map([[119, { runFactor: 1.15, homeRunFactor: 1.15 }]]) })
  );
  const coorsArray = predictGameMoneylineCore(
    baseBundle({ parkFactorBaselines: [{ id: 119, value: { runFactor: 1.15, homeRunFactor: 1.15 } }] })
  );
  const coorsObj = predictGameMoneylineCore(
    baseBundle({ parkFactorBaselines: { 119: { runFactor: 1.15, homeRunFactor: 1.15 } } })
  );
  assert.equal(coorsArray.modelBreakdown.runEnvScale, coorsMap.modelBreakdown.runEnvScale);
  assert.equal(coorsObj.modelBreakdown.runEnvScale, coorsMap.modelBreakdown.runEnvScale);

  // recoveryThrottleMultiplier clamped to [0.1, 1.0].
  const badSummary = { sample: 25, avgClv: -1.0, seClv: 0.2 };
  const okShadow = { sample: 12, avgClv: 0.5 };
  assert.equal(
    evaluateClvGate(badSummary, { ...DEFAULT_CLV_GATE, recoveryThrottleMultiplier: 2.5 }, okShadow).stakeMultiplier,
    1.0
  );
  assert.equal(
    evaluateClvGate(badSummary, { ...DEFAULT_CLV_GATE, recoveryThrottleMultiplier: 0 }, okShadow).stakeMultiplier,
    0.1
  );

  // Tiny non-zero seClv must produce finite tStat instead of collapsing to -Infinity.
  const tinyVarRows = Array.from({ length: 20 }, (_, i) => ({
    status: 'settled',
    market: 'moneyline',
    clv: i === 0 ? -0.0001 : -0.00012
  }));
  const tinySummary = summarizeClv(tinyVarRows);
  assert.ok(Number.isFinite(tinySummary.tStat));
});
