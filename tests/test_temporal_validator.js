import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TemporalLeakageError,
  validateTemporalSnapshot,
  classifyFeatureProvenance,
  TEMPORAL_CODES
} from '../src/data/temporal_validator.js';

const PRED_TS = '2026-05-10T18:00:00.000Z';

test('a feature available after the prediction timestamp is rejected', () => {
  const feature = { value: 1.5, observedAt: '2026-05-15T00:00:00Z', availableAt: '2026-05-15T00:00:00Z' };
  const result = classifyFeatureProvenance(feature, PRED_TS);
  assert.equal(result.code, TEMPORAL_CODES.FUTURE_FEATURE);
  assert.equal(result.liveSafe, false);
});

test('a May 10 prediction cannot use a May 15 pitcher start', () => {
  const snapshot = {
    predictionTimestampUtc: PRED_TS,
    features: {
      pitcherRecentStart: {
        value: { era: '3.10' },
        observedAt: '2026-05-15T00:00:00Z',
        availableAt: '2026-05-15T00:00:00Z'
      }
    }
  };
  const report = validateTemporalSnapshot(snapshot);
  assert.equal(report.ok, false);
  assert.equal(report.promotionEligible, false);
  assert.ok(report.errors.some((e) => e.code === TEMPORAL_CODES.FUTURE_FEATURE));
});

test('strict mode throws TemporalLeakageError on future feature', () => {
  const snapshot = {
    predictionTimestampUtc: PRED_TS,
    features: {
      closingOdds: { value: -150, availableAt: '2026-05-10T23:30:00Z' } // after 18:00 prediction
    }
  };
  assert.throws(
    () => validateTemporalSnapshot(snapshot, null, { strict: true }),
    (err) => err instanceof TemporalLeakageError && err.code === TEMPORAL_CODES.FUTURE_FEATURE
  );
});

test('an early prediction cannot use closing odds', () => {
  const snapshot = {
    predictionTimestampUtc: '2026-05-10T12:00:00.000Z',
    firstPitchUtc: '2026-05-10T23:05:00.000Z',
    features: {
      closingLine: { value: -140, availableAt: '2026-05-10T22:58:00Z' }
    }
  };
  const report = validateTemporalSnapshot(snapshot);
  assert.equal(report.promotionEligible, false);
});

test('verified pregame feature is promotion-safe', () => {
  const feature = { value: 0.72, observedAt: '2026-05-09T03:00:00Z', availableAt: '2026-05-09T12:00:00Z' };
  const result = classifyFeatureProvenance(feature, PRED_TS);
  assert.equal(result.code, null);
  assert.equal(result.promotionSafe, true);
});

test('boxscore lineup without a pregame availability timestamp is historical_unverified', () => {
  // Only an observedAt at game time — no proof it was available pre-game.
  const feature = { value: { battingOrder: [] }, observedAt: '2026-05-10T19:00:00Z' };
  const result = classifyFeatureProvenance(feature, '2026-05-10T23:30:00.000Z');
  assert.equal(result.code, TEMPORAL_CODES.UNVERIFIED_HISTORICAL);
  assert.equal(result.liveSafe, true);
  assert.equal(result.promotionSafe, false);
});

test('missing timestamp is not fresh and not promotion-safe', () => {
  const result = classifyFeatureProvenance({ value: 42 }, PRED_TS);
  assert.equal(result.code, TEMPORAL_CODES.MISSING_TIMESTAMP);
  assert.equal(result.liveSafe, false);
});

test('inferred timestamp is live-safe but never promotion-safe', () => {
  const feature = { value: 1, observedAt: '2026-05-09T00:00:00Z', inferred: true };
  const result = classifyFeatureProvenance(feature, PRED_TS);
  assert.equal(result.code, TEMPORAL_CODES.INFERRED_TIMESTAMP);
  assert.equal(result.liveSafe, true);
  assert.equal(result.promotionSafe, false);
});

test('prediction timestamp after first pitch is flagged', () => {
  const snapshot = {
    predictionTimestampUtc: '2026-05-10T23:30:00.000Z',
    firstPitchUtc: '2026-05-10T23:05:00.000Z',
    features: {}
  };
  const report = validateTemporalSnapshot(snapshot);
  assert.ok(report.issues.some((i) => i.code === TEMPORAL_CODES.AS_OF_AFTER_FIRST_PITCH));
});

test('missing prediction timestamp yields missing_as_of issue', () => {
  const report = validateTemporalSnapshot({ features: {} }, null);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.code === TEMPORAL_CODES.MISSING_AS_OF));
});
