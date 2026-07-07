import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { Storage } from '../src/storage.js';
import { formatLedgerReport } from '../src/ledgerReport.js';

function team(id, name, abbreviation) {
  return { id, name, abbreviation };
}

// A VALUE bet prediction: pick side carries a positive Kelly stake.
function valuePrediction(gamePk, dateYmd, away, home, side, { odds, stake, model, fair }) {
  const pickTeam = side === 'away' ? away : home;
  return {
    gamePk,
    dateYmd,
    status: 'Scheduled',
    matchup: `${away.name} @ ${home.name}`,
    away: { ...away, winProbability: side === 'away' ? model : 100 - model },
    home: { ...home, winProbability: side === 'home' ? model : 100 - model },
    winner: { ...pickTeam, winProbability: model },
    pick: { ...pickTeam, winProbability: model, confidence: 'model' },
    valuePick: {
      side,
      teamId: pickTeam.id,
      teamName: pickTeam.name,
      odds,
      modelProbability: model,
      fairProbability: fair,
      edge: Math.round((model - fair) * 10) / 10,
      kellyStakePercent: stake
    },
    betDecision: { status: 'VALUE', teamName: pickTeam.name, odds, edge: model - fair }
  };
}

function gameResult(gamePk, away, home, awayScore, homeScore) {
  const winner = awayScore > homeScore ? away : home;
  return { gamePk, away: { ...away, score: awayScore }, home: { ...home, score: homeScore }, winner };
}

function freshStorage() {
  const tempDir = resolve(process.cwd(), '.tmp-ledger-tests');
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(tempDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return { storage: new Storage(statePath), tempDir };
}

test('recordBet logs a VALUE bet and settleBet pays a win in units', () => {
  const { storage } = freshStorage();
  const ari = team(1, 'Arizona', 'ARI');
  const cin = team(2, 'Cincinnati', 'CIN');
  // model 58% on ARI @ +160, quarter-Kelly stake 2.7u
  const pred = valuePrediction(10, '2026-06-12', ari, cin, 'away', { odds: 160, stake: 2.7, model: 58, fair: 51.2 });

  storage.savePredictions('2026-06-12', [pred]);
  const id = storage.recordBet(pred);
  assert.equal(id, '2026-06-12-moneyline-10');

  let rows = storage.readLedger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].units_staked, 2.7);

  // ARI wins → +160 pays 1.6x stake → +4.32u
  storage.settleBet(pred, gameResult(10, ari, cin, 7, 3), 1.5);
  rows = storage.readLedger();
  assert.equal(rows[0].status, 'settled');
  assert.equal(rows[0].result, 'win');
  assert.equal(rows[0].units_pl, 4.32);
  assert.equal(rows[0].clv, 1.5);
});

test('settleBet pays a loss as negative stake and a push as zero', () => {
  const { storage } = freshStorage();
  const a = team(1, 'Aces', 'ACE');
  const b = team(2, 'Bats', 'BAT');

  const loser = valuePrediction(20, '2026-06-12', a, b, 'away', { odds: 160, stake: 2.7, model: 58, fair: 51.2 });
  storage.savePredictions('2026-06-12', [loser]);
  storage.recordBet(loser);
  storage.settleBet(loser, gameResult(20, a, b, 2, 5), null); // away loses
  assert.equal(storage.readLedger()[0].units_pl, -2.7);

  const pushPred = valuePrediction(21, '2026-06-12', a, b, 'home', { odds: -110, stake: 2.0, model: 56, fair: 50 });
  storage.savePredictions('2026-06-12', [pushPred]);
  storage.recordBet(pushPred);
  // winner null → push
  storage.settleBet(pushPred, { gamePk: 21, away: a, home: b, winner: null }, null);
  const pushRow = storage.readLedger().find((r) => r.game_pk === '21');
  assert.equal(pushRow.result, 'push');
  assert.equal(pushRow.units_pl, 0);
});

test('recordBet is idempotent and settleBet does not double-count', () => {
  const { storage } = freshStorage();
  const a = team(1, 'Aces', 'ACE');
  const b = team(2, 'Bats', 'BAT');
  const pred = valuePrediction(30, '2026-06-12', a, b, 'away', { odds: 160, stake: 2.7, model: 58, fair: 51.2 });

  storage.savePredictions('2026-06-12', [pred]);
  const id1 = storage.recordBet(pred);
  const id2 = storage.recordBet(pred); // re-run /picks
  assert.equal(id1, '2026-06-12-moneyline-30');
  assert.equal(id2, null); // no duplicate
  assert.equal(storage.readLedger().length, 1);

  storage.settleBet(pred, gameResult(30, a, b, 7, 3), null);
  const plAfterFirst = storage.readLedger()[0].units_pl;
  storage.settleBet(pred, gameResult(30, a, b, 7, 3), null); // retry
  assert.equal(storage.readLedger()[0].units_pl, plAfterFirst); // unchanged
});

test('recordBet skips NO BET and zero-stake picks', () => {
  const { storage } = freshStorage();
  const a = team(1, 'Aces', 'ACE');
  const b = team(2, 'Bats', 'BAT');
  const noBet = valuePrediction(40, '2026-06-12', a, b, 'away', { odds: 160, stake: 2.7, model: 58, fair: 51.2 });
  noBet.betDecision.status = 'NO BET';
  storage.savePredictions('2026-06-12', [noBet]);
  assert.equal(storage.recordBet(noBet), null);
  assert.equal(storage.readLedger().length, 0);
});

test('decision_id is unique per game for same-day same-market bets', () => {
  const { storage } = freshStorage();
  const a = team(1, 'Aces', 'ACE');
  const b = team(2, 'Bats', 'BAT');
  const c = team(3, 'Cats', 'CAT');
  const d = team(4, 'Dogs', 'DOG');
  const p1 = valuePrediction(50, '2026-06-12', a, b, 'away', { odds: 150, stake: 2, model: 57, fair: 51 });
  const p2 = valuePrediction(51, '2026-06-12', c, d, 'home', { odds: 120, stake: 1.5, model: 55, fair: 50 });
  storage.savePredictions('2026-06-12', [p1, p2]);
  assert.equal(storage.recordBet(p1), '2026-06-12-moneyline-50');
  assert.equal(storage.recordBet(p2), '2026-06-12-moneyline-51');
});

test('formatLedgerReport renders open, settled record, and ROI', () => {
  const rows = [
    { status: 'open', team: 'Phillies', odds: 210, edge: 8.5, units_staked: 2.9, date_ymd: '2026-06-12', market: 'moneyline' },
    { status: 'settled', team: 'Angels', odds: 147, edge: 7.4, units_staked: 2.7, units_pl: 3.97, result: 'win', market: 'moneyline' },
    { status: 'settled', team: 'Reds', odds: -110, edge: 3, units_staked: 2.0, units_pl: -2.0, result: 'loss', market: 'moneyline' }
  ];
  const out = formatLedgerReport(rows);
  assert.match(out, /Open \(1\)/);
  assert.match(out, /Phillies \+210/);
  assert.match(out, /Settled \(2\)/);
  assert.match(out, /Record \| 1-1/);
  // staked 4.7u, P/L +1.97u → ROI +41.9%
  assert.match(out, /Units staked \| 4\.70u/);
  assert.match(out, /Units P\/L \| \+1\.97u/);
  assert.match(out, /ROI \| \+41\.9%/);
});

test('formatLedgerReport handles empty ledger', () => {
  const out = formatLedgerReport([]);
  assert.match(out, /Belum ada VALUE bet/);
});

// totals helper functions removed — totals market retiredtest.skip('recordTotalsBet logs an over bet and settleTotalsBet pays an over win', () => {});

test.skip('settleTotalsBet grades under win, over loss, and exact-line push', () => {});

test.skip('moneyline and totals bets coexist for the same game', () => {});

test.skip('recordTotalsBet skips NO BET and is idempotent', () => {});

test.after(() => {
  rmSync(resolve(process.cwd(), '.tmp-ledger-tests'), { recursive: true, force: true });
});
