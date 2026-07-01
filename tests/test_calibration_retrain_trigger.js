import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldTriggerCalibrationRetrain } from '../src/index.js';

test('calibration retrain triggers every 25 settled bets once per postgame run', () => {
  assert.equal(shouldTriggerCalibrationRetrain(0), false);
  assert.equal(shouldTriggerCalibrationRetrain(24), false);
  assert.equal(shouldTriggerCalibrationRetrain(25), true);
  assert.equal(shouldTriggerCalibrationRetrain(25, true), false);
  assert.equal(shouldTriggerCalibrationRetrain(50), true);
  assert.equal(shouldTriggerCalibrationRetrain(51), false);
});
