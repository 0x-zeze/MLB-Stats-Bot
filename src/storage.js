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

  const winnerId = String(games[0].winner.id);
  let length = 0;
  for (const game of games) {
    if (String(game.winner.id) !== winnerId) break;
    length += 1;
  }

  return {
    winner: games[0].winner,
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
    matchup: `${prediction.away.name} @ ${prediction.home.name}`,
    away: {
      id: prediction.away.id,
      name: prediction.away.name,
      abbreviation: prediction.away.abbreviation,
      winProbability: awayProbability
    },
    home: {
      id: prediction.home.id,
      name: prediction.home.name,
      abbreviation: prediction.home.abbreviation,
      winProbability: homeProbability
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
    agentRisk: agent?.risk || '',
    agentMemoryNote: agent?.memoryNote || '',
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

      CREATE TABLE IF NOT EXISTS line_snapshots (
        game_pk TEXT NOT NULL,
        market TEXT NOT NULL,
        value REAL NOT NULL,
        timestamp TEXT NOT NULL,
        PRIMARY KEY (game_pk, market)
      );

      CREATE INDEX IF NOT EXISTS idx_picks_date ON picks(date_ymd);
      CREATE INDEX IF NOT EXISTS idx_picks_post_game ON picks(post_game_processed);
      CREATE INDEX IF NOT EXISTS idx_yrfi_date ON yrfi_results(date_ymd);
      CREATE INDEX IF NOT EXISTS idx_line_snapshots_timestamp ON line_snapshots(timestamp);
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
      autoUpdate
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

    this.db
      .prepare(
        `INSERT INTO picks (
          game_pk, date_ymd, status, matchup, away_team_id, home_team_id,
          pick_team_id, pick_confidence, pick_source, post_game_processed,
          post_game_processed_at, saved_at, payload, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          updated_at = excluded.updated_at`
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
        now
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
        this.writePredictionRow({
          ...compactPrediction(prediction, dateYmd),
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
        const winnerKey = String(result.winner.id);
        const loserKey = String(result.loser.id);
        const pickKey = String(prediction.pick.id);

        const winnerBump = correct ? 0.002 : 0.006;
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

        if (!correct) {
          memory.teamBias[pickKey] = clamp(
            (memory.teamBias[pickKey] || 0) - 0.004,
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
}
