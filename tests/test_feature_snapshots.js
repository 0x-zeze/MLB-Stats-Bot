import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { Storage } from '../src/storage.js';

function freshStorage() {
  const tempDir = resolve(process.cwd(), '.tmp-storage-tests');
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(tempDir, `state-feat-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return { storage: new Storage(statePath), tempDir };
}

test('feature snapshot writes once and reads back parsed JSON', () => {
  const { storage } = freshStorage();
  const ok = storage.setFeatureSnapshot('1', 'umpire', '2026-06-16', { name: 'Joe West', kPct: 0.23 });
  assert.equal(ok, true);

  const row = storage.getFeatureSnapshot('1', 'umpire');
  assert.equal(row.gamePk, '1');
  assert.equal(row.featureGroup, 'umpire');
  assert.equal(row.dateYmd, '2026-06-16');
  assert.deepEqual(row.payload, { name: 'Joe West', kPct: 0.23 });
});

test('write-once does not overwrite the first capture', () => {
  const { storage } = freshStorage();
  storage.setFeatureSnapshot('2', 'umpire', '2026-06-16', { name: 'First' });
  const second = storage.setFeatureSnapshot('2', 'umpire', '2026-06-16', { name: 'Second' });
  assert.equal(second, false); // ignored
  assert.equal(storage.getFeatureSnapshot('2', 'umpire').payload.name, 'First');
});

test('overwrite:true refreshes the snapshot (e.g. closing line)', () => {
  const { storage } = freshStorage();
  storage.setFeatureSnapshot('3', 'closing_line', '2026-06-16', { home: -110 });
  const updated = storage.setFeatureSnapshot('3', 'closing_line', '2026-06-16', { home: -125 }, { overwrite: true });
  assert.equal(updated, true);
  assert.equal(storage.getFeatureSnapshot('3', 'closing_line').payload.home, -125);
});

test('distinct feature groups coexist for the same game', () => {
  const { storage } = freshStorage();
  storage.setFeatureSnapshot('4', 'umpire', '2026-06-16', { name: 'Ump' });
  storage.setFeatureSnapshot('4', 'platoon', '2026-06-16', { awayVsR: 0.34 });
  assert.equal(storage.getFeatureSnapshot('4', 'umpire').payload.name, 'Ump');
  assert.equal(storage.getFeatureSnapshot('4', 'platoon').payload.awayVsR, 0.34);
});

test('listFeatureSnapshotsByDate filters by date and optional group', () => {
  const { storage } = freshStorage();
  storage.setFeatureSnapshot('5', 'umpire', '2026-06-16', { name: 'A' });
  storage.setFeatureSnapshot('6', 'umpire', '2026-06-16', { name: 'B' });
  storage.setFeatureSnapshot('7', 'umpire', '2026-06-17', { name: 'C' });

  const onDate = storage.listFeatureSnapshotsByDate('2026-06-16', 'umpire');
  assert.equal(onDate.length, 2);
  assert.deepEqual(onDate.map((r) => r.gamePk).sort(), ['5', '6']);

  const allGroups = storage.listFeatureSnapshotsByDate('2026-06-16');
  assert.equal(allGroups.length, 2);
});

test('missing snapshot returns null', () => {
  const { storage } = freshStorage();
  assert.equal(storage.getFeatureSnapshot('999', 'umpire'), null);
});

test.after(() => {
  rmSync(resolve(process.cwd(), '.tmp-storage-tests'), { recursive: true, force: true });
});
