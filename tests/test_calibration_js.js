import assert from 'node:assert/strict';
import test from 'node:test';

import { calibrateProbability, calibratePercent, hasCalibrationMap } from '../src/calibration.js';
import { applyTotalRunMarket } from '../src/mlb.js';

test('calibration applies the trained moneyline isotonic map', () => {
  // From data/calibration_maps.json: a raw 0.65 maps below 0.56 (the model is
  // overconfident at that band), so calibration must pull it DOWN, never up.
  if (hasCalibrationMap('moneyline')) {
    const calibrated = calibrateProbability(0.65, 'moneyline');
    assert.ok(calibrated < 0.65, `expected calibrated < raw, got ${calibrated}`);
    assert.ok(calibrated > 0.5, `expected calibrated still a favorite, got ${calibrated}`);
  }
});

test('calibratePercent round-trips the percent scale', () => {
  const result = calibratePercent(65, 'moneyline');
  assert.ok(result > 1 && result <= 100, `expected a percent, got ${result}`);
});

test('unknown market falls back to the raw probability', () => {
  assert.equal(calibrateProbability(0.61, 'no_such_market'), 0.61);
});

test('calibrated probability is clamped to [0.05, 0.95]', () => {
  assert.ok(calibrateProbability(0.999, 'moneyline') <= 0.95);
  assert.ok(calibrateProbability(0.001, 'moneyline') >= 0.05);
});

test('totals market is calibrated at the source and probs sum to 100', () => {
  // projectedTotal well above the line -> raw over prob is high/overconfident.
  // With a trained totals map, applyTotalRunMarket must pull the favored side
  // toward observed frequency and keep over+under = 100.
  const totalRuns = {
    projectedTotal: 9.5,
    over: { '8.5': 72 },
    under: { '8.5': 28 }
  };
  const result = applyTotalRunMarket(totalRuns, 8.5, 50);
  assert.ok(result, 'expected a market result');
  const sum = result.overMarketProbability + result.underMarketProbability;
  assert.ok(Math.abs(sum - 100) < 0.6, `over+under should sum to ~100, got ${sum}`);
  if (hasCalibrationMap('totals')) {
    // The favored (over) side was overconfident at 72; calibration pulls it down.
    assert.ok(
      result.overMarketProbability < 72,
      `expected calibrated over < raw 72, got ${result.overMarketProbability}`
    );
    assert.ok(
      result.overMarketProbability > 50,
      `over should remain the favorite, got ${result.overMarketProbability}`
    );
  }
});

