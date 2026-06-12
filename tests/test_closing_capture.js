import test from 'node:test';
import assert from 'node:assert/strict';

import { isClosingCaptureEligible } from '../src/index.js';

const NOW = Date.parse('2026-06-12T18:00:00Z');
const WINDOW = 3 * 60 * 60 * 1000; // 3h, matches CLOSING_REFRESH_WINDOW_MS

function pred(startTime) {
  return { startTime };
}

test('a game 2h out is eligible for closing capture', () => {
  const p = pred(new Date(NOW + 2 * 3600_000).toISOString());
  assert.equal(isClosingCaptureEligible(p, NOW, WINDOW), true);
});

test('a game 4h out is excluded (outside window)', () => {
  const p = pred(new Date(NOW + 4 * 3600_000).toISOString());
  assert.equal(isClosingCaptureEligible(p, NOW, WINDOW), false);
});

test('a game that already started is excluded (hard guard)', () => {
  const p = pred(new Date(NOW - 60_000).toISOString());
  assert.equal(isClosingCaptureEligible(p, NOW, WINDOW), false);
});

test('a game starting exactly now is excluded (startMs > now is strict)', () => {
  const p = pred(new Date(NOW).toISOString());
  assert.equal(isClosingCaptureEligible(p, NOW, WINDOW), false);
});

test('eligibility is independent of whether a closing snapshot already exists', () => {
  // The predicate has no snapshot check — refresh-on-each-poll is the point.
  // A pre-game game is eligible regardless of prior capture state.
  const p = pred(new Date(NOW + 30 * 60_000).toISOString());
  assert.equal(isClosingCaptureEligible(p, NOW, WINDOW), true);
});

test('missing/garbage start time is excluded', () => {
  assert.equal(isClosingCaptureEligible({}, NOW, WINDOW), false);
  assert.equal(isClosingCaptureEligible(pred('not-a-date'), NOW, WINDOW), false);
  assert.equal(isClosingCaptureEligible(null, NOW, WINDOW), false);
});

test('falls back through startTime -> start -> gameTime', () => {
  const viaGameTime = { gameTime: new Date(NOW + 60 * 60_000).toISOString() };
  assert.equal(isClosingCaptureEligible(viaGameTime, NOW, WINDOW), true);
});
