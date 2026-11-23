import assert from 'node:assert/strict';
import test from 'node:test';

import { powerDevigProbabilities, noVigMarketProbabilities } from '../src/market_residual.js';
import {
  americanImpliedProbability,
  bookmakerSharpWeight,
  computeSharpWeightedSameBookFair,
  extractSameBookQuotePairs
} from '../src/lineMovement.js';
import { applyClvGateToPrediction } from '../src/clv_gate.js';
import {
  applyDailySlateExposureCap,
  applyMoneylineValueMarket,
  expectedValuePercent,
  kellyUncertaintyMultiplier
} from '../src/mlb.js';

function makeGame(overrides = {}) {
  const base = {
    gamePk: 930001,
    dateYmd: '2026-08-15',
    status: 'Scheduled',
    away: {
      id: 1,
      name: 'Away Team',
      abbreviation: 'AWY',
      winProbability: 36,
      starter: { fullName: 'Away Starter' },
      record: { wins: 34, losses: 41, pct: '.453' }
    },
    home: {
      id: 2,
      name: 'Home Team',
      abbreviation: 'HOM',
      winProbability: 64,
      starter: { fullName: 'Home Starter' },
      record: { wins: 46, losses: 29, pct: '.613' }
    },
    currentOdds: {
      awayMoneyline: 145,
      homeMoneyline: -130,
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
    },
    lineups: {
      away: { confirmed: true, count: 9 },
      home: { confirmed: true, count: 9 }
    }
  };
  return {
    ...base,
    ...overrides,
    away: { ...base.away, ...overrides.away },
    home: { ...base.home, ...overrides.home },
    currentOdds: { ...base.currentOdds, ...overrides.currentOdds },
    modelBreakdown: { ...base.modelBreakdown, ...overrides.modelBreakdown },
    lineups: overrides.lineups === null
      ? null
      : {
          away: { ...base.lineups.away, ...overrides.lineups?.away },
          home: { ...base.lineups.home, ...overrides.lineups?.home }
        }
  };
}

test('2.1 Power De-vig solves p1^k + p2^k = 1 and corrects favorite-longshot bias vs proportional', () => {
  // Heavy favorite -220 (implied 68.75%) vs underdog +185 (implied 35.09%)
  const favImp = 220 / 320;
  const dogImp = 100 / 285;
  const propFav = favImp / (favImp + dogImp);
  const propDog = dogImp / (favImp + dogImp);

  const power = powerDevigProbabilities(favImp, dogImp);
  assert.ok(power);
  assert.equal(power.method, 'power');
  assert.ok(power.exponent > 1.0);
  assert.ok(Math.abs(power.probA + power.probB - 1.0) < 1e-10);
  assert.ok(Math.abs(favImp ** power.exponent + dogImp ** power.exponent - 1.0) < 1e-10);

  // Favorite-longshot correction: Power De-vig assigns HIGHER fair prob to favorite
  // and LOWER fair prob to underdog than naive proportional normalization.
  assert.ok(power.probA > propFav);
  assert.ok(power.probB < propDog);

  const noVig = noVigMarketProbabilities({ homeMoneyline: -220, awayMoneyline: 185 });
  assert.ok(Math.abs(noVig.home - power.probA * 100) < 1e-6);
  assert.ok(Math.abs(noVig.away - power.probB * 100) < 1e-6);
});

test('2.1 sharp-book weighting prioritizes Pinnacle/Circa over retail books in sameBookFair', () => {
  assert.equal(bookmakerSharpWeight('pinnacle'), 4.0);
  assert.equal(bookmakerSharpWeight('Circa'), 4.0);
  assert.equal(bookmakerSharpWeight('fanduel'), 1.5);
  assert.equal(bookmakerSharpWeight('betmgm'), 1.0);

  const game = {
    gamePk: 991,
    home: { name: 'Los Angeles Dodgers' },
    away: { name: 'New York Yankees' }
  };
  const event = {
    id: 'evt-1',
    bookmakers: [
      {
        key: 'pinnacle',
        title: 'Pinnacle',
        markets: [{
          key: 'h2h',
          outcomes: [
            { name: 'Los Angeles Dodgers', price: -150 },
            { name: 'New York Yankees', price: 140 }
          ]
        }]
      },
      {
        key: 'betmgm',
        title: 'BetMGM',
        markets: [{
          key: 'h2h',
          outcomes: [
            { name: 'Los Angeles Dodgers', price: -110 },
            { name: 'New York Yankees', price: -110 }
          ]
        }]
      }
    ]
  };
  const pairs = extractSameBookQuotePairs(game, event);
  assert.equal(pairs.length, 2);

  const consensus = computeSharpWeightedSameBookFair(pairs);
  assert.equal(consensus.sharpBooksCount, 1);
  assert.equal(consensus.weighting, 'sharp_weighted_power');

  // Unweighted mean of ~59% (Pinnacle) and 50% (BetMGM) would be ~54.5%.
  // With 4.0x sharp weight vs 1.0x retail, weighted fair MUST be pulled strongly toward Pinnacle (>57%).
  assert.ok(consensus.home > 57.0, `expected sharp-weighted fair > 57%, got ${consensus.home}`);
});

test('2.2 Net Executable EV% discriminates payout slope and blocks vig-trapped favorites', () => {
  // Same +3.5pp above implied yields higher EV on underdog (+150) than heavy favorite (-200).
  const dogEv = expectedValuePercent(43.5, 150);  // 0.435 * 2.5 - 1 = +8.75% -> 8.8%
  const favEv = expectedValuePercent(68.5, -200); // 0.685 * 1.5 - 1 = +2.75% -> 2.8%
  assert.equal(dogEv, 8.8);
  assert.equal(favEv, 2.8);
  assert.ok(dogEv > favEv);

  // Vig-trapped heavy favorite: -200 / +165 (viggy book, overround ~4.4%).
  // Power fair home ~64.5%, raw implied home = 66.7%.
  // Model home = 67.2% -> edge vs fair is +2.7% (>= 2.0% edge floor!),
  // BUT executable EV on -200 is only 0.672 * 1.5 - 1 = +0.8% (< 2.0% EV floor!).
  const vigTrapGame = makeGame({
    away: { winProbability: 32.8 },
    home: { winProbability: 67.2 },
    currentOdds: {
      awayMoneyline: 165,
      homeMoneyline: -200,
      moneylineBook: 'BetMGM',
      oddsFetchedAt: new Date().toISOString()
    }
  });
  applyMoneylineValueMarket(vigTrapGame);
  assert.equal(vigTrapGame.valuePick.side, 'home');
  assert.ok(vigTrapGame.valuePick.edge >= 2.0);
  assert.ok(vigTrapGame.valuePick.expectedValuePct < 2.0);
  assert.equal(vigTrapGame.betDecision.status, 'NO BET');
  assert.ok(vigTrapGame.betDecision.reasons.some((r) => /net executable EV/.test(r)));

  // Even under disagreementAwayBypass, negative executable EV must still be blocked.
  const negEvDisagreement = makeGame({
    away: { winProbability: 50.2, record: { wins: 45, losses: 30, pct: '.600' } },
    home: { winProbability: 49.8, record: { wins: 45, losses: 30, pct: '.600' } },
    currentOdds: {
      awayMoneyline: -108, // implied 51.9%, decimal 1.926 -> EV = 0.502 * 1.926 - 1 = -3.3%
      homeMoneyline: -112,
      moneylineBook: 'FanDuel',
      oddsFetchedAt: new Date().toISOString()
    }
  });
  applyMoneylineValueMarket(negEvDisagreement);
  assert.equal(negEvDisagreement.betDecision.status, 'NO BET');
  assert.ok(negEvDisagreement.betDecision.reasons.some((r) => /net executable EV/.test(r)));
});

test('2.3 Kelly sizing removes 1.5x disagreement boost, applies uncertainty shrinkage, and enforces single-bet cap', () => {
  // Disagreement away pick no longer gets 1.5x boost.
  const awayDisagree = makeGame({
    away: { winProbability: 58, record: { wins: 46, losses: 29, pct: '.613' } },
    home: { winProbability: 42, record: { wins: 44, losses: 31, pct: '.587' } },
    currentOdds: {
      awayMoneyline: 115,
      homeMoneyline: -135,
      moneylineBook: 'FanDuel',
      oddsFetchedAt: new Date().toISOString()
    }
  });
  applyMoneylineValueMarket(awayDisagree);
  assert.equal(awayDisagree.valuePick.isDisagreement, true);
  assert.equal(awayDisagree.valuePick.disagreementBoost, 1.0);
  assert.ok(awayDisagree.valuePick.kellyStakePercent <= 2.5);

  // Uncertainty shrinkage reduces stake for feature fallbacks and unconfirmed lineups.
  const cleanMult = kellyUncertaintyMultiplier({
    featureFallbacks: { count: 0 },
    lineups: { away: { confirmed: true, count: 9 }, home: { confirmed: true, count: 9 } }
  });
  const unconfirmedMult = kellyUncertaintyMultiplier({
    featureFallbacks: { count: 0 },
    lineups: { away: { confirmed: false, count: 0 }, home: { confirmed: true, count: 9 } }
  });
  const heavyFallbackMult = kellyUncertaintyMultiplier({
    featureFallbacks: { count: 4 },
    lineups: { away: { confirmed: false, count: 0 }, home: { confirmed: false, count: 0 } }
  });
  assert.equal(cleanMult, 1.0);
  assert.equal(unconfirmedMult, 0.85);
  assert.ok(heavyFallbackMult >= 0.5 && heavyFallbackMult < unconfirmedMult);

  // Verify smaller Kelly stake on unconfirmed/fallback game vs clean game (below cap).
  const cleanSmall = makeGame({
    away: { winProbability: 42 },
    home: { winProbability: 58 },
    currentOdds: { awayMoneyline: 115, homeMoneyline: -115, moneylineBook: 'FanDuel', oddsFetchedAt: new Date().toISOString() },
    featureFallbacks: { count: 0 }
  });
  const uncertainSmall = makeGame({
    away: { winProbability: 42 },
    home: { winProbability: 58 },
    currentOdds: { awayMoneyline: 115, homeMoneyline: -115, moneylineBook: 'FanDuel', oddsFetchedAt: new Date().toISOString() },
    featureFallbacks: { count: 3 },
    lineups: { away: { confirmed: false, count: 5 }, home: { confirmed: true, count: 9 } }
  });
  applyMoneylineValueMarket(cleanSmall);
  applyMoneylineValueMarket(uncertainSmall);
  assert.ok(uncertainSmall.valuePick.kellyStakePercent < cleanSmall.valuePick.kellyStakePercent);
});

test('2.4 applyDailySlateExposureCap scales proportionally to cap, is idempotent, and isolates dates', () => {
  const mkBet = (gamePk, dateYmd, stake, status = 'VALUE') => ({
    gamePk,
    dateYmd,
    valuePick: { kellyStakePercent: stake },
    betDecision: { status, kellyStakePercent: stake }
  });

  const slate = [
    mkBet(1, '2026-08-15', 2.5),
    mkBet(2, '2026-08-15', 2.5),
    mkBet(3, '2026-08-15', 2.5),
    mkBet(4, '2026-08-15', 2.5),
    mkBet(5, '2026-08-15', 2.5),
    mkBet(6, '2026-08-15', 2.5), // 6 * 2.5 = 15.0% > 10.0% cap
    mkBet(7, '2026-08-15', 2.0, 'NO BET'), // NO BET must be untouched
    mkBet(8, '2026-08-16', 2.5) // Separate date under cap -> untouched
  ];

  applyDailySlateExposureCap(slate, { maxDailyExposurePercent: 10.0 });

  const aug15Value = slate.slice(0, 6);
  const sumAug15 = Math.round(aug15Value.reduce((s, p) => s + p.valuePick.kellyStakePercent, 0) * 10) / 10;
  assert.equal(sumAug15, 10.0, 'scaled slate sum must equal cap exactly without exceeding it');
  assert.equal(slate[6].valuePick.kellyStakePercent, 2.0, 'NO BET stake must stay untouched');
  assert.equal(slate[7].valuePick.kellyStakePercent, 2.5, 'other date under cap must stay untouched');
  assert.equal(aug15Value[0].betDecision.slateExposureCap.applied, true);

  // Strict idempotency: repeated calls must not shrink stakes further!
  const snapshotStakes = aug15Value.map((p) => p.valuePick.kellyStakePercent);
  applyDailySlateExposureCap(slate, { maxDailyExposurePercent: 10.0 });
  applyDailySlateExposureCap(slate, { maxDailyExposurePercent: 10.0 });
  assert.deepEqual(aug15Value.map((p) => p.valuePick.kellyStakePercent), snapshotStakes);

  // Raising cap above total restores original pre-cap stakes cleanly.
  applyDailySlateExposureCap(slate, { maxDailyExposurePercent: 20.0 });
  assert.deepEqual(aug15Value.map((p) => p.valuePick.kellyStakePercent), [2.5, 2.5, 2.5, 2.5, 2.5, 2.5]);
  assert.equal(aug15Value[0].betDecision.slateExposureCap.applied, false);
});

test('Fase 2 Audit #1: applyDailySlateExposureCap honors committedLedgerBets and blocks on exhausted budget', () => {
  const mkBet = (gamePk, dateYmd, stake, status = 'VALUE') => ({
    gamePk,
    dateYmd,
    valuePick: { kellyStakePercent: stake },
    betDecision: { status, kellyStakePercent: stake, reasons: [] }
  });

  // 2 games already committed on 2026-08-15 (2.0% + 2.0% = 4.0%).
  // Voided / non-moneyline rows MUST NOT consume the moneyline daily budget.
  const committedRows = [
    { game_pk: '1', date_ymd: '2026-08-15', market: 'moneyline', status: 'open', units_staked: 2.0 },
    { game_pk: '2', date_ymd: '2026-08-15', market: 'moneyline', status: 'won', units_staked: 2.0 },
    { game_pk: '99', date_ymd: '2026-08-15', market: 'moneyline', status: 'void', units_staked: 5.0 },
    { game_pk: '98', date_ymd: '2026-08-15', market: 'totals', status: 'open', units_staked: 5.0 }
  ];

  // 2 already-committed games + 4 new uncommitted games (2.5% each = 10.0% new) under 10.0% cap.
  // Remaining budget = 10.0% - 4.0% = 6.0% -> 4 new bets share 6.0% => 1.5% each!
  const slate = [
    mkBet(1, '2026-08-15', 2.5),
    mkBet(2, '2026-08-15', 2.5),
    mkBet(3, '2026-08-15', 2.5),
    mkBet(4, '2026-08-15', 2.5),
    mkBet(5, '2026-08-15', 2.5),
    mkBet(6, '2026-08-15', 2.5)
  ];

  applyDailySlateExposureCap(slate, {
    maxDailyExposurePercent: 10.0,
    committedLedgerBets: committedRows
  });

  // Committed games remain locked at their ledger stake (2.0%).
  assert.equal(slate[0].valuePick.kellyStakePercent, 2.0);
  assert.equal(slate[1].valuePick.kellyStakePercent, 2.0);
  assert.equal(slate[0].betDecision.slateExposureCap.alreadyCommitted, true);

  // Uncommitted games split remaining 6.0% cleanly (1.5% each).
  const newStakes = slate.slice(2).map((p) => p.valuePick.kellyStakePercent);
  assert.deepEqual(newStakes, [1.5, 1.5, 1.5, 1.5]);
  const totalExposure = Math.round(slate.reduce((s, p) => s + p.valuePick.kellyStakePercent, 0) * 10) / 10;
  assert.equal(totalExposure, 10.0);

  // When committed ledger already consumes the entire 10.0% cap, new bets MUST become NO BET.
  const fullCommitted = [
    { game_pk: '11', date_ymd: '2026-08-16', market: 'moneyline', status: 'open', units_staked: 10.0 }
  ];
  const lateGame = [mkBet(12, '2026-08-16', 2.5)];
  applyDailySlateExposureCap(lateGame, {
    maxDailyExposurePercent: 10.0,
    committedLedgerBets: fullCommitted
  });
  assert.equal(lateGame[0].betDecision.status, 'NO BET');
  assert.equal(lateGame[0].betDecision.kellyStakePercent, 0);
  assert.equal(lateGame[0].valuePick.kellyStakePercent, 0);
  assert.equal(lateGame[0].betDecision.slateExposureCap.exhausted, true);
  assert.ok(/daily slate exposure cap/.test(lateGame[0].betDecision.reason));

  // Partial tiny remaining budget (0.2% left for 4 new bets): top 2 get 0.1%, other 2 downgrade to NO BET.
  const nearFullCommitted = [
    { game_pk: '21', date_ymd: '2026-08-17', market: 'moneyline', status: 'open', units_staked: 9.8 }
  ];
  const fourNew = [
    mkBet(22, '2026-08-17', 2.5),
    mkBet(23, '2026-08-17', 2.0),
    mkBet(24, '2026-08-17', 1.5),
    mkBet(25, '2026-08-17', 1.0)
  ];
  applyDailySlateExposureCap(fourNew, {
    maxDailyExposurePercent: 10.0,
    committedLedgerBets: nearFullCommitted
  });
  assert.equal(fourNew[0].betDecision.status, 'VALUE');
  assert.equal(fourNew[0].betDecision.kellyStakePercent, 0.1);
  assert.equal(fourNew[1].betDecision.status, 'VALUE');
  assert.equal(fourNew[1].betDecision.kellyStakePercent, 0.1);
  assert.equal(fourNew[2].betDecision.status, 'NO BET');
  assert.equal(fourNew[2].betDecision.kellyStakePercent, 0);
  assert.equal(fourNew[2].betDecision.slateExposureCap.exhausted, true);
  assert.equal(fourNew[3].betDecision.status, 'NO BET');
  assert.equal(fourNew[3].betDecision.kellyStakePercent, 0);
});

test('Fase 2 Audit #2: applyClvGateToPrediction composes cleanly and idempotently with applyDailySlateExposureCap', () => {
  const mkBet = (gamePk) => ({
    gamePk,
    dateYmd: '2026-08-15',
    valuePick: { kellyStakePercent: 2.5 },
    betDecision: { status: 'VALUE', kellyStakePercent: 2.5, reasons: [] }
  });

  const slate = [mkBet(1), mkBet(2), mkBet(3), mkBet(4), mkBet(5), mkBet(6)];
  const openSummary = { sample: 40, avgClv: 0.8, stdClv: 2.0, seClv: 0.316, tStat: 2.53 };
  const halfThrottleSummary = { sample: 40, avgClv: -0.32, stdClv: 2.0, seClv: 0.316, tStat: -1.01 };
  const quarterThrottleSummary = { sample: 40, avgClv: -0.48, stdClv: 2.0, seClv: 0.316, tStat: -1.52 };
  const blockedSummary = { sample: 40, avgClv: -1.2, stdClv: 2.0, seClv: 0.316, tStat: -3.79 };
  const gateCfg = {
    minSample: 20,
    throttleHalfTStat: -0.75,
    throttleQuarterTStat: -1.28,
    blockTStat: -1.96
  };

  // Step 1: Open CLV gate (1.0x) + 10.0% slate cap -> 6 * 2.5 = 15% capped to 10.0% (1.7, 1.7, 1.7, 1.7, 1.6, 1.6).
  for (const p of slate) applyClvGateToPrediction(p, openSummary, gateCfg);
  applyDailySlateExposureCap(slate, { maxDailyExposurePercent: 10.0 });
  const cappedOpenStakes = slate.map((p) => p.valuePick.kellyStakePercent);
  assert.equal(Math.round(cappedOpenStakes.reduce((a, b) => a + b, 0) * 10) / 10, 10.0);

  // Step 2a: Re-run on SAME objects when CLV gate throttles to 0.5x -> each bet becomes 2.5 * 0.5 = 1.3% (sum 7.8% <= 10.0%).
  // Slate cap MUST NOT resurrect the stale 1.7% pre-throttle stake!
  for (const p of slate) applyClvGateToPrediction(p, halfThrottleSummary, gateCfg);
  applyDailySlateExposureCap(slate, { maxDailyExposurePercent: 10.0 });
  assert.deepEqual(
    slate.map((p) => p.valuePick.kellyStakePercent),
    [1.3, 1.3, 1.3, 1.3, 1.3, 1.3]
  );

  // Step 2b: Re-run when CLV gate tightens to 0.25x -> each bet becomes 2.5 * 0.25 = 0.6%.
  for (const p of slate) applyClvGateToPrediction(p, quarterThrottleSummary, gateCfg);
  applyDailySlateExposureCap(slate, { maxDailyExposurePercent: 10.0 });
  assert.deepEqual(
    slate.map((p) => p.valuePick.kellyStakePercent),
    [0.6, 0.6, 0.6, 0.6, 0.6, 0.6]
  );

  // Step 3: Re-run when CLV gate returns to open (1.0x) -> restores 2.5% base, then slate cap brings sum back to 10.0%.
  for (const p of slate) applyClvGateToPrediction(p, openSummary, gateCfg);
  applyDailySlateExposureCap(slate, { maxDailyExposurePercent: 10.0 });
  assert.deepEqual(
    slate.map((p) => p.valuePick.kellyStakePercent),
    cappedOpenStakes
  );

  // Step 4: CLV gate blocks (0x) -> NO BET, true unthrottled 2.5% preserved on valuePick for shadow ledger, stale slateExposureCap cleared.
  applyClvGateToPrediction(slate[0], blockedSummary, gateCfg);
  assert.equal(slate[0].betDecision.status, 'NO BET');
  assert.equal(slate[0].valuePick.kellyStakePercent, 2.5);
  assert.equal(slate[0].betDecision.slateExposureCap, undefined);
});

test('Fase 2 Audit #3: invalid American odds in (-100, 100) are uniformly rejected', () => {
  assert.equal(expectedValuePercent(60, 0), null);
  assert.equal(expectedValuePercent(60, 50), null);
  assert.equal(expectedValuePercent(60, -50), null);
  assert.equal(expectedValuePercent(60, 99), null);
  assert.equal(expectedValuePercent(60, -99), null);
  assert.notEqual(expectedValuePercent(60, 100), null);
  assert.notEqual(expectedValuePercent(60, -100), null);

  assert.equal(americanImpliedProbability(0), null);
  assert.equal(americanImpliedProbability(50), null);
  assert.equal(americanImpliedProbability(-50), null);
  assert.equal(americanImpliedProbability(-99), null);
  assert.equal(americanImpliedProbability(100), 0.5);
  assert.equal(americanImpliedProbability(-100), 0.5);
});
