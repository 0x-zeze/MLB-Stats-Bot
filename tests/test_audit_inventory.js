import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = resolve(ROOT, 'scripts', 'run_technical_audit.js');

function buildFixtureDb(path) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE picks (
      game_pk TEXT PRIMARY KEY,
      date_ymd TEXT NOT NULL,
      status TEXT,
      matchup TEXT,
      away_team_id TEXT,
      home_team_id TEXT,
      pick_team_id TEXT,
      pick_confidence TEXT,
      pick_source TEXT,
      post_game_processed INTEGER NOT NULL DEFAULT 0,
      post_game_processed_at TEXT,
      saved_at TEXT,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE bet_ledger (
      decision_id TEXT PRIMARY KEY,
      game_pk TEXT NOT NULL,
      date_ymd TEXT NOT NULL,
      market TEXT NOT NULL,
      team TEXT,
      side TEXT,
      line REAL,
      odds REAL,
      fair_prob REAL,
      model_prob REAL,
      edge REAL,
      units_staked REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      result TEXT,
      units_pl REAL,
      clv REAL,
      recommended_at TEXT NOT NULL,
      settled_at TEXT,
      UNIQUE(game_pk, market)
    );
  `);

  const payload = JSON.stringify({
    pick: { name: 'Display Team', id: '1' },
    valuePick: { side: 'home', teamName: 'Value Team' },
    startTime: '2026-07-01T17:00:00Z'
  });

  db.prepare(
    `INSERT INTO picks (
      game_pk, date_ymd, status, matchup, away_team_id, home_team_id,
      pick_team_id, pick_confidence, pick_source, post_game_processed,
      post_game_processed_at, saved_at, payload, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'g1',
    '2026-07-01',
    'Final',
    'Away @ Home',
    '2',
    '1',
    '1',
    'model',
    'baseline-model',
    1,
    '2026-07-01T20:00:00Z',
    '2026-07-01T12:00:00Z',
    payload,
    '2026-07-01T20:00:00Z'
  );

  db.prepare(
    `INSERT INTO bet_ledger (
      decision_id, game_pk, date_ymd, market, team, side, odds,
      fair_prob, model_prob, edge, units_staked, status, recommended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(
    '2026-07-01-moneyline-g1',
    'g1',
    '2026-07-01',
    'moneyline',
    'Value Team',
    'away',
    -110,
    0.5,
    0.55,
    0.05,
    1.0,
    '2026-07-01T12:00:00Z'
  );

  db.close();
}

test('run_technical_audit.js reports ledger defects on fixture db without writing production', () => {
  assert.equal(existsSync(SCRIPT), true, 'audit script must exist');

  const dir = mkdtempSync(join(tmpdir(), 'mlb-audit-'));
  const dbPath = join(dir, 'fixture.sqlite');
  const outPath = join(dir, 'audit.json');
  try {
    buildFixtureDb(dbPath);
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--db', dbPath, '--json', '--write', '--out', outPath],
      { encoding: 'utf8', cwd: ROOT }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(outPath), true);

    const body = result.stdout?.trim()
      ? JSON.parse(result.stdout)
      : JSON.parse(readFileSync(outPath, 'utf8'));

    assert.equal(body.status, 'ok');
    assert.equal(body.mode, 'read_only');
    assert.equal(body.ledger.openCount, 1);
    assert.equal(body.ledger.processedButOpenCount, 1);
    assert.equal(body.ledger.sideMismatchCount, 1);
    assert.equal(body.ledger.pickVsValueDivergenceCount, 1);
    assert.ok(body.risks.some((r) => r.id === 'P0-non-atomic-settlement'));
    assert.ok(body.risks.some((r) => r.id === 'P0-side-payload-mismatch'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
