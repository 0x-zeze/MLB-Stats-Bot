#!/usr/bin/env node
/**
 * Apply or inspect ordered SQLite schema migrations.
 *
 * Usage:
 *   node scripts/run_migrations.js --status
 *   node scripts/run_migrations.js --dry-run
 *   node scripts/run_migrations.js --apply
 *   node scripts/run_migrations.js --db /path/to/state.sqlite --status
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { applyMigrations, migrationStatus } from '../src/storage/migrations.js';

function parseArgs(argv) {
  const args = {
    db: resolve(process.cwd(), 'data', 'state.sqlite'),
    status: false,
    dryRun: false,
    apply: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--db' && argv[i + 1]) args.db = resolve(argv[++i]);
    else if (token === '--status') args.status = true;
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--apply') args.apply = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  if (!args.status && !args.dryRun && !args.apply) args.status = true;
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/run_migrations.js [--db PATH] [--status|--dry-run|--apply]\n'
    );
    process.exit(0);
  }

  const db = new Database(args.db);
  try {
    db.pragma('foreign_keys = ON');
    if (args.apply) {
      const result = applyMigrations(db, { dryRun: false });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const result = migrationStatus(db);
      if (args.dryRun) result.dryRun = true;
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } finally {
    db.close();
  }
}

main();
