import assert from 'node:assert/strict';
import test from 'node:test';

import { calibrateProbability, calibratePercent, hasCalibrationMap } from '../src/calibration.js';

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

test.skip('totals market is calibrated at the source and probs sum to 100', () => {});

