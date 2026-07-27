import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachCalibrationIdentity,
  calibrateProbability,
  getCalibrationArtifact,
  hasCalibrationMap,
  resetCalibrationCache
} from '../src/calibration.js';

test('calibration artifact has stable identity and explicit mode', () => {
  resetCalibrationCache();
  const artifact = getCalibrationArtifact('moneyline');
  assert.equal(artifact.market, 'moneyline');
  assert.match(artifact.calibrationVersion, /^cal-moneyline-/);
  assert.equal(typeof artifact.artifactHash, 'string');
  assert.ok(artifact.artifactHash.length >= 12);
  assert.ok(['map', 'map_low_sample_shrink', 'shrink_toward_50', 'identity'].includes(artifact.mode));
  assert.equal(artifact.mapPresent, hasCalibrationMap('moneyline'));
});

test('calibration identity can be attached to prediction versions', () => {
  resetCalibrationCache();
  const prediction = { gamePk: 1 };
  const result = attachCalibrationIdentity(prediction, 'moneyline');
  assert.equal(result, prediction);
  assert.equal(result.calibrationVersion, result.versions.calibration);
  assert.equal(result.calibrationArtifact.market, 'moneyline');
});

test('artifact identity remains deterministic after cache reset', () => {
  resetCalibrationCache();
  const before = getCalibrationArtifact('moneyline');
  resetCalibrationCache();
  const after = getCalibrationArtifact('moneyline');
  assert.equal(before.artifactHash, after.artifactHash);
  assert.equal(calibrateProbability(0.65, 'moneyline'), calibrateProbability(0.65, 'moneyline'));
});
