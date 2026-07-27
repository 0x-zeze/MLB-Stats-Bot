import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'report_quarantine.js');

test('quarantine report is read-only and identifies ambiguous rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlb-quarantine-'));
  const dbPath = join(dir, 'state.sqlite');
  try {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE picks (
        game_pk TEXT PRIMARY KEY,
        payload TEXT,
        post_game_processed INTEGER DEFAULT 0
      );
      CREATE TABLE bet_ledger (
        decision_id TEXT PRIMARY KEY,
        game_pk TEXT,
        date_ymd TEXT,
        market TEXT,
        team TEXT,
        side TEXT,
        odds REAL,
        model_prob REAL,
        status TEXT,
        clv REAL,
        recommended_at TEXT,
        selected_team_id TEXT,
        bookmaker TEXT,
        quote_id TEXT,
        model_version TEXT,
        calibration_version TEXT
      );
    `);
    db.prepare('INSERT INTO picks VALUES (?, ?, ?)').run(
      'g1',
      JSON.stringify({
        pick: { name: 'Display' },
        valuePick: { side: 'home', teamName: 'Value' }
      }),
      1
    );
    db.prepare(
      'INSERT INTO bet_ledger (decision_id, game_pk, date_ymd, market, team, side, odds, model_prob, status, recommended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('d1', 'g1', '', 'moneyline', 'Value', 'away', -110, 0.55, 'open', '');
    db.close();

    const before = new Database(dbPath, { readonly: true }).prepare('SELECT COUNT(*) AS c FROM bet_ledger').get().c;
    const result = spawnSync(process.execPath, [SCRIPT, '--db', dbPath, '--json'], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'read_only');
    assert.equal(report.quarantineRows, 1);
    assert.ok(report.reasonCounts.missing_date_ymd >= 1);
    assert.ok(report.reasonCounts.processed_but_open >= 1);
    assert.ok(report.reasonCounts.ledger_payload_side_mismatch >= 1);
    const afterDb = new Database(dbPath, { readonly: true });
    const after = afterDb.prepare('SELECT COUNT(*) AS c FROM bet_ledger').get().c;
    afterDb.close();
    assert.equal(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
