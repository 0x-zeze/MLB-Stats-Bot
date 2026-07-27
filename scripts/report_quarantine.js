#!/usr/bin/env node
/**
 * Read-only legacy ledger quarantine report.
 *
 * Ambiguous historical rows are reported, never guessed or mutated. This is
 * intentionally separate from migration so operators can inspect before an
 * import. Use --json for machine-readable output.
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_DB = resolve(process.cwd(), 'data', 'state.sqlite');

function parseArgs(argv) {
  const args = { db: DEFAULT_DB, json: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db' && argv[i + 1]) args.db = resolve(argv[++i]);
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--out' && argv[i + 1]) args.out = resolve(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function json(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function buildReport(dbPath) {
  if (!existsSync(dbPath)) {
    return { status: 'error', reason: `database not found: ${dbPath}` };
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const issues = [];
    const counts = {};
    const rows = db
      .prepare(
        `SELECT b.*, p.payload AS pick_payload, p.post_game_processed
         FROM bet_ledger b
         LEFT JOIN picks p ON p.game_pk = b.game_pk
         ORDER BY b.date_ymd, b.decision_id`
      )
      .all();

    for (const row of rows) {
      const payload = json(row.pick_payload);
      const valuePick = payload.valuePick || {};
      const reasons = [];
      if (!row.date_ymd) reasons.push('missing_date_ymd');
      if (!row.recommended_at) reasons.push('missing_recommended_at');
      if (!row.selected_team_id && row.market === 'moneyline') reasons.push('missing_selected_team_id');
      if (!row.bookmaker && row.market === 'moneyline') reasons.push('missing_bookmaker');
      if (!row.quote_id && row.market === 'moneyline') reasons.push('missing_quote_id');
      if (!row.model_version || !row.calibration_version) reasons.push('missing_version_identity');
      if (row.status === 'open' && row.market === 'totals') reasons.push('open_totals_needs_settlement_review');
      if (row.post_game_processed === 1 && row.status === 'open') reasons.push('processed_but_open');
      if (
        row.market === 'moneyline' &&
        valuePick.side &&
        row.side &&
        String(valuePick.side) !== String(row.side)
      ) {
        reasons.push('ledger_payload_side_mismatch');
      }
      if (
        row.market === 'moneyline' &&
        payload.pick?.name &&
        valuePick.teamName &&
        String(payload.pick.name).toLowerCase() !== String(valuePick.teamName).toLowerCase()
      ) {
        reasons.push('display_pick_value_team_divergence');
      }
      if (row.market === 'moneyline' && row.clv == null && row.status === 'settled') {
        reasons.push('missing_clv');
      }
      if (reasons.length === 0) continue;
      for (const reason of reasons) counts[reason] = (counts[reason] || 0) + 1;
      issues.push({
        decisionId: row.decision_id,
        gamePk: row.game_pk,
        dateYmd: row.date_ymd || null,
        market: row.market,
        status: row.status,
        reasons,
        ledgerSide: row.side || null,
        ledgerTeam: row.team || null,
        payloadValueSide: valuePick.side || null,
        payloadValueTeam: valuePick.teamName || null,
        displayPick: payload.pick?.name || null,
        recommendedAt: row.recommended_at || null
      });
    }

    return {
      status: 'ok',
      mode: 'read_only',
      generatedAt: new Date().toISOString(),
      database: dbPath,
      totalLedgerRows: rows.length,
      quarantineRows: issues.length,
      reasonCounts: counts,
      issues,
      policy:
        'No row is changed or deleted. Quarantine rows are excluded from leakage-sensitive evaluation until provenance is recovered.'
    };
  } finally {
    db.close();
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node scripts/report_quarantine.js [--db PATH] [--json] [--out PATH]\n');
    return;
  }
  const report = buildReport(args.db);
  const text = args.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : [
        '=== Legacy ledger quarantine report (read-only) ===',
        `database: ${report.database || args.db}`,
        `total rows: ${report.totalLedgerRows ?? 'n/a'}`,
        `quarantine rows: ${report.quarantineRows ?? 'n/a'}`,
        `reason counts: ${JSON.stringify(report.reasonCounts || {})}`,
        'status: no rows changed'
      ].join('\n') + '\n';
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(text);
  process.exit(report.status === 'ok' ? 0 : 1);
}

main();
