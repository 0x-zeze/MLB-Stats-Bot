import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseOddsApiKeys,
  resetOddsApiKeyPool,
  configureLineMonitor,
  __setOddsFetchForTest,
  __resetOddsCacheForTest,
  __fetchOddsForTest
} from '../src/lineMovement.js';

function clearEnv() {
  delete process.env.ODDS_API_KEY;
  delete process.env.THE_ODDS_API_KEY;
  delete process.env.ODDS_API_KEYS;
  configureLineMonitor({ config: {} });
  resetOddsApiKeyPool();
  __resetOddsCacheForTest();
  __setOddsFetchForTest(null);
}

// Build a fake fetch that responds based on the apiKey query param.
// `behavior` maps key -> 'quota' | 'ok' | 'rate_limit'.
function fakeFetchByKey(behavior, calls) {
  return async (url) => {
    const key = new URL(url).searchParams.get('apiKey');
    if (calls) calls.push(key);
    const mode = behavior[key];
    if (mode === 'quota') {
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => JSON.stringify({ error_code: 'OUT_OF_USAGE_CREDITS' })
      };
    }
    if (mode === 'rate_limit') {
      return { ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'rate limited' };
    }
    return { ok: true, status: 200, json: async () => [{ id: `evt-${key}` }] };
  };
}

test('parseOddsApiKeys merges all sources, de-dupes, preserves order', () => {
  clearEnv();
  process.env.ODDS_API_KEY = 'a';
  process.env.THE_ODDS_API_KEY = 'b';
  process.env.ODDS_API_KEYS = 'c,d , a'; // a is a dup, whitespace trimmed
  assert.deepEqual(parseOddsApiKeys(), ['a', 'b', 'c', 'd']);
  clearEnv();
});

test('parseOddsApiKeys splits a comma-separated single var', () => {
  clearEnv();
  process.env.ODDS_API_KEYS = 'k1,k2,k3';
  assert.deepEqual(parseOddsApiKeys(), ['k1', 'k2', 'k3']);
  clearEnv();
});

test('parseOddsApiKeys returns empty when nothing configured', () => {
  clearEnv();
  assert.deepEqual(parseOddsApiKeys(), []);
});

test('config-provided key (possibly comma-separated) is included first', () => {
  clearEnv();
  configureLineMonitor({ config: { lineMonitor: { oddsApiKey: 'cfg1,cfg2' } } });
  process.env.ODDS_API_KEYS = 'envk';
  assert.deepEqual(parseOddsApiKeys(), ['cfg1', 'cfg2', 'envk']);
  clearEnv();
});

test('blank/whitespace entries are ignored', () => {
  clearEnv();
  process.env.ODDS_API_KEYS = ' , ,k1, ';
  assert.deepEqual(parseOddsApiKeys(), ['k1']);
  clearEnv();
});

test('rotation: first key quota-exhausted -> falls through to the next key', async () => {
  clearEnv();
  process.env.ODDS_API_KEYS = 'dead,good';
  const calls = [];
  __setOddsFetchForTest(fakeFetchByKey({ dead: 'quota', good: 'ok' }, calls));

  const data = await __fetchOddsForTest();
  assert.deepEqual(data, [{ id: 'evt-good' }]);
  assert.deepEqual(calls, ['dead', 'good']); // tried dead first, rotated to good

  // 'dead' is now in cooldown: next pass should skip straight to 'good'.
  __resetOddsCacheForTest();
  calls.length = 0;
  await __fetchOddsForTest();
  assert.deepEqual(calls, ['good']);
  clearEnv();
});

test('transient 429 does NOT exhaust the key (throws, key still available)', async () => {
  clearEnv();
  process.env.ODDS_API_KEYS = 'k1';
  __setOddsFetchForTest(fakeFetchByKey({ k1: 'rate_limit' }));

  await assert.rejects(() => __fetchOddsForTest(), /429/);
  // Key must remain available (not burned by a transient error).
  assert.deepEqual(parseOddsApiKeys(), ['k1']);
  clearEnv();
});

test('all keys exhausted -> returns empty (no throw) and keeps last cache', async () => {
  clearEnv();
  process.env.ODDS_API_KEYS = 'a,b';
  __setOddsFetchForTest(fakeFetchByKey({ a: 'quota', b: 'quota' }));
  const data = await __fetchOddsForTest();
  assert.deepEqual(data, []);
  clearEnv();
});

