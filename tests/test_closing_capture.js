import test from 'node:test';
import assert from 'node:assert/strict';

import { isClosingCaptureEligible, shouldCaptureClosingNow } from '../src/index.js';

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

// --- credit-saving throttle ---
const OPTS = { minIntervalMs: 15 * 60_000, finalWindowMs: 40 * 60_000 };

test('throttle: no eligible games -> never fetch', () => {
  assert.equal(shouldCaptureClosingNow([], NOW, 0, OPTS), false);
});

test('throttle: game near first pitch (within final window) always fetches', () => {
  const near = [pred(new Date(NOW + 20 * 60_000).toISOString())]; // 20 min out
  // Even if we JUST fetched (lastCaptureAt = now), the final window forces it.
  assert.equal(shouldCaptureClosingNow(near, NOW, NOW, OPTS), true);
});

test('throttle: far game skips when within min interval, fetches after it elapses', () => {
  const far = [pred(new Date(NOW + 2 * 3600_000).toISOString())]; // 2h out
  // Fetched 5 min ago -> still inside 15-min interval -> skip.
  assert.equal(shouldCaptureClosingNow(far, NOW, NOW - 5 * 60_000, OPTS), false);
  // Fetched 16 min ago -> interval elapsed -> fetch.
  assert.equal(shouldCaptureClosingNow(far, NOW, NOW - 16 * 60_000, OPTS), true);
});

test('throttle: minIntervalMs=0 disables throttling (always fetch when eligible)', () => {
  const far = [pred(new Date(NOW + 2 * 3600_000).toISOString())];
  assert.equal(shouldCaptureClosingNow(far, NOW, NOW, { minIntervalMs: 0, finalWindowMs: 40 * 60_000 }), true);
});

