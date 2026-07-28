#!/usr/bin/env node
/**
 * Read-only ledger invariant validator.
 *
 * Usage:
 *   node scripts/validate_ledger.js [--db path/to/state.sqlite]
 *
 * Returns non-zero when actionable ledger inconsistencies exist. Historical
 * quarantined rows are reported; this command never rewrites or settles data.
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';

function parseArgs(argv) {
  const args = { db: resolve(process.cwd(), 'data', 'state.sqlite') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db' && argv[i + 1]) args.db = resolve(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function usage() {
  return 'Usage: node scripts/validate_ledger.js [--db PATH]';
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const db = new Database(args.db, { readonly: true });
  try {
    if (!tableExists(db, 'bet_ledger')) {
      process.stderr.write('bet_ledger table is missing\n');
      return 2;
    }

    const issues = [];
    const checks = {
      openProcessed: db.prepare(`
        SELECT COUNT(*) AS c
        FROM bet_ledger b JOIN picks p ON p.game_pk = b.game_pk
        WHERE b.status = 'open' AND p.post_game_processed = 1
      `).get().c,
      missingDate: db.prepare("SELECT COUNT(*) AS c FROM bet_ledger WHERE date_ymd IS NULL OR date_ymd = ''").get().c,
      invalidStatus: db.prepare("SELECT COUNT(*) AS c FROM bet_ledger WHERE status NOT IN ('open', 'settled', 'void')").get().c,
      invalidStake: db.prepare("SELECT COUNT(*) AS c FROM bet_ledger WHERE units_staked IS NULL OR units_staked < 0").get().c,
      settledMissingPnl: db.prepare("SELECT COUNT(*) AS c FROM bet_ledger WHERE status = 'settled' AND units_pl IS NULL").get().c,
      duplicateDecisionHash: db.prepare(`
        SELECT COUNT(*) AS c FROM (
          SELECT decision_hash FROM bet_ledger
          WHERE decision_hash IS NOT NULL AND decision_hash <> ''
          GROUP BY decision_hash HAVING COUNT(*) > 1
        )
      `).get().c
    };

    for (const [name, count] of Object.entries(checks)) {
      if (Number(count) > 0) issues.push({ check: name, count: Number(count) });
    }

    const report = {
      status: issues.length === 0 ? 'ok' : 'invalid',
      db: args.db,
      checks,
      issues,
      policy: 'read_only; no historical rows are rewritten'
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return issues.length === 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

process.exitCode = main();
