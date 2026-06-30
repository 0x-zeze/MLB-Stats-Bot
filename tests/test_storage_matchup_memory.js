import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { Storage } from '../src/storage.js';

function team(id, name, abbreviation) {
  return { id, name, abbreviation };
}

function prediction(gamePk, dateYmd, away, home, pick) {
  return {
    gamePk,
    dateYmd,
    status: 'Preview',
    matchup: `${away.name} @ ${home.name}`,
    away: { ...away, winProbability: pick.id === away.id ? 58 : 42 },
    home: { ...home, winProbability: pick.id === home.id ? 58 : 42 },
    winner: { ...pick, winProbability: 58 },
    pick: {
      ...pick,
      winProbability: 58,
      confidence: 'medium'
    },
    firstInning: {
      pick: 'NO',
      probability: 54
    }
  };
}

function result(gamePk, dateYmd, away, home, awayScore, homeScore) {
  const winner = awayScore > homeScore ? away : home;
  const loser = awayScore > homeScore ? home : away;

  return {
    gamePk,
    dateYmd,
    away: { ...away, score: awayScore },
    home: { ...home, score: homeScore },
    winner,
    loser,
    firstInning: {
      anyRun: false
    }
  };
}

test('recordOutcome stores matchup memory across reversed venues', () => {
  const tempDir = resolve(process.cwd(), '.tmp-storage-tests');
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(tempDir, `state-${Date.now()}.json`);
  const storage = new Storage(statePath);
  const alpha = team(100, 'Alpha Aces', 'AAA');
  const beta = team(200, 'Beta Bats', 'BBB');

  const pred1 = prediction(1, '2026-04-01', alpha, beta, beta);
  const pred2 = prediction(2, '2026-04-02', beta, alpha, alpha);
  storage.savePredictions('2026-04-01', [pred1]);
  storage.savePredictions('2026-04-02', [pred2]);

  storage.recordOutcome(
    pred1,
    result(1, '2026-04-01', alpha, beta, 2, 5)
  );
  storage.recordOutcome(
    pred2,
    result(2, '2026-04-02', beta, alpha, 6, 3)
  );

  try {
    const memory = storage.getMemory();
    const entry = memory.matchupMemory['100:200'];

    assert.equal(memory.totalPicks, 2);
    assert.equal(Object.keys(memory.matchupMemory).length, 1);
    assert.equal(entry.totalGames, 2);
    assert.equal(entry.recentGames.length, 2);
    assert.equal(entry.teamRecords['200'].wins, 2);
    assert.equal(entry.pickStats.total, 2);
    assert.equal(entry.pickStats.correct, 1);
    assert.equal(entry.currentStreak.winner.id, 200);
    assert.equal(entry.currentStreak.length, 2);
    assert.match(entry.note, /menang 2 pertemuan terakhir/);

    const summary = storage.getMemorySummary();
    assert.equal(summary.matchupMemory.totalMatchups, 1);
    assert.equal(summary.matchupMemory.recent[0].key, '100:200');
  } finally {
    storage.close();
    rmSync(statePath, { force: true });
    rmSync(storage.dbPath, { force: true });
    rmSync(`${storage.dbPath}-wal`, { force: true });
    rmSync(`${storage.dbPath}-shm`, { force: true });
  }
});

test('line snapshots persist last seen market values by game and market', () => {
  const tempDir = resolve(process.cwd(), '.tmp-storage-tests');
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(tempDir, `line-state-${Date.now()}.json`);
  const storage = new Storage(statePath);

  try {
    storage.setLineSnapshot(12345, 'moneyline_home', -130, '2026-04-30T10:00:00.000Z');
    assert.deepEqual(storage.getLineSnapshot(12345, 'moneyline_home'), {
      gamePk: '12345',
      market: 'moneyline_home',
      value: -130,
      timestamp: '2026-04-30T10:00:00.000Z'
    });

    storage.setLineSnapshot(12345, 'moneyline_home', -146, '2026-04-30T10:10:00.000Z');
    const updated = storage.getLineSnapshot(12345, 'moneyline_home');

    assert.equal(updated.value, -146);
    assert.equal(updated.timestamp, '2026-04-30T10:10:00.000Z');
    assert.equal(storage.getLineSnapshot(12345, 'total'), null);
  } finally {
    storage.close();
    rmSync(statePath, { force: true });
    rmSync(storage.dbPath, { force: true });
    rmSync(`${storage.dbPath}-wal`, { force: true });
    rmSync(`${storage.dbPath}-shm`, { force: true });
  }
});

test('opening odds freeze the first-seen line for CLV even as the live line moves', () => {
  const tempDir = resolve(process.cwd(), '.tmp-storage-tests');
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(tempDir, `opening-state-${Date.now()}.json`);
  const storage = new Storage(statePath);

  try {
    // First poll establishes the opening line.
    storage.setLineSnapshot(54321, 'moneyline_home', -150, '2026-04-30T09:00:00.000Z');
    storage.setLineSnapshot(54321, 'moneyline_away', 130, '2026-04-30T09:00:00.000Z');
    // Later polls move the live line; opening must NOT change.
    storage.setLineSnapshot(54321, 'moneyline_home', -185, '2026-04-30T11:00:00.000Z');
    storage.setLineSnapshot(54321, 'moneyline_away', 160, '2026-04-30T11:00:00.000Z');

    const opening = storage.openingOddsFromSnapshots(54321);
    assert.equal(opening.homeMoneyline, -150);
    assert.equal(opening.awayMoneyline, 130);
    // The live (last-seen) line reflects the move.
    assert.equal(storage.getLineSnapshot(54321, 'moneyline_home').value, -185);
    // No opening odds when no plausible snapshot exists.
    assert.equal(storage.openingOddsFromSnapshots(99999), null);
  } finally {
    storage.close();
    rmSync(statePath, { force: true });
    rmSync(storage.dbPath, { force: true });
    rmSync(`${storage.dbPath}-wal`, { force: true });
    rmSync(`${storage.dbPath}-shm`, { force: true });
  }
});

test('line alert reservations suppress duplicate movement alerts', () => {
  const tempDir = resolve(process.cwd(), '.tmp-storage-tests');
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(tempDir, `line-alert-state-${Date.now()}.json`);
  const storage = new Storage(statePath);
  const movement = {
    gamePk: '12345',
    storageMarket: 'total',
    market: 'total',
    previousValue: 6.5,
    currentValue: 7.0,
    bookmaker: 'FanDuel'
  };

  const now = new Date();
  const ts1 = now.toISOString();
  const ts2 = new Date(now.getTime() + 60_000).toISOString();
  const ts3 = new Date(now.getTime() + 120_000).toISOString();
  try {
    assert.equal(
      storage.reserveLineAlert(
        'line-move:chat:12345:total:FanDuel:6.500:7.000',
        movement,
        'chat',
        ts1
      ),
      true
    );
    assert.equal(
      storage.reserveLineAlert(
        'line-move:chat:12345:total:FanDuel:6.500:7.000',
        movement,
        'chat',
        ts2
      ),
      false
    );
    assert.equal(
      storage.reserveLineAlert(
        'line-move:chat:12345:total:FanDuel:7.000:7.500',
        { ...movement, previousValue: 7.0, currentValue: 7.5 },
        'chat',
        ts3
      ),
      true
    );
  } finally {
    storage.close();
    rmSync(statePath, { force: true });
    rmSync(storage.dbPath, { force: true });
    rmSync(`${storage.dbPath}-wal`, { force: true });
    rmSync(`${storage.dbPath}-shm`, { force: true });
  }
});

test('lineup alert reservations suppress duplicate both-confirmed alerts', () => {
  const tempDir = resolve(process.cwd(), '.tmp-storage-tests');
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(tempDir, `lineup-alert-state-${Date.now()}.json`);
  const storage = new Storage(statePath);

  try {
    assert.equal(storage.reserveLineupAlert('chat', 'game-1', '2026-06-30T10:00:00.000Z'), true);
    assert.equal(storage.reserveLineupAlert('chat', 'game-1', '2026-06-30T10:01:00.000Z'), false);
    assert.equal(storage.reserveLineupAlert('chat', 'game-2', '2026-06-30T10:02:00.000Z'), true);
    assert.equal(storage.reserveLineupAlert('other-chat', 'game-1', '2026-06-30T10:03:00.000Z'), true);
  } finally {
    storage.close();
    rmSync(statePath, { force: true });
    rmSync(storage.dbPath, { force: true });
    rmSync(`${storage.dbPath}-wal`, { force: true });
    rmSync(`${storage.dbPath}-shm`, { force: true });
  }
});

test('line movement alert preference persists per chat', () => {
  const tempDir = resolve(process.cwd(), '.tmp-storage-tests');
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(tempDir, `line-alert-pref-state-${Date.now()}.json`);
  const storage = new Storage(statePath);
  const chat = { id: 789, title: 'MLB Chat' };

  try {
    assert.equal(storage.getLineMovementAlerts(chat.id).enabled, true);

    storage.setLineMovementAlerts(chat, { enabled: false });
    assert.equal(storage.getLineMovementAlerts(chat.id).enabled, false);

    storage.setLineMovementAlerts(chat, { enabled: true });
    assert.equal(storage.getLineMovementAlerts(chat.id).enabled, true);

    const subscriber = storage.getSubscriber(chat.id);
    assert.equal(subscriber.lineMovementAlerts.enabled, true);
  } finally {
    storage.close();
    rmSync(statePath, { force: true });
    rmSync(storage.dbPath, { force: true });
    rmSync(`${storage.dbPath}-wal`, { force: true });
    rmSync(`${storage.dbPath}-shm`, { force: true });
  }
});
