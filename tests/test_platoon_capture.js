import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { Storage } from '../src/storage.js';
import { buildPlatoonPayload, capturePlatoonForGame } from '../src/platoonCapture.js';

function freshStorage() {
  const tempDir = resolve(process.cwd(), '.tmp-storage-tests');
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(tempDir, `state-plat-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return new Storage(statePath);
}

// Boxscore with a full 9-hitter lineup (battingOrder 100..900).
function boxscoreWithLineups() {
  const mk = (offset) => {
    const players = {};
    for (let i = 1; i <= 9; i++) {
      const id = offset + i;
      players[`ID${id}`] = { person: { id, fullName: `Player ${id}` }, battingOrder: String(i * 100) };
    }
    return { players };
  };
  return { teams: { away: mk(1000), home: mk(2000) } };
}

function game() {
  return {
    gamePk: 555,
    dateYmd: '2026-06-16',
    away: { name: 'Away', starter: { pitchHand: { code: 'R' } } },
    home: { name: 'Home', starter: { pitchHand: { code: 'L' } } }
  };
}

// Fake fetch: every hitter returns a fixed split for both vl and vr.
function fakeFetch() {
  return async () => ({
    ok: true,
    json: async () => ({
      stats: [{ splits: [
        { split: { code: 'vl' }, stat: { ops: '0.800', atBats: 100, obp: '0.340', slg: '0.460' } },
        { split: { code: 'vr' }, stat: { ops: '0.700', atBats: 200, obp: '0.310', slg: '0.390' } }
      ] }]
    })
  });
}

test('buildPlatoonPayload computes AB-weighted OPS', () => {
  const payload = buildPlatoonPayload('away', 'R', [
    { id: 1, name: 'A', slot: 1, ops: 0.9, atBats: 100 },
    { id: 2, name: 'B', slot: 2, ops: 0.7, atBats: 300 }
  ]);
  // (0.9*100 + 0.7*300) / 400 = 0.75
  assert.equal(payload.weightedOps, 0.75);
  assert.equal(payload.vsPitcherHand, 'R');
  assert.equal(payload.hittersCaptured, 2);
  assert.equal(payload.totalAtBats, 400);
});

test('buildPlatoonPayload tolerates missing stats', () => {
  const payload = buildPlatoonPayload('home', 'L', [
    { id: 1, name: 'A', slot: 1, ops: NaN, atBats: NaN }
  ]);
  assert.equal(payload.weightedOps, null);
  assert.equal(payload.hittersCaptured, 0);
});

test('capturePlatoonForGame writes a snapshot for both sides', async () => {
  const storage = freshStorage();
  const payload = await capturePlatoonForGame(game(), boxscoreWithLineups(), storage, {
    fetch: fakeFetch(),
    season: 2026
  });
  assert.ok(payload.away);
  assert.ok(payload.home);
  // Away faces home starter (L) -> vl split ops 0.800; home faces away starter (R) -> vr 0.700
  assert.equal(payload.away.weightedOps, 0.8);
  assert.equal(payload.home.weightedOps, 0.7);

  const stored = storage.getFeatureSnapshot('555', 'platoon');
  assert.equal(stored.payload.away.weightedOps, 0.8);
});

test('capturePlatoonForGame is write-once (does not re-capture)', async () => {
  const storage = freshStorage();
  await capturePlatoonForGame(game(), boxscoreWithLineups(), storage, { fetch: fakeFetch(), season: 2026 });
  const second = await capturePlatoonForGame(game(), boxscoreWithLineups(), storage, { fetch: fakeFetch(), season: 2026 });
  assert.equal(second, null);
});

test('capturePlatoonForGame skips when starter handedness unknown', async () => {
  const storage = freshStorage();
  const g = game();
  g.home.starter.pitchHand = {};
  g.away.starter.pitchHand = {};
  const payload = await capturePlatoonForGame(g, boxscoreWithLineups(), storage, { fetch: fakeFetch(), season: 2026 });
  assert.equal(payload, null);
});

test.after(() => {
  rmSync(resolve(process.cwd(), '.tmp-storage-tests'), { recursive: true, force: true });
});
