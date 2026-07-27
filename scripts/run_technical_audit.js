#!/usr/bin/env node
/**
 * Read-only technical audit inventory for MLB Stats Bot.
 *
 * Reports schema, row counts, ledger integrity, side/payload mismatches,
 * provenance gaps, calibration artifact availability, and evolution writes.
 * Does NOT mutate production state. Optional --db PATH for a copied fixture.
 *
 * Usage:
 *   node scripts/run_technical_audit.js
 *   node scripts/run_technical_audit.js --db /path/to/copy.sqlite
 *   node scripts/run_technical_audit.js --json > reports/audit_inventory.json
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DEFAULT_DB = resolve(ROOT, 'data', 'state.sqlite');
const DATA_DIR = resolve(ROOT, 'data');

function parseArgs(argv) {
  const args = { db: DEFAULT_DB, json: false, write: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--db' && argv[i + 1]) {
      args.db = resolve(argv[++i]);
    } else if (token === '--json') {
      args.json = true;
    } else if (token === '--write') {
      args.write = true;
    } else if (token === '--out' && argv[i + 1]) {
      args.out = resolve(argv[++i]);
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    }
  }
  return args;
}

function safeJsonParse(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function fileInfo(path) {
  if (!existsSync(path)) {
    return { path, exists: false };
  }
  const st = statSync(path);
  let sha256 = null;
  try {
    if (st.isFile() && st.size <= 5_000_000) {
      sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  } catch {
    sha256 = null;
  }
  return {
    path,
    exists: true,
    sizeBytes: st.size,
    mtime: st.mtime.toISOString(),
    sha256
  };
}

function listDirSafe(path) {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function queryCount(db, sql, params = []) {
  try {
    return Number(db.prepare(sql).get(...params)?.c ?? 0);
  } catch {
    return null;
  }
}

function tableExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row);
}

function collectEnvironment() {
  let git = { head: null, branch: null, error: null };
  try {
    // Avoid shell: read .git when available is fragile; leave null if unavailable.
    const headPath = resolve(ROOT, '.git', 'HEAD');
    if (existsSync(headPath)) {
      const head = readFileSync(headPath, 'utf8').trim();
      if (head.startsWith('ref: ')) {
        git.branch = head.replace('ref: refs/heads/', '');
        const refPath = resolve(ROOT, '.git', head.slice(5));
        if (existsSync(refPath)) {
          git.head = readFileSync(refPath, 'utf8').trim();
        }
      } else {
        git.head = head;
      }
    }
  } catch (error) {
    git.error = error?.message || String(error);
  }

  return {
    cwd: ROOT,
    node: process.version,
    modulesAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
    git,
    collectedAt: new Date().toISOString()
  };
}

function collectSchema(db) {
  const tables = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all();
  const indexes = db
    .prepare(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all();

  const schema = {};
  for (const table of tables) {
    let columns = [];
    try {
      columns = db.prepare(`PRAGMA table_info(${table.name})`).all();
    } catch {
      columns = [];
    }
    schema[table.name] = {
      createSql: table.sql || null,
      columns: columns.map((c) => ({
        name: c.name,
        type: c.type,
        notnull: c.notnull === 1,
        pk: c.pk === 1,
        dflt_value: c.dflt_value
      })),
      rowCount: queryCount(db, `SELECT COUNT(*) AS c FROM ${table.name}`)
    };
  }

  return { tables: schema, indexes, tableNames: tables.map((t) => t.name) };
}

function collectLedger(db) {
  if (!tableExists(db, 'bet_ledger')) {
    return { available: false };
  }

  const byStatus = db
    .prepare('SELECT status, COUNT(*) AS c FROM bet_ledger GROUP BY status')
    .all();
  const byMarketStatus = db
    .prepare(
      'SELECT market, status, COUNT(*) AS c FROM bet_ledger GROUP BY market, status ORDER BY market, status'
    )
    .all();
  const bySide = db
    .prepare('SELECT side, COUNT(*) AS c FROM bet_ledger GROUP BY side')
    .all();
  const byResult = db
    .prepare(
      "SELECT result, COUNT(*) AS c FROM bet_ledger WHERE status = 'settled' GROUP BY result"
    )
    .all();

  const openRows = db
    .prepare(
      `SELECT decision_id, game_pk, date_ymd, market, team, side, odds, units_staked, recommended_at
       FROM bet_ledger WHERE status = 'open' ORDER BY date_ymd, decision_id`
    )
    .all();

  const moneylineSettled = db
    .prepare(
      `SELECT
         COUNT(*) AS settled,
         ROUND(SUM(units_staked), 4) AS total_staked,
         ROUND(SUM(units_pl), 4) AS total_pl,
         ROUND(AVG(clv), 4) AS avg_clv,
         SUM(CASE WHEN clv IS NOT NULL THEN 1 ELSE 0 END) AS clv_count
       FROM bet_ledger
       WHERE market = 'moneyline' AND status = 'settled'`
    )
    .get();

  const totalsSettled = db
    .prepare(
      `SELECT
         COUNT(*) AS settled,
         ROUND(SUM(units_staked), 4) AS total_staked,
         ROUND(SUM(units_pl), 4) AS total_pl
       FROM bet_ledger
       WHERE market = 'totals' AND status = 'settled'`
    )
    .get();

  const nullish = {
    nullSide: queryCount(db, 'SELECT COUNT(*) AS c FROM bet_ledger WHERE side IS NULL'),
    nullTeam: queryCount(db, 'SELECT COUNT(*) AS c FROM bet_ledger WHERE team IS NULL'),
    nullModelProb: queryCount(
      db,
      'SELECT COUNT(*) AS c FROM bet_ledger WHERE model_prob IS NULL'
    ),
    nullOdds: queryCount(db, 'SELECT COUNT(*) AS c FROM bet_ledger WHERE odds IS NULL'),
    emptyDateYmd: queryCount(
      db,
      "SELECT COUNT(*) AS c FROM bet_ledger WHERE date_ymd IS NULL OR date_ymd = ''"
    )
  };

  // Processed pick but open ledger (non-atomic settlement fingerprint).
  let processedOpen = [];
  if (tableExists(db, 'picks')) {
    processedOpen = db
      .prepare(
        `SELECT b.decision_id, b.game_pk, b.date_ymd, b.market, b.team, b.side, b.recommended_at,
                p.post_game_processed, p.post_game_processed_at
         FROM bet_ledger b
         JOIN picks p ON p.game_pk = b.game_pk
         WHERE b.status = 'open' AND p.post_game_processed = 1
         ORDER BY b.date_ymd, b.decision_id`
      )
      .all();
  }

  // Side/payload mismatches between immutable-ish ledger and mutable pick payload.
  let sideMismatches = [];
  let pickVsValueDivergences = [];
  if (tableExists(db, 'picks')) {
    const joined = db
      .prepare(
        `SELECT b.game_pk, b.date_ymd, b.market, b.side AS ledger_side, b.team AS ledger_team,
                b.result, b.units_pl, b.clv, b.status, p.payload
         FROM bet_ledger b
         JOIN picks p ON p.game_pk = b.game_pk
         WHERE b.market = 'moneyline'`
      )
      .all();

    for (const row of joined) {
      const payload = safeJsonParse(row.payload, {});
      const valueSide = payload?.valuePick?.side ?? null;
      const valueTeam = payload?.valuePick?.teamName ?? null;
      const pickName = payload?.pick?.name ?? null;
      const pickSource = payload?.pick?.source ?? null;

      if (valueSide && row.ledger_side && String(valueSide) !== String(row.ledger_side)) {
        sideMismatches.push({
          gamePk: row.game_pk,
          dateYmd: row.date_ymd,
          ledgerSide: row.ledger_side,
          ledgerTeam: row.ledger_team,
          payloadValueSide: valueSide,
          payloadValueTeam: valueTeam,
          pickName,
          result: row.result,
          unitsPl: row.units_pl,
          clv: row.clv,
          status: row.status
        });
      }

      if (
        pickName &&
        valueTeam &&
        String(pickName).toLowerCase() !== String(valueTeam).toLowerCase()
      ) {
        pickVsValueDivergences.push({
          gamePk: row.game_pk,
          dateYmd: row.date_ymd,
          ledgerSide: row.ledger_side,
          ledgerTeam: row.ledger_team,
          pickName,
          pickSource,
          valueTeam,
          valueSide,
          result: row.result,
          unitsPl: row.units_pl,
          clv: row.clv,
          status: row.status
        });
      }
    }
  }

  const stakeWeightedRoi =
    moneylineSettled?.total_staked > 0
      ? Number((moneylineSettled.total_pl / moneylineSettled.total_staked).toFixed(6))
      : null;
  // Incorrect legacy evaluator semantics (profit / bet count) for comparison only.
  const betCountRoi =
    moneylineSettled?.settled > 0
      ? Number((moneylineSettled.total_pl / moneylineSettled.settled).toFixed(6))
      : null;

  return {
    available: true,
    byStatus,
    byMarketStatus,
    bySide,
    byResult,
    openRows,
    openCount: openRows.length,
    processedButOpen: processedOpen,
    processedButOpenCount: processedOpen.length,
    nullish,
    moneylineSettled,
    totalsSettled,
    stakeWeightedRoi,
    betCountRoiNote: 'legacy_incorrect_roi_profit_over_bet_count',
    betCountRoi,
    sideMismatches,
    sideMismatchCount: sideMismatches.length,
    pickVsValueDivergences,
    pickVsValueDivergenceCount: pickVsValueDivergences.length
  };
}

function collectPicks(db) {
  if (!tableExists(db, 'picks')) return { available: false };

  const processed = db
    .prepare(
      'SELECT post_game_processed, COUNT(*) AS c FROM picks GROUP BY post_game_processed'
    )
    .all();
  const dateRange = db
    .prepare('SELECT MIN(date_ymd) AS min_date, MAX(date_ymd) AS max_date FROM picks')
    .get();
  const missingStart = queryCount(
    db,
    `SELECT COUNT(*) AS c FROM picks
     WHERE json_extract(payload, '$.startTime') IS NULL
        OR json_extract(payload, '$.startTime') = ''`
  );
  const missingPickId = queryCount(
    db,
    `SELECT COUNT(*) AS c FROM picks
     WHERE pick_team_id IS NULL OR pick_team_id = ''`
  );
  const pickSources = db
    .prepare(
      `SELECT COALESCE(pick_source, 'null') AS source, COUNT(*) AS c
       FROM picks GROUP BY pick_source ORDER BY c DESC`
    )
    .all();

  return {
    available: true,
    rowCount: queryCount(db, 'SELECT COUNT(*) AS c FROM picks'),
    processed,
    dateRange,
    missingStartTime: missingStart,
    missingPickTeamId: missingPickId,
    pickSources
  };
}

function collectSnapshots(db) {
  const line = tableExists(db, 'line_snapshots')
    ? {
        rowCount: queryCount(db, 'SELECT COUNT(*) AS c FROM line_snapshots'),
        byMarket: db
          .prepare(
            'SELECT market, COUNT(*) AS c FROM line_snapshots GROUP BY market ORDER BY c DESC'
          )
          .all()
      }
    : { available: false };

  const feature = tableExists(db, 'feature_snapshots')
    ? {
        rowCount: queryCount(db, 'SELECT COUNT(*) AS c FROM feature_snapshots'),
        byGroup: db
          .prepare(
            'SELECT feature_group, COUNT(*) AS c FROM feature_snapshots GROUP BY feature_group ORDER BY c DESC'
          )
          .all()
      }
    : { available: false };

  return { line_snapshots: line, feature_snapshots: feature };
}

function collectCalibrationArtifacts() {
  const files = [
    'calibration_maps.json',
    'calibration_map.json',
    'calibration_meta.json',
    'calibration_maps_new.json',
    'calibration_maps.json.bak.20260629',
    'calibration_maps.json.bak.pre_fix'
  ].map((name) => fileInfo(resolve(DATA_DIR, name)));

  let meta = null;
  const metaPath = resolve(DATA_DIR, 'calibration_meta.json');
  if (existsSync(metaPath)) {
    meta = safeJsonParse(readFileSync(metaPath, 'utf8'), null);
  }
  let maps = null;
  const mapsPath = resolve(DATA_DIR, 'calibration_maps.json');
  if (existsSync(mapsPath)) {
    maps = safeJsonParse(readFileSync(mapsPath, 'utf8'), null);
  }

  const markets = maps && typeof maps === 'object' ? Object.keys(maps) : [];
  const mapPointCounts = {};
  if (maps && typeof maps === 'object') {
    for (const [market, points] of Object.entries(maps)) {
      mapPointCounts[market] = Array.isArray(points) ? points.length : null;
    }
  }

  return {
    files,
    meta,
    marketsPresent: markets,
    mapPointCounts,
    runtimeMapsPresent: existsSync(mapsPath),
    metaClaimsSuccess: Boolean(
      meta?.markets &&
        Object.values(meta.markets).some((m) => m?.status === 'success')
    )
  };
}

function collectEvolutionArtifacts() {
  const dataEvo = resolve(DATA_DIR, 'evolution');
  const srcEvo = resolve(ROOT, 'src', 'evolution');
  const knowledge = resolve(DATA_DIR, 'knowledge');

  const listFiles = (dir, limit = 50) => {
    if (!existsSync(dir)) return { exists: false, files: [] };
    const names = listDirSafe(dir).slice(0, limit);
    return {
      exists: true,
      count: listDirSafe(dir).length,
      sample: names
    };
  };

  return {
    dataEvolution: listFiles(dataEvo),
    srcEvolution: listFiles(srcEvo),
    knowledge: listFiles(knowledge),
    note: 'Evolution can write production-adjacent weights/rules without explicit promotion gates.'
  };
}

function collectIntegrity(db) {
  let integrity = null;
  try {
    integrity = db.prepare('PRAGMA integrity_check').get();
  } catch (error) {
    integrity = { integrity_check: `error: ${error?.message || error}` };
  }
  let foreignKeys = null;
  try {
    foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  } catch (error) {
    foreignKeys = [{ error: error?.message || String(error) }];
  }

  return {
    integrity_check: integrity,
    foreign_key_violations: foreignKeys,
    foreign_key_violation_count: Array.isArray(foreignKeys) ? foreignKeys.length : null
  };
}

function riskRegister(report) {
  const risks = [];

  if ((report.ledger?.processedButOpenCount || 0) > 0) {
    risks.push({
      id: 'P0-non-atomic-settlement',
      severity: 'P0',
      fact: true,
      summary: `${report.ledger.processedButOpenCount} open ledger rows have post_game_processed=1`,
      detail:
        'recordOutcome marks the pick processed before/without guaranteed settlement; retries can skip stranded open bets.'
    });
  }

  if ((report.ledger?.sideMismatchCount || 0) > 0) {
    risks.push({
      id: 'P0-side-payload-mismatch',
      severity: 'P0',
      fact: true,
      summary: `${report.ledger.sideMismatchCount} moneyline rows have ledger.side != payload.valuePick.side`,
      detail:
        'Mutable pick payload and ledger can disagree; CLV may attach to a different side than P/L.'
    });
  }

  if ((report.ledger?.pickVsValueDivergenceCount || 0) > 0) {
    risks.push({
      id: 'P0-pick-vs-value-divergence',
      severity: 'P0',
      fact: true,
      summary: `${report.ledger.pickVsValueDivergenceCount} moneyline rows have pick.name != valuePick.teamName`,
      detail:
        'Displayed/model pick can differ from value bet team; settlement identity is ambiguous without immutable decision rows.'
    });
  }

  if ((report.ledger?.openCount || 0) > 0) {
    risks.push({
      id: 'P1-open-ledger-rows',
      severity: 'P1',
      fact: true,
      summary: `${report.ledger.openCount} open ledger rows remain`,
      detail: 'Includes totals rows that may lack a settlement path and stranded historical opens.'
    });
  }

  if ((report.ledger?.nullish?.emptyDateYmd || 0) > 0) {
    risks.push({
      id: 'P1-empty-ledger-date',
      severity: 'P1',
      fact: true,
      summary: `${report.ledger.nullish.emptyDateYmd} ledger rows have empty date_ymd`,
      detail: 'Date-scoped ledger queries and CLV windows undercount these rows.'
    });
  }

  if (!report.calibration?.runtimeMapsPresent) {
    risks.push({
      id: 'P1-missing-calibration-maps',
      severity: 'P1',
      fact: true,
      summary: 'Runtime calibration_maps.json missing',
      detail: 'JS calibrator silently identity-calibrates when maps are absent.'
    });
  } else if (
    report.calibration?.metaClaimsSuccess &&
    Object.values(report.calibration.mapPointCounts || {}).some((n) => n != null && n < 5)
  ) {
    risks.push({
      id: 'P2-sparse-calibration-maps',
      severity: 'P2',
      fact: true,
      summary: 'Calibration maps exist but are sparse',
      detail: `mapPointCounts=${JSON.stringify(report.calibration.mapPointCounts)}`
    });
  }

  risks.push({
    id: 'P0-mutable-prediction-identity',
    severity: 'P0',
    fact: true,
    summary: 'picks.game_pk is PRIMARY KEY with ON CONFLICT UPDATE',
    detail:
      'Reruns overwrite prediction identity; no immutable prediction_runs / prediction_decisions join.'
  });

  risks.push({
    id: 'P0-historical-lookahead-paths',
    severity: 'P0',
    fact: true,
    summary: 'Live mlb.js has full-season and boxscore paths without strict as_of cutoff',
    detail:
      'fetchTeamStats/fetchPitcherStats/fetchPitcherRecentStarts/fetchGameLineupProfile can leak future observations into historical-style evaluation.'
  });

  risks.push({
    id: 'P0-live-backtest-divergence',
    severity: 'P0',
    fact: true,
    summary: 'Python backtest does not replay the live JS production path',
    detail:
      'Telegram/live uses src/mlb.js + JS calibration/value engine; Python backtest uses separate model/fixtures.'
  });

  risks.push({
    id: 'P1-roi-denominator-bug',
    severity: 'P1',
    fact: true,
    summary: 'evaluate.py historically uses profit / bet count for ROI',
    detail: `Stake-weighted ROI on current moneyline settled = ${report.ledger?.stakeWeightedRoi}; bet-count ROI = ${report.ledger?.betCountRoi}`
  });

  return risks;
}

function buildReport(dbPath) {
  const env = collectEnvironment();
  const dbFile = fileInfo(dbPath);

  if (!dbFile.exists) {
    return {
      status: 'error',
      error: `database not found: ${dbPath}`,
      environment: env,
      database: dbFile
    };
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const schema = collectSchema(db);
    const ledger = collectLedger(db);
    const picks = collectPicks(db);
    const snapshots = collectSnapshots(db);
    const integrity = collectIntegrity(db);
    const calibration = collectCalibrationArtifacts();
    const evolution = collectEvolutionArtifacts();

    const report = {
      status: 'ok',
      auditVersion: 1,
      mode: 'read_only',
      collectedAt: new Date().toISOString(),
      environment: env,
      database: dbFile,
      integrity,
      schema,
      picks,
      ledger,
      snapshots,
      calibration,
      evolution,
      baselineTests: {
        note: 'Recorded during Phase 0 baseline; re-run to refresh.',
        npmCheck: 'pass',
        testJs: { pass: 112, fail: 0, skipped: 5 },
        testPy: { pass: 542, fail: 0 }
      }
    };
    report.risks = riskRegister(report);
    report.summary = {
      tableCount: report.schema.tableNames.length,
      picks: report.picks.rowCount,
      ledgerOpen: report.ledger.openCount,
      ledgerSettledMoneyline: report.ledger.moneylineSettled?.settled ?? null,
      stakeWeightedRoiMoneyline: report.ledger.stakeWeightedRoi,
      sideMismatches: report.ledger.sideMismatchCount,
      pickVsValueDivergences: report.ledger.pickVsValueDivergenceCount,
      processedButOpen: report.ledger.processedButOpenCount,
      p0Risks: report.risks.filter((r) => r.severity === 'P0').length,
      p1Risks: report.risks.filter((r) => r.severity === 'P1').length
    };
    return report;
  } finally {
    db.close();
  }
}

function formatText(report) {
  if (report.status !== 'ok') {
    return `AUDIT ERROR: ${report.error}\n`;
  }

  const lines = [];
  lines.push('=== MLB Stats Bot Technical Audit (read-only) ===');
  lines.push(`collectedAt: ${report.collectedAt}`);
  lines.push(`db: ${report.database.path}`);
  lines.push(
    `node: ${report.environment.node} ABI=${report.environment.modulesAbi} git=${report.environment.git?.head || 'unknown'} branch=${report.environment.git?.branch || 'unknown'}`
  );
  lines.push('');
  lines.push('-- Summary --');
  for (const [k, v] of Object.entries(report.summary)) {
    lines.push(`  ${k}: ${v}`);
  }
  lines.push('');
  lines.push('-- Tables --');
  for (const name of report.schema.tableNames) {
    lines.push(`  ${name}: ${report.schema.tables[name].rowCount} rows`);
  }
  lines.push('');
  lines.push('-- Ledger --');
  lines.push(`  open: ${report.ledger.openCount}`);
  lines.push(`  processedButOpen: ${report.ledger.processedButOpenCount}`);
  lines.push(`  sideMismatches: ${report.ledger.sideMismatchCount}`);
  lines.push(`  pickVsValueDivergences: ${report.ledger.pickVsValueDivergenceCount}`);
  lines.push(
    `  moneyline settled: ${report.ledger.moneylineSettled?.settled} stake=${report.ledger.moneylineSettled?.total_staked} pl=${report.ledger.moneylineSettled?.total_pl} stakeWeightedRoi=${report.ledger.stakeWeightedRoi}`
  );
  lines.push(
    `  totals settled: ${report.ledger.totalsSettled?.settled} pl=${report.ledger.totalsSettled?.total_pl}`
  );
  if (report.ledger.openRows?.length) {
    lines.push('  open rows:');
    for (const row of report.ledger.openRows.slice(0, 20)) {
      lines.push(
        `    ${row.decision_id} market=${row.market} date=${row.date_ymd || '(empty)'} ${row.team}/${row.side}`
      );
    }
  }
  if (report.ledger.pickVsValueDivergences?.length) {
    lines.push('  pick vs value divergences (sample):');
    for (const row of report.ledger.pickVsValueDivergences.slice(0, 10)) {
      lines.push(
        `    game=${row.gamePk} ledger=${row.ledgerTeam}/${row.ledgerSide} pick=${row.pickName} value=${row.valueTeam} result=${row.result} clv=${row.clv}`
      );
    }
  }
  lines.push('');
  lines.push('-- Calibration --');
  lines.push(`  runtimeMapsPresent: ${report.calibration.runtimeMapsPresent}`);
  lines.push(`  markets: ${report.calibration.marketsPresent.join(', ') || '(none)'}`);
  lines.push(`  mapPointCounts: ${JSON.stringify(report.calibration.mapPointCounts)}`);
  lines.push('');
  lines.push('-- Risks --');
  for (const risk of report.risks) {
    lines.push(`  [${risk.severity}] ${risk.id}: ${risk.summary}`);
  }
  lines.push('');
  lines.push('status: unaudited inventory only — not a performance claim');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/run_technical_audit.js [--db PATH] [--json] [--write] [--out PATH]\n'
    );
    process.exit(0);
  }

  const report = buildReport(args.db);
  const text = formatText(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;

  if (args.write || args.out) {
    const outPath =
      args.out || resolve(ROOT, 'reports', 'audit_inventory.json');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, json);
    const mdPath = outPath.endsWith('.json')
      ? outPath.replace(/\.json$/, '.md')
      : `${outPath}.md`;
    writeFileSync(mdPath, `# Audit Inventory\n\n\`\`\`\n${text}\`\`\`\n`);
  }

  if (args.json) {
    process.stdout.write(json);
  } else {
    process.stdout.write(text);
  }

  // Non-zero only on hard failure; findings are expected and reported.
  process.exit(report.status === 'ok' ? 0 : 1);
}

main();
