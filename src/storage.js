import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';

const DEFAULT_STATE = {
  lastUpdateId: 0,
  lastAutoAlertDate: '',
  subscribers: {},
  predictions: {},
  memory: {
    version: 2,
    totalPicks: 0,
    correctPicks: 0,
    wrongPicks: 0,
    byConfidence: {},
    firstInning: {
      totalPicks: 0,
      correctPicks: 0,
      wrongPicks: 0,
      byPick: {
        YES: { total: 0, correct: 0 },
        NO: { total: 0, correct: 0 }
      }
    },
    teamBias: {},
    matchupMemory: {},
    learningLog: []
  }
};

const DEFAULT_AUTO_UPDATE = {
  enabled: false,
  dailyTime: '',
  lastSentDate: ''
};
const DEFAULT_LINE_MOVEMENT_ALERTS = {
  enabled: true
};
const TEAM_BIAS_LIMIT = 0.08;

const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3']);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sortTeamIds(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return String(left).localeCompare(String(right));
}

function matchupMemoryKey(teamAId, teamBId) {
  return [String(teamAId), String(teamBId)].sort(sortTeamIds).join(':');
}

function teamSnapshot(team) {
  return {
    id: team?.id,
    name: team?.name,
    abbreviation: team?.abbreviation
  };
}

function currentWinnerStreak(games) {
  if (!games.length) return null;

  const firstWinner = games[0]?.winner;
  if (!firstWinner || firstWinner.id == null) return null;

  const winnerId = String(firstWinner.id);
  let length = 0;
  for (const game of games) {
    if (!game.winner || String(game.winner.id) !== winnerId) break;
    length += 1;
  }

  return {
    winner: firstWinner,
    length
  };
}

function hasAlternatingWinners(games) {
  if (games.length < 3) return false;

  const recent = games.slice(0, 4).map((game) => String(game.winner.id));
  for (let index = 1; index < recent.length; index += 1) {
    if (recent[index] === recent[index - 1]) return false;
  }

  return true;
}

function matchupPatternNote(entry) {
  const recent = entry.recentGames || [];
  if (!recent.length) return 'Belum ada matchup memory.';

  const streak = entry.currentStreak;
  const averageMargin = Number(entry.averageMargin || 0).toFixed(1);
  const accuracy =
    entry.pickStats?.total > 0
      ? Math.round((entry.pickStats.correct / entry.pickStats.total) * 100)
      : 0;

  if (entry.alternating) {
    return `Matchup recent bergantian; memory dibuat hati-hati. Avg margin ${averageMargin}, akurasi pick ${accuracy}%.`;
  }

  if (streak?.length >= 2) {
    return `${streak.winner.abbreviation || streak.winner.name} menang ${streak.length} pertemuan terakhir; tetap diperlakukan sebagai sinyal kecil. Avg margin ${averageMargin}.`;
  }

  return `${entry.totalGames} pertemuan tersimpan, avg margin ${averageMargin}, akurasi pick matchup ${accuracy}%.`;
}

function updateMatchupMemory(memory, prediction, result, correct, firstInningCorrect) {
  const key = matchupMemoryKey(prediction.away.id, prediction.home.id);
  const existing = memory.matchupMemory[key] || {};
  const margin = Math.abs(Number(result.home.score) - Number(result.away.score));
  const gameRecord = {
    gamePk: prediction.gamePk,
    dateYmd: prediction.dateYmd || result.dateYmd || '',
    matchup: prediction.matchup,
    away: teamSnapshot(result.away),
    home: teamSnapshot(result.home),
    winner: teamSnapshot(result.winner),
    loser: teamSnapshot(result.loser),
    score: {
      away: result.away.score,
      home: result.home.score
    },
    margin,
    pick: teamSnapshot(prediction.pick),
    pickProbability: prediction.pick.winProbability,
    pickConfidence: prediction.pick.confidence || 'unknown',
    correct,
    firstInningCorrect
  };

  const existingGames = existing.recentGames || [];
  const hadExistingGame = existingGames.some(
    (game) => String(game.gamePk) === String(prediction.gamePk)
  );
  const previousGames = existingGames.filter(
    (game) => String(game.gamePk) !== String(prediction.gamePk)
  );
  const recentGames = [gameRecord, ...previousGames].slice(0, 12);
  const teamIds = [String(prediction.away.id), String(prediction.home.id)];
  const teamRecords = Object.fromEntries(
    teamIds.map((teamId) => {
      const wins = recentGames.filter((game) => String(game.winner.id) === teamId).length;
      const losses = recentGames.filter((game) => String(game.loser.id) === teamId).length;
      return [teamId, { wins, losses }];
    })
  );
  const pickStats = {
    total: recentGames.length,
    correct: recentGames.filter((game) => game.correct).length
  };
  const averageMargin =
    recentGames.reduce((sum, game) => sum + Number(game.margin || 0), 0) /
    Math.max(1, recentGames.length);

  const entry = {
    key,
    teams: {
      ...(existing.teams || {}),
      [String(prediction.away.id)]: teamSnapshot(prediction.away),
      [String(prediction.home.id)]: teamSnapshot(prediction.home)
    },
    totalGames: Math.max(
      Number(existing.totalGames || 0) + (hadExistingGame ? 0 : 1),
      recentGames.length
    ),
    teamRecords,
    pickStats,
    averageMargin,
    currentStreak: currentWinnerStreak(recentGames),
    alternating: hasAlternatingWinners(recentGames),
    recentGames,
    updatedAt: new Date().toISOString()
  };
  entry.note = matchupPatternNote(entry);

  memory.matchupMemory[key] = entry;
  return entry;
}

function normalizeSubscriber(subscriber) {
  return {
    ...(subscriber || {}),
    autoUpdate: {
      ...DEFAULT_AUTO_UPDATE,
      ...(subscriber?.autoUpdate || {})
    },
    lineMovementAlerts: {
      ...DEFAULT_LINE_MOVEMENT_ALERTS,
      ...(subscriber?.lineMovementAlerts || {})
    }
  };
}

function normalizeState(state) {
  return {
    ...DEFAULT_STATE,
    ...state,
    subscribers: Object.fromEntries(
      Object.entries(state?.subscribers || {}).map(([chatId, subscriber]) => [
        chatId,
        normalizeSubscriber(subscriber)
      ])
    ),
    predictions: state?.predictions || {},
    memory: {
      ...DEFAULT_STATE.memory,
      ...(state?.memory || {}),
      firstInning: {
        ...DEFAULT_STATE.memory.firstInning,
        ...(state?.memory?.firstInning || {}),
        byPick: {
          ...DEFAULT_STATE.memory.firstInning.byPick,
          ...(state?.memory?.firstInning?.byPick || {})
        }
      },
      byConfidence: state?.memory?.byConfidence || {},
      teamBias: state?.memory?.teamBias || {},
      matchupMemory: state?.memory?.matchupMemory || {},
      learningLog: state?.memory?.learningLog || []
    }
  };
}

function compactPrediction(prediction, dateYmd) {
  const agent = prediction.agentAnalysis;
  const awayProbability = agent?.awayProbability ?? Math.round(prediction.away.winProbability);
  const homeProbability = agent?.homeProbability ?? Math.round(prediction.home.winProbability);
  const agentPick =
    agent?.pickTeamId === prediction.away.id
      ? prediction.away
      : agent?.pickTeamId === prediction.home.id
        ? prediction.home
        : prediction.winner;
  const pickProbability =
    agentPick.id === prediction.away.id
      ? awayProbability
      : agentPick.id === prediction.home.id
        ? homeProbability
        : Math.round(prediction.winner.winProbability);

  return {
    gamePk: prediction.gamePk,
    dateYmd,
    status: prediction.status,
    startTime: prediction.startTime || null,
    matchup: `${prediction.away.name} @ ${prediction.home.name}`,
    away: {
      id: prediction.away.id,
      name: prediction.away.name,
      abbreviation: prediction.away.abbreviation,
      winProbability: awayProbability,
      winProbabilityRaw: prediction.away.winProbabilityRaw ?? awayProbability,
      pureModelProbability: prediction.away.pureModelProbability ?? prediction.modelBreakdown?.pureAwayProbability ?? awayProbability,
      marketInformedProbability: prediction.away.marketInformedProbability ?? prediction.modelBreakdown?.marketInformedAwayProbability ?? null,
      record: prediction.away.record || null
    },
    home: {
      id: prediction.home.id,
      name: prediction.home.name,
      abbreviation: prediction.home.abbreviation,
      winProbability: homeProbability,
      winProbabilityRaw: prediction.home.winProbabilityRaw ?? homeProbability,
      pureModelProbability: prediction.home.pureModelProbability ?? prediction.modelBreakdown?.pureHomeProbability ?? homeProbability,
      marketInformedProbability: prediction.home.marketInformedProbability ?? prediction.modelBreakdown?.marketInformedHomeProbability ?? null,
      record: prediction.home.record || null
    },
    pick: {
      id: agentPick.id,
      name: agentPick.name,
      abbreviation: agentPick.abbreviation,
      winProbability: pickProbability,
      source: agent ? 'analyst-agent' : 'baseline-model',
      confidence: agent?.confidence || 'model'
    },
    reasons: agent?.reasons || prediction.reasons,
    firstInning: prediction.firstInning
      ? {
          pick: prediction.firstInning.agent?.pick || prediction.firstInning.baselinePick,
          probability: Math.round(
            prediction.firstInning.agent?.probability ?? prediction.firstInning.baselineProbability
          ),
          source: prediction.firstInning.agent ? 'analyst-agent' : 'baseline-model',
          reasons: prediction.firstInning.agent?.reasons || prediction.firstInning.reasons || []
        }
      : null,
    modelBreakdown: prediction.modelBreakdown || null,
    modelBreakdownLine: prediction.modelBreakdownLine || '',
    currentOdds: prediction.currentOdds || null,
    valuePick: prediction.valuePick || null,
    moneylineValueOptions: prediction.moneylineValueOptions || [],
    betDecision: prediction.betDecision || null,
    auditMemoryNotes: prediction.auditMemoryNotes || [],
    auditAdjustments: prediction.auditAdjustments || [],
    agentRisk: agent?.risk || '',
    agentMemoryNote: agent?.memoryNote || '',
    agentShift: agent?.probabilityShift
      ? {
          applied: agent.probabilityShift.applied,
          shift: agent.probabilityShift.shift,
          baselineAwayProbability: agent.probabilityShift.baselineAwayProbability,
          baselineHomeProbability: agent.probabilityShift.baselineHomeProbability
        }
      : null,
    savedAt: new Date().toISOString()
  };
}

function parseJson(value, fallback) {
  if (!value) return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toJson(value) {
  return JSON.stringify(value ?? null);
}

// Normalize a feature-fallback payload (the Python FallbackTracker.summary())
// into { count, features } for storage. When the payload is absent we return
// nulls so historical/agent-only rows are not falsely marked as "0 fallbacks".
function normalizeFeatureFallbacks(value) {
  if (value === null || value === undefined) {
    return { count: null, features: null };
  }
  if (Array.isArray(value)) {
    return { count: value.length, features: value };
  }
  if (typeof value === 'object') {
    const features = Array.isArray(value.features) ? value.features : [];
    const count = Number.isInteger(value.count) ? value.count : features.length;
    return { count, features };
  }
  return { count: null, features: null };
}

function toInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolToInt(value) {
  return value ? 1 : 0;
}

function intToBool(value) {
  return Number(value) === 1;
}

function deriveBasePath(filePath) {
  const resolved = resolve(filePath);
  const extension = extname(resolved).toLowerCase();
  const baseName = basename(resolved, extension);
  return {
    directory: dirname(resolved),
    baseName,
    extension,
    resolved
  };
}

function resolveDatabasePath(filePath) {
  if (process.env.MLB_STORAGE_DB_PATH) {
    return resolve(process.env.MLB_STORAGE_DB_PATH);
  }

  const { directory, baseName, extension, resolved } = deriveBasePath(filePath);
  if (SQLITE_EXTENSIONS.has(extension)) return resolved;
  return resolve(directory, `${baseName}.sqlite`);
}

function resolveLegacyStatePath(filePath) {
  const { directory, baseName, extension, resolved } = deriveBasePath(filePath);
  if (SQLITE_EXTENSIONS.has(extension)) return resolve(directory, `${baseName}.json`);
  return resolved;
}

export class Storage {
  constructor(filePath = resolve(process.cwd(), 'data', 'state.json')) {
    this.filePath = resolveLegacyStatePath(filePath);
    this.dbPath = resolveDatabasePath(filePath);
    mkdirSync(dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.initializeSchema();
    this.migrateLegacyJsonOnFirstRun();
    this.state = this.read();
  }

  initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_settings (
        chat_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        subscribed_at TEXT NOT NULL,
        auto_update_enabled INTEGER NOT NULL DEFAULT 0,
        daily_time TEXT NOT NULL DEFAULT '',
        last_sent_date TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS picks (
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

      CREATE TABLE IF NOT EXISTS yrfi_results (
        game_pk TEXT PRIMARY KEY,
        date_ymd TEXT NOT NULL,
        pick TEXT,
        probability INTEGER,
        source TEXT,
        prediction_payload TEXT,
        actual_any_run INTEGER,
        actual_pick TEXT,
        correct INTEGER,
        processed_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (game_pk) REFERENCES picks(game_pk) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory_summary (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 1,
        total_picks INTEGER NOT NULL DEFAULT 0,
        correct_picks INTEGER NOT NULL DEFAULT 0,
        wrong_picks INTEGER NOT NULL DEFAULT 0,
        by_confidence TEXT NOT NULL,
        first_inning TEXT NOT NULL,
        team_bias TEXT NOT NULL,
        matchup_memory TEXT NOT NULL DEFAULT '{}',
        learning_log TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bet_ledger (
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
        UNIQUE(game_pk, market),
        FOREIGN KEY (game_pk) REFERENCES picks(game_pk) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS line_snapshots (
        game_pk TEXT NOT NULL,
        market TEXT NOT NULL,
        value REAL NOT NULL,
        timestamp TEXT NOT NULL,
        PRIMARY KEY (game_pk, market)
      );

      CREATE TABLE IF NOT EXISTS line_alerts (
        alert_key TEXT PRIMARY KEY,
        game_pk TEXT NOT NULL,
        market TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      -- Per-game raw feature snapshots: an append-on-first-write store for
      -- discriminative inputs (umpire, platoon, statcast, closing line) captured
      -- pre-game so they can be joined to outcomes and backtested LATER. Keyed by
      -- (game_pk, feature_group); payload is JSON so new feature groups need no
      -- schema change. date_ymd is denormalized for cheap date-range backtests.
      CREATE TABLE IF NOT EXISTS feature_snapshots (
        game_pk TEXT NOT NULL,
        feature_group TEXT NOT NULL,
        date_ymd TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        PRIMARY KEY (game_pk, feature_group)
      );

      CREATE INDEX IF NOT EXISTS idx_picks_date ON picks(date_ymd);
      CREATE INDEX IF NOT EXISTS idx_picks_post_game ON picks(post_game_processed);
      CREATE INDEX IF NOT EXISTS idx_yrfi_date ON yrfi_results(date_ymd);
      CREATE INDEX IF NOT EXISTS idx_bet_ledger_date ON bet_ledger(date_ymd);
      CREATE INDEX IF NOT EXISTS idx_bet_ledger_status ON bet_ledger(status);
      CREATE INDEX IF NOT EXISTS idx_line_snapshots_timestamp ON line_snapshots(timestamp);
      CREATE INDEX IF NOT EXISTS idx_line_alerts_timestamp ON line_alerts(timestamp);
      CREATE INDEX IF NOT EXISTS idx_feature_snapshots_date ON feature_snapshots(date_ymd);

      CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_history_chat ON chat_history(chat_id, timestamp);
    `);

    const now = new Date().toISOString();
    const memoryColumns = this.db
      .prepare('PRAGMA table_info(memory_summary)')
      .all()
      .map((column) => column.name);
    if (!memoryColumns.includes('matchup_memory')) {
      this.db
        .prepare("ALTER TABLE memory_summary ADD COLUMN matchup_memory TEXT NOT NULL DEFAULT '{}'")
        .run();
    }

    const ledgerColumns = this.db
      .prepare('PRAGMA table_info(bet_ledger)')
      .all()
      .map((column) => column.name);
    if (!ledgerColumns.includes('line')) {
      this.db.prepare('ALTER TABLE bet_ledger ADD COLUMN line REAL').run();
    }
    // Feature-fallback visibility (Stage 3). Backward-compatible ALTERs so
    // historical rows are preserved. `feature_fallback_count` = number of
    // features that fell back to a generic default for that pick;
    // `fallback_features_used` = JSON array of the feature names that fell back.
    if (!ledgerColumns.includes('feature_fallback_count')) {
      this.db
        .prepare('ALTER TABLE bet_ledger ADD COLUMN feature_fallback_count INTEGER')
        .run();
    }
    if (!ledgerColumns.includes('fallback_features_used')) {
      this.db
        .prepare('ALTER TABLE bet_ledger ADD COLUMN fallback_features_used TEXT')
        .run();
    }

    const pickColumns = this.db
      .prepare('PRAGMA table_info(picks)')
      .all()
      .map((column) => column.name);
    if (!pickColumns.includes('feature_fallback_count')) {
      this.db.prepare('ALTER TABLE picks ADD COLUMN feature_fallback_count INTEGER').run();
    }
    if (!pickColumns.includes('fallback_features_used')) {
      this.db.prepare('ALTER TABLE picks ADD COLUMN fallback_features_used TEXT').run();
    }

    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_summary (
          id, version, total_picks, correct_picks, wrong_picks, by_confidence,
          first_inning, team_bias, matchup_memory, learning_log, updated_at
        ) VALUES (1, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        DEFAULT_STATE.memory.version,
        toJson(DEFAULT_STATE.memory.byConfidence),
        toJson(DEFAULT_STATE.memory.firstInning),
        toJson(DEFAULT_STATE.memory.teamBias),
        toJson(DEFAULT_STATE.memory.matchupMemory),
        toJson(DEFAULT_STATE.memory.learningLog),
        now
      );

    this.setMetaIfMissing('lastUpdateId', String(DEFAULT_STATE.lastUpdateId));
    this.setMetaIfMissing('lastAutoAlertDate', DEFAULT_STATE.lastAutoAlertDate);
  }

  setMetaIfMissing(key, value) {
    this.db
      .prepare('INSERT OR IGNORE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, String(value ?? ''), new Date().toISOString());
  }

  getMeta(key, fallback = '') {
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
    return row?.value ?? fallback;
  }

  setMeta(key, value) {
    this.db
      .prepare(
        `INSERT INTO app_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      )
      .run(key, String(value ?? ''), new Date().toISOString());
  }

  hasExistingSqlState() {
    const pickCount = this.db.prepare('SELECT COUNT(*) AS count FROM picks').get().count;
    const chatCount = this.db.prepare('SELECT COUNT(*) AS count FROM chat_settings').get().count;
    if (pickCount > 0 || chatCount > 0) return true;

    if (toInteger(this.getMeta('lastUpdateId', '0')) > 0) return true;
    if (this.getMeta('lastAutoAlertDate', '')) return true;

    const memory = this.readMemory();
    return (
      memory.totalPicks > 0 ||
      memory.correctPicks > 0 ||
      memory.wrongPicks > 0 ||
      Object.keys(memory.byConfidence || {}).length > 0 ||
      Object.keys(memory.teamBias || {}).length > 0 ||
      Object.keys(memory.matchupMemory || {}).length > 0 ||
      (memory.learningLog || []).length > 0
    );
  }

  migrateLegacyJsonOnFirstRun() {
    if (this.getMeta('legacyJsonMigrated', '') === '1') return;

    const now = new Date().toISOString();
    if (!existsSync(this.filePath) || this.hasExistingSqlState()) {
      this.setMeta('legacyJsonMigrated', '1');
      this.setMeta('legacyJsonMigratedAt', now);
      return;
    }

    try {
      const legacyState = normalizeState(JSON.parse(readFileSync(this.filePath, 'utf8')));
      this.replaceAllFromState(legacyState);
      this.setMeta('legacyJsonMigrated', '1');
      this.setMeta('legacyJsonMigratedAt', now);
      this.setMeta('legacyJsonPath', this.filePath);
    } catch (error) {
      this.setMeta('legacyJsonMigrated', '1');
      this.setMeta('legacyJsonMigratedAt', now);
      this.setMeta('legacyJsonMigrationError', error?.message || 'Unknown migration error');
    }
  }

  replaceAllFromState(state) {
    const normalized = normalizeState(state);
    const replace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM yrfi_results').run();
      this.db.prepare('DELETE FROM picks').run();
      this.db.prepare('DELETE FROM chat_settings').run();

      this.setMeta('lastUpdateId', normalized.lastUpdateId || 0);
      this.setMeta('lastAutoAlertDate', normalized.lastAutoAlertDate || '');
      this.writeMemory(normalized.memory);

      for (const subscriber of Object.values(normalized.subscribers || {})) {
        this.writeSubscriber(subscriber);
      }

      for (const prediction of Object.values(normalized.predictions || {})) {
        this.writePredictionRow(prediction);
      }
    });

    replace();
  }

  read() {
    const subscribers = {};
    for (const row of this.db.prepare('SELECT * FROM chat_settings ORDER BY chat_id').all()) {
      const subscriber = this.subscriberFromRow(row);
      subscribers[String(subscriber.id)] = subscriber;
    }

    const predictions = {};
    for (const row of this.db.prepare('SELECT * FROM picks ORDER BY date_ymd, game_pk').all()) {
      const prediction = this.predictionFromRow(row);
      predictions[String(prediction.gamePk)] = prediction;
    }

    return normalizeState({
      lastUpdateId: toInteger(this.getMeta('lastUpdateId', '0')),
      lastAutoAlertDate: this.getMeta('lastAutoAlertDate', ''),
      subscribers,
      predictions,
      memory: this.readMemory()
    });
  }

  refreshState() {
    this.state = this.read();
    return this.state;
  }

  save() {
    this.replaceAllFromState(this.state || DEFAULT_STATE);
    this.refreshState();
  }

  close() {
    this.db.close();
  }

  readMemory() {
    const row = this.db.prepare('SELECT * FROM memory_summary WHERE id = 1').get();
    if (!row) return normalizeState(DEFAULT_STATE).memory;

    return normalizeState({
      memory: {
        version: row.version || DEFAULT_STATE.memory.version,
        totalPicks: row.total_picks || 0,
        correctPicks: row.correct_picks || 0,
        wrongPicks: row.wrong_picks || 0,
        byConfidence: parseJson(row.by_confidence, {}),
        firstInning: parseJson(row.first_inning, DEFAULT_STATE.memory.firstInning),
        teamBias: parseJson(row.team_bias, {}),
        matchupMemory: parseJson(row.matchup_memory, {}),
        learningLog: parseJson(row.learning_log, [])
      }
    }).memory;
  }

  writeMemory(memory) {
    const normalized = normalizeState({ memory }).memory;
    this.db
      .prepare(
        `INSERT INTO memory_summary (
          id, version, total_picks, correct_picks, wrong_picks, by_confidence,
          first_inning, team_bias, matchup_memory, learning_log, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          version = excluded.version,
          total_picks = excluded.total_picks,
          correct_picks = excluded.correct_picks,
          wrong_picks = excluded.wrong_picks,
          by_confidence = excluded.by_confidence,
          first_inning = excluded.first_inning,
          team_bias = excluded.team_bias,
          matchup_memory = excluded.matchup_memory,
          learning_log = excluded.learning_log,
          updated_at = excluded.updated_at`
      )
      .run(
        normalized.version || 1,
        normalized.totalPicks || 0,
        normalized.correctPicks || 0,
        normalized.wrongPicks || 0,
        toJson(normalized.byConfidence),
        toJson(normalized.firstInning),
        toJson(normalized.teamBias),
        toJson(normalized.matchupMemory),
        toJson(normalized.learningLog),
        new Date().toISOString()
      );
  }

  subscriberFromRow(row) {
    const payload = parseJson(row.payload, {});
    const numericId = Number(row.chat_id);
    const id =
      payload.id !== undefined
        ? payload.id
        : Number.isSafeInteger(numericId)
          ? numericId
          : row.chat_id;

    return normalizeSubscriber({
      ...payload,
      id,
      title: row.title || payload.title || String(id),
      subscribedAt: row.subscribed_at || payload.subscribedAt || new Date().toISOString(),
      autoUpdate: {
        enabled: intToBool(row.auto_update_enabled),
        dailyTime: row.daily_time || '',
        lastSentDate: row.last_sent_date || ''
      }
    });
  }

  readSubscriber(chatId) {
    const row = this.db.prepare('SELECT * FROM chat_settings WHERE chat_id = ?').get(String(chatId));
    return row ? this.subscriberFromRow(row) : null;
  }

  writeSubscriber(subscriber) {
    const normalized = normalizeSubscriber(subscriber);
    const chatId = String(normalized.id);
    const autoUpdate = {
      ...DEFAULT_AUTO_UPDATE,
      ...(normalized.autoUpdate || {})
    };
    const payload = {
      ...normalized,
      autoUpdate,
      lineMovementAlerts: {
        ...DEFAULT_LINE_MOVEMENT_ALERTS,
        ...(normalized.lineMovementAlerts || {})
      }
    };

    this.db
      .prepare(
        `INSERT INTO chat_settings (
          chat_id, title, subscribed_at, auto_update_enabled, daily_time,
          last_sent_date, payload, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          title = excluded.title,
          subscribed_at = excluded.subscribed_at,
          auto_update_enabled = excluded.auto_update_enabled,
          daily_time = excluded.daily_time,
          last_sent_date = excluded.last_sent_date,
          payload = excluded.payload,
          updated_at = excluded.updated_at`
      )
      .run(
        chatId,
        normalized.title || chatId,
        normalized.subscribedAt || new Date().toISOString(),
        boolToInt(autoUpdate.enabled),
        autoUpdate.dailyTime || '',
        autoUpdate.lastSentDate || '',
        toJson(payload),
        new Date().toISOString()
      );
  }

  predictionFromRow(row) {
    const prediction = parseJson(row.payload, {});
    return {
      ...prediction,
      gamePk: prediction.gamePk ?? row.game_pk,
      dateYmd: prediction.dateYmd ?? row.date_ymd,
      status: prediction.status ?? row.status,
      matchup: prediction.matchup ?? row.matchup,
      postGameProcessed: intToBool(row.post_game_processed),
      postGameProcessedAt: row.post_game_processed_at || null
    };
  }

  writePredictionRow(prediction) {
    const gamePk = String(prediction.gamePk);
    const firstInning = prediction.firstInning || null;
    const normalizedPrediction = {
      ...prediction,
      postGameProcessed: Boolean(prediction.postGameProcessed),
      postGameProcessedAt: prediction.postGameProcessedAt || null
    };
    const now = new Date().toISOString();

    const fallback = normalizeFeatureFallbacks(normalizedPrediction.featureFallbacks);

    this.db
      .prepare(
        `INSERT INTO picks (
          game_pk, date_ymd, status, matchup, away_team_id, home_team_id,
          pick_team_id, pick_confidence, pick_source, post_game_processed,
          post_game_processed_at, saved_at, payload, updated_at,
          feature_fallback_count, fallback_features_used
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(game_pk) DO UPDATE SET
          date_ymd = excluded.date_ymd,
          status = excluded.status,
          matchup = excluded.matchup,
          away_team_id = excluded.away_team_id,
          home_team_id = excluded.home_team_id,
          pick_team_id = excluded.pick_team_id,
          pick_confidence = excluded.pick_confidence,
          pick_source = excluded.pick_source,
          post_game_processed = excluded.post_game_processed,
          post_game_processed_at = excluded.post_game_processed_at,
          saved_at = excluded.saved_at,
          payload = excluded.payload,
          updated_at = excluded.updated_at,
          feature_fallback_count = excluded.feature_fallback_count,
          fallback_features_used = excluded.fallback_features_used`
      )
      .run(
        gamePk,
        normalizedPrediction.dateYmd || '',
        normalizedPrediction.status || '',
        normalizedPrediction.matchup || '',
        normalizedPrediction.away?.id !== undefined ? String(normalizedPrediction.away.id) : null,
        normalizedPrediction.home?.id !== undefined ? String(normalizedPrediction.home.id) : null,
        normalizedPrediction.pick?.id !== undefined ? String(normalizedPrediction.pick.id) : null,
        normalizedPrediction.pick?.confidence || '',
        normalizedPrediction.pick?.source || '',
        boolToInt(normalizedPrediction.postGameProcessed),
        normalizedPrediction.postGameProcessedAt,
        normalizedPrediction.savedAt || now,
        toJson(normalizedPrediction),
        now,
        fallback.count,
        fallback.features === null ? null : toJson(fallback.features)
      );

    if (firstInning) {
      this.db
        .prepare(
          `INSERT INTO yrfi_results (
            game_pk, date_ymd, pick, probability, source, prediction_payload, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(game_pk) DO UPDATE SET
            date_ymd = excluded.date_ymd,
            pick = excluded.pick,
            probability = excluded.probability,
            source = excluded.source,
            prediction_payload = excluded.prediction_payload,
            updated_at = excluded.updated_at`
        )
        .run(
          gamePk,
          normalizedPrediction.dateYmd || '',
          firstInning.pick || null,
          firstInning.probability ?? null,
          firstInning.source || null,
          toJson(firstInning),
          now
        );
    }
  }

  getLastUpdateId() {
    return toInteger(this.getMeta('lastUpdateId', '0'));
  }

  setLastUpdateId(updateId) {
    this.setMeta('lastUpdateId', updateId || 0);
    this.refreshState();
  }

  addSubscriber(chat, options = {}) {
    const key = String(chat.id);
    const existing = this.readSubscriber(key) || {};
    const subscriber = normalizeSubscriber({
      ...existing,
      id: chat.id,
      title: chat.title || chat.username || chat.first_name || String(chat.id),
      subscribedAt: existing.subscribedAt || new Date().toISOString(),
      autoUpdate: {
        ...(existing.autoUpdate || {}),
        ...(options.autoUpdate || {})
      }
    });

    this.writeSubscriber(subscriber);
    this.refreshState();
  }

  removeSubscriber(chatId) {
    this.db.prepare('DELETE FROM chat_settings WHERE chat_id = ?').run(String(chatId));
    this.refreshState();
  }

  listSubscriberIds() {
    return this.db
      .prepare('SELECT chat_id FROM chat_settings ORDER BY chat_id')
      .all()
      .map((row) => row.chat_id);
  }

  getSubscriber(chatId) {
    return this.readSubscriber(chatId);
  }

  setAutoUpdate(chat, updates = {}) {
    const key = String(chat.id);
    const existing =
      this.readSubscriber(key) ||
      normalizeSubscriber({
        id: chat.id,
        title: chat.title || chat.username || chat.first_name || String(chat.id),
        subscribedAt: new Date().toISOString()
      });

    const subscriber = normalizeSubscriber({
      ...existing,
      id: chat.id,
      title: existing.title || chat.title || chat.username || chat.first_name || String(chat.id),
      autoUpdate: {
        ...DEFAULT_AUTO_UPDATE,
        ...(existing.autoUpdate || {}),
        ...updates
      }
    });

    this.writeSubscriber(subscriber);
    this.refreshState();
  }

  getAutoUpdate(chatId) {
    const subscriber = this.readSubscriber(chatId);
    return {
      ...DEFAULT_AUTO_UPDATE,
      ...(subscriber?.autoUpdate || {})
    };
  }

  setLineMovementAlerts(chat, updates = {}) {
    const key = String(chat.id);
    const existing =
      this.readSubscriber(key) ||
      normalizeSubscriber({
        id: chat.id,
        title: chat.title || chat.username || chat.first_name || String(chat.id),
        subscribedAt: new Date().toISOString()
      });

    const subscriber = normalizeSubscriber({
      ...existing,
      id: chat.id,
      title: existing.title || chat.title || chat.username || chat.first_name || String(chat.id),
      lineMovementAlerts: {
        ...DEFAULT_LINE_MOVEMENT_ALERTS,
        ...(existing.lineMovementAlerts || {}),
        ...updates
      }
    });

    this.writeSubscriber(subscriber);
    this.refreshState();
  }

  getLineMovementAlerts(chatId) {
    const subscriber = this.readSubscriber(chatId);
    return {
      ...DEFAULT_LINE_MOVEMENT_ALERTS,
      ...(subscriber?.lineMovementAlerts || {})
    };
  }

  listAutoUpdateTargets(defaultDailyTime = '20:00') {
    return this.db
      .prepare('SELECT * FROM chat_settings WHERE auto_update_enabled = 1 ORDER BY chat_id')
      .all()
      .map((row) => ({
        chatId: row.chat_id,
        title: row.title || row.chat_id,
        dailyTime: row.daily_time || defaultDailyTime,
        lastSentDate: row.last_sent_date || ''
      }));
  }

  setAutoUpdateLastSent(chatId, dateYmd) {
    const subscriber = this.readSubscriber(chatId);
    if (!subscriber) return;

    subscriber.autoUpdate = {
      ...DEFAULT_AUTO_UPDATE,
      ...(subscriber.autoUpdate || {}),
      lastSentDate: dateYmd
    };
    this.writeSubscriber(subscriber);
    this.refreshState();
  }

  getLastAutoAlertDate() {
    return this.getMeta('lastAutoAlertDate', '');
  }

  setLastAutoAlertDate(dateYmd) {
    this.setMeta('lastAutoAlertDate', dateYmd || '');
    this.refreshState();
  }

  savePredictions(dateYmd, predictions) {
    const saveRows = this.db.transaction(() => {
      for (const prediction of predictions) {
        if (String(prediction.status).toLowerCase().includes('final')) continue;

        const key = String(prediction.gamePk);
        const existing = this.getPrediction(key) || {};
        const compact = compactPrediction(prediction, dateYmd);
        if (!compact.openingOdds && existing.openingOdds) {
          compact.openingOdds = existing.openingOdds;
        } else if (!compact.openingOdds && compact.currentOdds) {
          compact.openingOdds = { ...compact.currentOdds, savedAt: new Date().toISOString() };
        } else if (!compact.openingOdds) {
          // Live Odds API often fails to match, leaving currentOdds null. Fall
          // back to the write-once opening_* line snapshots so moneyline CLV can
          // still be computed (opening implied vs closing implied).
          const openingOdds = this.openingOddsFromSnapshots(key);
          if (openingOdds) compact.openingOdds = openingOdds;
        }
        this.writePredictionRow({
          ...compact,
          postGameProcessed: existing.postGameProcessed || false,
          postGameProcessedAt: existing.postGameProcessedAt || null
        });
      }
    });

    saveRows();
    this.refreshState();
  }

  getPrediction(gamePk) {
    const row = this.db.prepare('SELECT * FROM picks WHERE game_pk = ?').get(String(gamePk));
    return row ? this.predictionFromRow(row) : null;
  }

  listPredictionsByDate(dateYmd) {
    return this.db
      .prepare('SELECT * FROM picks WHERE date_ymd = ? ORDER BY game_pk')
      .all(String(dateYmd || ''))
      .map((row) => this.predictionFromRow(row));
  }

  // Predictions stored on or after a date string. Used by closing-line capture,
  // which must NOT scope to a single timezone-derived day: a game listed under
  // date D can start after local midnight (stored date != local "today"), so a
  // single-day query misses tonight's slate. Querying a small recent range and
  // letting the start-time filter do the work avoids that rollover gap.
  listPredictionsSinceDate(dateYmd) {
    return this.db
      .prepare('SELECT * FROM picks WHERE date_ymd >= ? ORDER BY date_ymd, game_pk')
      .all(String(dateYmd || ''))
      .map((row) => this.predictionFromRow(row));
  }

  getLineSnapshot(gamePk, market) {
    const row = this.db
      .prepare(
        `SELECT game_pk AS gamePk, market, value, timestamp
         FROM line_snapshots
         WHERE game_pk = ? AND market = ?`
      )
      .get(String(gamePk), String(market));

    return row || null;
  }

  hasClosingLine(gamePk) {
    return this.getLineSnapshot(gamePk, 'closing_home') !== null;
  }

  openingOddsFromSnapshots(gamePk) {
    if (!gamePk) return null;
    const plausibleMoneyline = (value) => Number.isFinite(value) && Math.abs(value) >= 100 && Math.abs(value) <= 1000;
    const plausibleTotal = (value) => Number.isFinite(value) && value >= 4 && value <= 14;
    const read = (market) => {
      const snapshot = this.getLineSnapshot(gamePk, market);
      return snapshot ? Number(snapshot.value) : NaN;
    };
    const home = read('opening_home');
    const away = read('opening_away');
    const total = read('opening_total');
    if (!plausibleMoneyline(home) && !plausibleMoneyline(away)) return null;
    return {
      homeMoneyline: plausibleMoneyline(home) ? home : null,
      awayMoneyline: plausibleMoneyline(away) ? away : null,
      totalLine: plausibleTotal(total) ? total : null,
      moneylineBook: 'snapshot-open',
      source: 'line_snapshots',
      savedAt: new Date().toISOString()
    };
  }

  setLineSnapshot(gamePk, market, value, timestamp = new Date().toISOString()) {
    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue)) return;

    this.db
      .prepare(
        `INSERT INTO line_snapshots (game_pk, market, value, timestamp)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(game_pk, market) DO UPDATE SET
           value = excluded.value,
           timestamp = excluded.timestamp`
      )
      .run(String(gamePk), String(market), parsedValue, timestamp);

    // Freeze the first-seen moneyline/total as the OPENING line (write-once).
    // Live moneyline_*/total rows get overwritten every poll, so without this
    // the opening price is lost and moneyline CLV can't be computed. INSERT OR
    // IGNORE keeps only the earliest value.
    const openingMarket = {
      moneyline_home: 'opening_home',
      moneyline_away: 'opening_away',
      total: 'opening_total'
    }[String(market)];
    if (openingMarket) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO line_snapshots (game_pk, market, value, timestamp)
           VALUES (?, ?, ?, ?)`
        )
        .run(String(gamePk), openingMarket, parsedValue, timestamp);
    }
  }

  // Write-once per (game_pk, feature_group): the first pre-game capture is the
  // one we want to validate against later, so re-runs don't overwrite it. Pass
  // overwrite=true only for features that legitimately refresh (e.g. closing
  // line moving toward first pitch). payload is any JSON-serializable object.
  setFeatureSnapshot(gamePk, featureGroup, dateYmd, payload, { overwrite = false, timestamp = new Date().toISOString() } = {}) {
    const pk = String(gamePk || '');
    const group = String(featureGroup || '');
    if (!pk || !group) return false;
    let serialized;
    try {
      serialized = JSON.stringify(payload ?? null);
    } catch {
      return false;
    }
    const sql = overwrite
      ? `INSERT INTO feature_snapshots (game_pk, feature_group, date_ymd, payload, timestamp)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(game_pk, feature_group) DO UPDATE SET
           date_ymd = excluded.date_ymd,
           payload = excluded.payload,
           timestamp = excluded.timestamp`
      : `INSERT OR IGNORE INTO feature_snapshots (game_pk, feature_group, date_ymd, payload, timestamp)
         VALUES (?, ?, ?, ?, ?)`;
    const result = this.db.prepare(sql).run(pk, group, String(dateYmd || ''), serialized, timestamp);
    return result.changes > 0;
  }

  getFeatureSnapshot(gamePk, featureGroup) {
    const row = this.db
      .prepare(
        `SELECT game_pk AS gamePk, feature_group AS featureGroup, date_ymd AS dateYmd, payload, timestamp
         FROM feature_snapshots
         WHERE game_pk = ? AND feature_group = ?`
      )
      .get(String(gamePk), String(featureGroup));
    if (!row) return null;
    try {
      row.payload = JSON.parse(row.payload);
    } catch {
      row.payload = null;
    }
    return row;
  }

  listFeatureSnapshotsByDate(dateYmd, featureGroup = null) {
    const rows = featureGroup
      ? this.db
          .prepare(
            `SELECT game_pk AS gamePk, feature_group AS featureGroup, date_ymd AS dateYmd, payload, timestamp
             FROM feature_snapshots WHERE date_ymd = ? AND feature_group = ? ORDER BY game_pk`
          )
          .all(String(dateYmd), String(featureGroup))
      : this.db
          .prepare(
            `SELECT game_pk AS gamePk, feature_group AS featureGroup, date_ymd AS dateYmd, payload, timestamp
             FROM feature_snapshots WHERE date_ymd = ? ORDER BY game_pk`
          )
          .all(String(dateYmd));
    for (const row of rows) {
      try {
        row.payload = JSON.parse(row.payload);
      } catch {
        row.payload = null;
      }
    }
    return rows;
  }

  reserveLineAlert(alertKey, movement, chatId, timestamp = new Date().toISOString(), ttlHours = 18) {
    const key = String(alertKey || '');
    if (!key) return false;

    const cutoff = new Date(Date.now() - Math.max(1, Number(ttlHours) || 18) * 60 * 60 * 1000).toISOString();
    this.db.prepare('DELETE FROM line_alerts WHERE timestamp < ?').run(cutoff);

    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO line_alerts (alert_key, game_pk, market, chat_id, payload, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        key,
        String(movement?.gamePk || ''),
        String(movement?.storageMarket || movement?.market || ''),
        String(chatId || ''),
        toJson(movement || {}),
        timestamp
      );

    return result.changes === 1;
  }

  // Durable dedupe for lineup-confirmed pre-game alerts. Reuses the line_alerts
  // table since the contract is identical: at-most-once delivery per
  // (chatId, gamePk) pair, with TTL cleanup.
  reserveLineupAlert(chatId, gamePk, timestamp = new Date().toISOString(), ttlHours = 24) {
    const chat = String(chatId || '');
    const game = String(gamePk || '');
    if (!chat || !game) return false;
    const key = `lineup-both:${chat}:${game}`;
    return this.reserveLineAlert(
      key,
      { gamePk: game, market: 'lineup_both_confirmed' },
      chat,
      timestamp,
      ttlHours
    );
  }

  listPendingPredictionDates() {
    return this.db
      .prepare(
        `SELECT DISTINCT date_ymd
         FROM picks
         WHERE post_game_processed = 0 AND date_ymd <> ''
         ORDER BY date_ymd`
      )
      .all()
      .map((row) => row.date_ymd);
  }

  markPostGameProcessed(gamePk) {
    this.markPostGameProcessedRow(gamePk);
    this.refreshState();
  }

  markPostGameProcessedRow(gamePk) {
    const row = this.db.prepare('SELECT * FROM picks WHERE game_pk = ?').get(String(gamePk));
    if (!row) return;

    const processedAt = new Date().toISOString();
    const prediction = {
      ...this.predictionFromRow(row),
      postGameProcessed: true,
      postGameProcessedAt: processedAt
    };

    this.db
      .prepare(
        `UPDATE picks
         SET post_game_processed = 1,
             post_game_processed_at = ?,
             payload = ?,
             updated_at = ?
         WHERE game_pk = ?`
      )
      .run(processedAt, toJson(prediction), processedAt, String(gamePk));
  }

  getMemory() {
    const memory = this.readMemory();
    if (this.state) this.state.memory = memory;
    return memory;
  }

  getMemorySummary() {
    const memory = this.readMemory();
    const accuracy =
      memory.totalPicks > 0 ? Math.round((memory.correctPicks / memory.totalPicks) * 100) : 0;
    const firstInningAccuracy =
      memory.firstInning.totalPicks > 0
        ? Math.round((memory.firstInning.correctPicks / memory.firstInning.totalPicks) * 100)
        : 0;

    return {
      totalPicks: memory.totalPicks,
      correctPicks: memory.correctPicks,
      wrongPicks: memory.wrongPicks,
      accuracy,
      byConfidence: memory.byConfidence,
      firstInning: {
        ...memory.firstInning,
        accuracy: firstInningAccuracy
      },
      matchupMemory: {
        totalMatchups: Object.keys(memory.matchupMemory || {}).length,
        recent: Object.values(memory.matchupMemory || {})
          .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
          .slice(0, 5)
          .map((entry) => ({
            key: entry.key,
            teams: entry.teams,
            totalGames: entry.totalGames,
            currentStreak: entry.currentStreak,
            alternating: entry.alternating,
            averageMargin: entry.averageMargin,
            pickStats: entry.pickStats,
            note: entry.note
          }))
      },
      recentLog: memory.learningLog.slice(0, 5)
    };
  }

  recordOutcome(prediction, result, { enabled = true } = {}) {
    const updateOutcome = this.db.transaction(() => {
      const correct = prediction.pick.id === result.winner.id;
      const actualFirstInningRun = result.firstInning?.anyRun;
      const memory = this.readMemory();

      memory.totalPicks += 1;
      if (correct) memory.correctPicks += 1;
      if (!correct) memory.wrongPicks += 1;

      const confidence = prediction.pick.confidence || 'unknown';
      if (!memory.byConfidence[confidence]) {
        memory.byConfidence[confidence] = { total: 0, correct: 0 };
      }
      memory.byConfidence[confidence].total += 1;
      if (correct) memory.byConfidence[confidence].correct += 1;

      let firstInningCorrect = null;
      if (
        prediction.firstInning &&
        prediction.firstInning.pick &&
        String(prediction.firstInning.pick).toUpperCase() !== 'NO BET' &&
        actualFirstInningRun !== null &&
        actualFirstInningRun !== undefined
      ) {
        const actualPick = actualFirstInningRun ? 'YES' : 'NO';
        const predictedPick = prediction.firstInning.pick || 'NO';
        firstInningCorrect = predictedPick === actualPick;
        memory.firstInning.totalPicks += 1;
        if (firstInningCorrect) memory.firstInning.correctPicks += 1;
        if (!firstInningCorrect) memory.firstInning.wrongPicks += 1;

        if (!memory.firstInning.byPick[predictedPick]) {
          memory.firstInning.byPick[predictedPick] = { total: 0, correct: 0 };
        }
        memory.firstInning.byPick[predictedPick].total += 1;
        if (firstInningCorrect) memory.firstInning.byPick[predictedPick].correct += 1;

        this.writeYrfiOutcome(prediction, result, firstInningCorrect);
      }

      if (enabled) {
        if (!result.winner || !result.winner.id || !result.loser || !result.loser.id) {
          // Skip bias update for games without clear winner/loser (ties, suspended)
          return;
        }
        const winnerKey = String(result.winner.id);
        const loserKey = String(result.loser.id);
        const pickKey = String(prediction.pick.id);

        // When correct: small reinforcement for winner, small penalty for loser.
        // When wrong: penalize the PREDICTED team more (model was wrong about them),
        // give the ACTUAL winner only a small bump (they earned it but don't over-reward).
        const winnerBump = correct ? 0.002 : 0.002;
        const loserDrop = correct ? 0.001 : 0.004;
        memory.teamBias[winnerKey] = clamp(
          (memory.teamBias[winnerKey] || 0) + winnerBump,
          -TEAM_BIAS_LIMIT,
          TEAM_BIAS_LIMIT
        );
        memory.teamBias[loserKey] = clamp(
          (memory.teamBias[loserKey] || 0) - loserDrop,
          -TEAM_BIAS_LIMIT,
          TEAM_BIAS_LIMIT
        );

        // Extra penalty on the predicted team when the model was wrong
        if (!correct) {
          memory.teamBias[pickKey] = clamp(
            (memory.teamBias[pickKey] || 0) - 0.006,
            -TEAM_BIAS_LIMIT,
            TEAM_BIAS_LIMIT
          );
        }
      }

      const matchupMemory = updateMatchupMemory(memory, prediction, result, correct, firstInningCorrect);

      memory.learningLog.unshift({
        at: new Date().toISOString(),
        gamePk: prediction.gamePk,
        matchup: prediction.matchup,
        pick: prediction.pick.name,
        pickProbability: prediction.pick.winProbability,
        winner: result.winner.name,
        score: `${result.away.abbreviation || result.away.name} ${result.away.score} - ${result.home.score} ${result.home.abbreviation || result.home.name}`,
        correct,
        firstInningCorrect,
        firstInningPick: prediction.firstInning?.pick || null,
        firstInningActual:
          actualFirstInningRun === null || actualFirstInningRun === undefined
            ? null
            : actualFirstInningRun
              ? 'YES'
              : 'NO',
        matchupMemoryKey: matchupMemory.key,
        matchupMemoryNote: matchupMemory.note,
        confidence: prediction.pick.confidence || 'unknown',
        edge: prediction.betDecision?.edge ?? prediction.valuePick?.edge ?? null,
        dataQuality: prediction.modelBreakdown?.dataQuality ?? null,
        modelBreakdown: prediction.modelBreakdown || null,
        note: correct
          ? `Pick benar: ${prediction.pick.name}. Matchup memory menyimpan pola pertemuan ini tanpa over-bias.`
          : `Pick salah: ${prediction.pick.name}, pemenang ${result.winner.name}. Matchup memory mencatat miss dan pola seri untuk pertemuan berikutnya.`
      });

      memory.learningLog = memory.learningLog.slice(0, 75);
      this.writeMemory(memory);
      this.markPostGameProcessedRow(prediction.gamePk);
    });

    updateOutcome();
    this.refreshState();
  }

  writeYrfiOutcome(prediction, result, correct) {
    const anyRun = result.firstInning?.anyRun;
    if (anyRun === null || anyRun === undefined) return;

    const actualPick = anyRun ? 'YES' : 'NO';
    const processedAt = new Date().toISOString();
    const firstInning = prediction.firstInning || null;

    this.db
      .prepare(
        `INSERT INTO yrfi_results (
          game_pk, date_ymd, pick, probability, source, prediction_payload,
          actual_any_run, actual_pick, correct, processed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(game_pk) DO UPDATE SET
          actual_any_run = excluded.actual_any_run,
          actual_pick = excluded.actual_pick,
          correct = excluded.correct,
          processed_at = excluded.processed_at,
          updated_at = excluded.updated_at`
      )
      .run(
        String(prediction.gamePk),
        prediction.dateYmd || '',
        firstInning?.pick || null,
        firstInning?.probability ?? null,
        firstInning?.source || null,
        toJson(firstInning),
        boolToInt(anyRun),
        actualPick,
        boolToInt(correct),
        processedAt,
        processedAt
      );
  }

  // Record a VALUE bet at decision time. Idempotent on (game_pk, market): a
  // re-run of /picks for the same game never creates a duplicate ledger row.
  // Only VALUE picks with a positive Kelly stake are recorded.
  recordBet(prediction) {
    const decision = prediction?.betDecision;
    const value = prediction?.valuePick;
    if (!decision || decision.status !== 'VALUE') return null;
    if (Array.isArray(decision.reasons) && decision.reasons.length > 0) return null;
    if (!value || !(Number(value.kellyStakePercent) > 0)) return null;

    const gamePk = String(prediction.gamePk || '');
    const market = 'moneyline';
    const dateYmd = prediction.dateYmd || '';
    if (!gamePk) return null;

    // decision_id is derived from the natural key (game_pk + market), which the
    // UNIQUE constraint already guarantees. A per-date counter could collide
    // when two recordBet() calls race for different games on the same date.
    const decisionId = `${dateYmd}-${market}-${gamePk}`;
    const now = new Date().toISOString();

    const fallback = normalizeFeatureFallbacks(prediction.featureFallbacks);

    const info = this.db
      .prepare(
        `INSERT INTO bet_ledger (
          decision_id, game_pk, date_ymd, market, team, side, odds,
          fair_prob, model_prob, edge, units_staked, status, recommended_at,
          feature_fallback_count, fallback_features_used
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
        ON CONFLICT(game_pk, market) DO NOTHING`
      )
      .run(
        decisionId,
        gamePk,
        dateYmd,
        market,
        value.teamName || null,
        value.side || null,
        Number(value.odds),
        Number(value.fairProbability),
        Number(value.modelProbability),
        Number(value.edge),
        Number(value.kellyStakePercent),
        now,
        fallback.count,
        fallback.features === null ? null : toJson(fallback.features)
      );

    return info.changes > 0 ? decisionId : null;
  }

  // Settle an open bet against the final result. Idempotent: the status='open'
  // guard makes a second settle of the same game a no-op (units_pl unchanged).
  // 100u notional bankroll, so units_staked = stake% and a win pays
  // units_staked * profit-multiple of the American odds; a loss returns -stake.
  settleBet(prediction, result, clv = null) {
    const gamePk = String(prediction?.gamePk || '');
    const market = 'moneyline';
    if (!gamePk) return false;

    const row = this.db
      .prepare("SELECT * FROM bet_ledger WHERE game_pk = ? AND market = ? AND status = 'open'")
      .get(gamePk, market);
    if (!row) return false;

    const stakedTeamId = row.side === 'home' ? prediction.home?.id : prediction.away?.id;
    const winnerId = result?.winner?.id;
    let outcome = 'loss';
    let unitsPl = -row.units_staked;
    if (winnerId == null) {
      outcome = 'push';
      unitsPl = 0;
    } else if (String(stakedTeamId) === String(winnerId)) {
      outcome = 'win';
      const odds = Number(row.odds);
      const profitMultiple = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
      unitsPl = row.units_staked * profitMultiple;
    }

    this.db
      .prepare(
        `UPDATE bet_ledger
         SET status = 'settled', result = ?, units_pl = ?, clv = ?, settled_at = ?
         WHERE game_pk = ? AND market = ? AND status = 'open'`
      )
      .run(
        outcome,
        Math.round(unitsPl * 1000) / 1000,
        clv,
        new Date().toISOString(),
        gamePk,
        market
      );
    return true;
  }


  readLedger({ status = null, sinceDays = null, includeArchived = false } = {}) {
    const clauses = [];
    const params = [];
    if (!includeArchived) {
      clauses.push("market = 'moneyline'");
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (Number.isFinite(sinceDays)) {
      const cutoff = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10);
      clauses.push('date_ymd >= ?');
      params.push(cutoff);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM bet_ledger ${where} ORDER BY date_ymd ASC, decision_id ASC`)
      .all(...params);
  }

  appendChatMessage(chatId, role, content) {
    const maxMessages = 20;
    this.db
      .prepare('INSERT INTO chat_history (chat_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run(String(chatId), role, content, new Date().toISOString());

    const count = this.db
      .prepare('SELECT COUNT(*) AS count FROM chat_history WHERE chat_id = ?')
      .get(String(chatId)).count;

    if (count > maxMessages) {
      this.db
        .prepare(
          `DELETE FROM chat_history WHERE id IN (
            SELECT id FROM chat_history WHERE chat_id = ? ORDER BY timestamp ASC LIMIT ?
          )`
        )
        .run(String(chatId), count - maxMessages);
    }
  }

  getChatHistory(chatId, limit = 10) {
    return this.db
      .prepare('SELECT role, content FROM chat_history WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?')
      .all(String(chatId), limit)
      .reverse();
  }

  clearChatHistory(chatId) {
    this.db.prepare('DELETE FROM chat_history WHERE chat_id = ?').run(String(chatId));
  }
}
