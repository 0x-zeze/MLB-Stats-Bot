import assert from 'node:assert/strict';
import test from 'node:test';

import { __mlbTestInternals, applyTotalsValueMarket } from '../src/mlb.js';

const { negativeBinomialCdf, poissonCdf, totalRunProbability } = __mlbTestInternals;

test('negative binomial reduces to Poisson when variance ratio <= 1', () => {
  const nb = negativeBinomialCdf(8.5, 8, 1.0);
  const poisson = poissonCdf(8.5, 8);
  assert.ok(Math.abs(nb - poisson) < 1e-9, `expected NB(phi=1) == Poisson, got ${nb} vs ${poisson}`);
});

test('negative binomial has fatter tails than Poisson on both ends', () => {
  // High line: over prob (1 - CDF) should be larger under NB (fat upper tail).
  const overNB = 1 - negativeBinomialCdf(8.5, 11);
  const overPoisson = 1 - poissonCdf(8.5, 11);
  assert.ok(overNB > overPoisson, `expected NB over@11 > Poisson, got ${overNB} vs ${overPoisson}`);

  // Low line: under prob (CDF) should be larger under NB (fat lower tail).
  const underNB = negativeBinomialCdf(8.5, 6);
  const underPoisson = poissonCdf(8.5, 6);
  assert.ok(underNB > underPoisson, `expected NB under@6 > Poisson, got ${underNB} vs ${underPoisson}`);
});

test('totalRunProbability over and under sum to 1', () => {
  const over = totalRunProbability(8.5, 8.5, 'over');
  const under = totalRunProbability(8.5, 8.5, 'under');
  assert.ok(Math.abs(over + under - 1) < 1e-9, `expected sum 1, got ${over + under}`);
});

test('negative binomial CDF converges to 1 over a wide range', () => {
  const mass = negativeBinomialCdf(8.5, 60);
  assert.ok(Math.abs(mass - 1) < 1e-4, `expected CDF -> 1, got ${mass}`);
});

function totalsItem({ side, over, under, overNoVig, underNoVig, overPrice, underPrice, opener = false }) {
  return {
    away: opener ? { openerSituation: { isOpener: true } } : {},
    home: {},
    currentOdds: { overPrice, underPrice, totalBook: 'dk' },
    totalRuns: {
      hasMarketPrice: true,
      bestLean: `${side === 'over' ? 'Over' : 'Under'} 8.5`,
      marketLine: 8.5,
      overMarketProbability: over,
      underMarketProbability: under,
      overNoVigProbability: overNoVig,
      underNoVigProbability: underNoVig
    }
  };
}

test('totals VALUE when edge clears threshold, above floor, no opener', () => {
  const item = applyTotalsValueMarket(
    totalsItem({ side: 'over', over: 64, under: 36, overNoVig: 52, underNoVig: 48, overPrice: -105, underPrice: -115 })
  );
  assert.equal(item.totalsBetDecision.status, 'VALUE');
  assert.equal(item.totalsValuePick.side, 'over');
  assert.ok(item.totalsValuePick.kellyStakePercent > 0, 'expected positive Kelly stake');
});

test('totals NO BET below conviction floor', () => {
  const item = applyTotalsValueMarket(
    totalsItem({ side: 'over', over: 55, under: 45, overNoVig: 50, underNoVig: 50, overPrice: -110, underPrice: -110 })
  );
  assert.equal(item.totalsBetDecision.status, 'NO BET');
  assert.match(item.totalsBetDecision.reason, /floor/);
});

test('totals NO BET when opener pollutes the run projection', () => {
  const item = applyTotalsValueMarket(
    totalsItem({ side: 'over', over: 64, under: 36, overNoVig: 52, underNoVig: 48, overPrice: -105, underPrice: -115, opener: true })
  );
  assert.equal(item.totalsBetDecision.status, 'NO BET');
  assert.ok(item.totalsBetDecision.reasons.some((r) => /opener/.test(r)));
});

test('totals LEAN ONLY when no live market price', () => {
  const item = applyTotalsValueMarket({
    away: {},
    home: {},
    currentOdds: {},
    totalRuns: { hasMarketPrice: false, bestLean: 'Over 8.5' }
  });
  assert.equal(item.totalsBetDecision.status, 'LEAN ONLY');
});
