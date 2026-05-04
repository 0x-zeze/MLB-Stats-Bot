const ODDS_API_URL = 'https://api.the-odds-api.com/v4/sports/baseball_mlb/odds';
const DEFAULT_INTERVAL_MINUTES = 10;
const MONEYLINE_MOVE_THRESHOLD = 15;
const TOTAL_MOVE_THRESHOLD = 0.5;
const MONITOR_TTL_HOURS = 18;
const ALERT_DEDUPE_TTL_HOURS = 18;

const activeMonitors = new Map();
const state = {
  bot: null,
  storage: null,
  config: {}
};

let missingKeyLogged = false;
let oddsCache = {
  fetchedAt: 0,
  data: []
};

function intervalMinutes() {
  const configured = Number(state.config?.lineMonitor?.intervalMinutes);
  if (Number.isFinite(configured) && configured > 0) return configured;

  const envValue = Number.parseInt(process.env.LINE_MONITOR_INTERVAL_MINUTES || '', 10);
  return Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_INTERVAL_MINUTES;
}

function lineAlertsEnabled() {
  const configured = state.config?.lineMonitor?.enabled;
  if (typeof configured === 'boolean') return configured;

  const value = process.env.LINE_MOVEMENT_ALERTS;
  if (value === undefined || value === '') return true;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function chatLineAlertsEnabled(chatId) {
  if (!lineAlertsEnabled()) return false;
  if (!state.storage?.getLineMovementAlerts || chatId === undefined || chatId === null) return true;

  return state.storage.getLineMovementAlerts(chatId).enabled !== false;
}

function moneylineMoveThreshold() {
  const configured = Number(state.config?.lineMonitor?.moneylineThreshold);
  if (Number.isFinite(configured) && configured > 0) return configured;

  const envValue = Number(process.env.LINE_MOVEMENT_THRESHOLD_ML || '');
  return Number.isFinite(envValue) && envValue > 0 ? envValue : MONEYLINE_MOVE_THRESHOLD;
}

function totalMoveThreshold() {
  const configured = Number(state.config?.lineMonitor?.totalThreshold);
  if (Number.isFinite(configured) && configured > 0) return configured;

  const envValue = Number(process.env.LINE_MOVEMENT_THRESHOLD_TOTAL || '');
  return Number.isFinite(envValue) && envValue > 0 ? envValue : TOTAL_MOVE_THRESHOLD;
}

function oddsApiKey() {
  return (
    state.config?.lineMonitor?.oddsApiKey ||
    process.env.ODDS_API_KEY ||
    process.env.THE_ODDS_API_KEY ||
    ''
  );
}

function monitorKey(games, chatId) {
  const gameIds = games
    .map((game) => String(game.gamePk || game.game_id || game.id || ''))
    .filter(Boolean)
    .sort()
    .join(',');
  return `${chatId}:${gameIds}`;
}

function isFinalStatus(status) {
  const value = String(status || '').toLowerCase();
  return (
    value.includes('final') ||
    value.includes('completed') ||
    value.includes('cancelled') ||
    value.includes('canceled') ||
    value.includes('postponed')
  );
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bst\b/g, 'saint')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesMatch(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function findEventForGame(game, events) {
  return events.find((event) => {
    const homeMatches = namesMatch(event.home_team, game.home?.name);
    const awayMatches = namesMatch(event.away_team, game.away?.name);
    return homeMatches && awayMatches;
  });
}

function findOutcome(outcomes, teamName) {
  return outcomes.find((outcome) => namesMatch(outcome.name, teamName));
}

function firstMarket(bookmakers, key) {
  for (const bookmaker of bookmakers || []) {
    const market = (bookmaker.markets || []).find((item) => item.key === key);
    if (market?.outcomes?.length) {
      return { bookmaker, market };
    }
  }

  return null;
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function originalModelEdge(game) {
  const totalEdge = Number(game.totalRuns?.modelEdge);
  if (Number.isFinite(totalEdge)) return totalEdge;

  const agentPickId = game.agentAnalysis?.pickTeamId;
  const isAwayAgentPick = String(agentPickId) === String(game.away?.id);
  const isHomeAgentPick = String(agentPickId) === String(game.home?.id);
  const pick =
    isAwayAgentPick
      ? game.away
      : isHomeAgentPick
        ? game.home
        : game.pick || game.winner;
  const agentProbability =
    isAwayAgentPick
      ? game.agentAnalysis?.awayProbability
      : isHomeAgentPick
        ? game.agentAnalysis?.homeProbability
        : null;
  const pickProbability = Number(agentProbability ?? pick?.winProbability);

  return Number.isFinite(pickProbability) ? pickProbability - 50 : null;
}

function buildSnapshot(game, event) {
  const h2h = firstMarket(event.bookmakers, 'h2h');
  const totals = firstMarket(event.bookmakers, 'totals');
  const homeOutcome = h2h ? findOutcome(h2h.market.outcomes, game.home?.name) : null;
  const awayOutcome = h2h ? findOutcome(h2h.market.outcomes, game.away?.name) : null;
  const overOutcome = totals?.market.outcomes.find((outcome) =>
    String(outcome.name || '').toLowerCase().includes('over')
  );
  const underOutcome = totals?.market.outcomes.find((outcome) =>
    String(outcome.name || '').toLowerCase().includes('under')
  );

  return {
    gamePk: String(game.gamePk || game.game_id || game.id || ''),
    matchup: `${game.away?.name || event.away_team} @ ${game.home?.name || event.home_team}`,
    homeTeam: game.home?.name || event.home_team,
    awayTeam: game.away?.name || event.away_team,
    homeAbbreviation: game.home?.abbreviation || game.home?.name || event.home_team,
    awayAbbreviation: game.away?.abbreviation || game.away?.name || event.away_team,
    homeMoneyline: toFiniteNumber(homeOutcome?.price),
    awayMoneyline: toFiniteNumber(awayOutcome?.price),
    totalLine: toFiniteNumber(overOutcome?.point ?? underOutcome?.point),
    moneylineBook: h2h?.bookmaker?.title || h2h?.bookmaker?.key || 'bookmaker',
    totalBook: totals?.bookmaker?.title || totals?.bookmaker?.key || 'bookmaker',
    originalModelEdge: originalModelEdge(game)
  };
}

async function fetchOdds() {
  if (Date.now() - oddsCache.fetchedAt < 30_000) {
    return oddsCache.data;
  }

  const key = oddsApiKey();
  if (!key) {
    if (!missingKeyLogged) {
      console.warn('Odds API unavailable: ODDS_API_KEY/THE_ODDS_API_KEY belum diisi.');
      missingKeyLogged = true;
    }
    return [];
  }

  const url = new URL(ODDS_API_URL);
  url.searchParams.set('apiKey', key);
  url.searchParams.set('regions', 'us');
  url.searchParams.set('markets', 'h2h,totals');
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'mlb-stats-bot/line-monitor'
      }
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    oddsCache = {
      fetchedAt: Date.now(),
      data
    };
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function attachCurrentOdds(games = []) {
  const activeGames = Array.isArray(games)
    ? games.filter((game) => game?.gamePk && !isFinalStatus(game.status))
    : [];
  const result = {
    checkedGames: activeGames.length,
    matchedGames: 0,
    hasOddsApiKey: Boolean(oddsApiKey())
  };

  if (!activeGames.length) return result;

  const events = await fetchOdds();
  for (const game of activeGames) {
    const event = findEventForGame(game, events);
    if (!event) continue;

    const snapshot = buildSnapshot(game, event);
    game.currentOdds = {
      moneylineBook: snapshot.moneylineBook,
      totalBook: snapshot.totalBook,
      awayMoneyline: snapshot.awayMoneyline,
      homeMoneyline: snapshot.homeMoneyline,
      totalLine: snapshot.totalLine,
      oddsFetchedAt: new Date().toISOString()
    };
    result.matchedGames += 1;
  }

  return result;
}

function formatOdds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '-';
  return parsed > 0 ? `+${parsed}` : String(parsed);
}

function formatSigned(value, decimals = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '-';
  return `${parsed >= 0 ? '+' : ''}${parsed.toFixed(decimals)}`;
}

function americanImpliedProbability(value) {
  const odds = Number(value);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function movementArrow(movement) {
  if (movement.market === 'total') return movement.delta > 0 ? '↗️' : '↘️';

  const previous = americanImpliedProbability(movement.previousValue);
  const current = americanImpliedProbability(movement.currentValue);
  if (!Number.isFinite(previous) || !Number.isFinite(current)) {
    return movement.delta > 0 ? '↗️' : '↘️';
  }

  return current >= previous ? '↗️' : '↘️';
}

function formatOriginalModelEdge(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '';
  return `${formatSigned(parsed, 1)}%`;
}

function formatMovementLine(movement) {
  const arrow = movementArrow(movement);
  if (movement.market === 'total') {
    const action = movement.delta > 0 ? 'sharp over action' : 'sharp under action';
    return `Total: ${movement.oldText} → ${movement.newText} ${arrow} (${action})`;
  }

  return `Moneyline: ${movement.teamLabel} moved from ${movement.oldText} → ${movement.newText} ${arrow}`;
}

function formatMovementAlert({ snapshot, movements }) {
  const edge = formatOriginalModelEdge(snapshot.originalModelEdge);
  return [
    '📊 Line Movement Alert',
    snapshot.matchup,
    ...movements.map(formatMovementLine),
    'This may indicate sharp money.',
    edge ? `Original model edge: ${edge}` : null
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeAlertValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return String(value || '');
  return parsed.toFixed(3);
}

function movementAlertKey(movement, chatId) {
  return [
    'line-move',
    chatId,
    movement.gamePk,
    movement.storageMarket || movement.market,
    movement.bookmaker || '',
    normalizeAlertValue(movement.previousValue),
    normalizeAlertValue(movement.currentValue)
  ].join(':');
}

function reserveMovementAlert(movement, chatId) {
  if (!state.storage?.reserveLineAlert) return true;
  const key = movementAlertKey(movement, chatId);
  return state.storage.reserveLineAlert(key, movement, chatId, new Date().toISOString(), ALERT_DEDUPE_TTL_HOURS);
}

function snapshotFields(snapshot) {
  return [
    {
      market: 'moneyline_home',
      type: 'moneyline',
      teamLabel: snapshot.homeAbbreviation,
      value: snapshot.homeMoneyline,
      threshold: moneylineMoveThreshold(),
      unit: 'cents',
      formatter: formatOdds,
      bookmaker: snapshot.moneylineBook
    },
    {
      market: 'moneyline_away',
      type: 'moneyline',
      teamLabel: snapshot.awayAbbreviation,
      value: snapshot.awayMoneyline,
      threshold: moneylineMoveThreshold(),
      unit: 'cents',
      formatter: formatOdds,
      bookmaker: snapshot.moneylineBook
    },
    {
      market: 'total',
      type: 'total',
      teamLabel: 'Total',
      value: snapshot.totalLine,
      threshold: totalMoveThreshold(),
      unit: 'runs',
      formatter: (value) => Number(value).toFixed(1),
      bookmaker: snapshot.totalBook
    }
  ].filter((field) => Number.isFinite(field.value));
}

async function compareSnapshot(snapshot, chatId, { sendAlerts = true } = {}) {
  const result = {
    initializedCount: 0,
    movements: [],
    alertSent: false,
    alertText: ''
  };

  if (!state.storage) return result;
  const timestamp = new Date().toISOString();

  for (const field of snapshotFields(snapshot)) {
    const previous = state.storage.getLineSnapshot(snapshot.gamePk, field.market);
    state.storage.setLineSnapshot(snapshot.gamePk, field.market, field.value, timestamp);

    if (!previous) {
      result.initializedCount += 1;
      continue;
    }

    const oldValue = Number(previous.value);
    const delta = field.value - oldValue;
    if (!Number.isFinite(delta) || Math.abs(delta) < field.threshold) continue;

    result.movements.push({
      gamePk: snapshot.gamePk,
      matchup: snapshot.matchup,
      market: field.type,
      storageMarket: field.market,
      teamLabel: field.teamLabel,
      oldText: field.formatter(oldValue),
      newText: field.formatter(field.value),
      previousValue: oldValue,
      currentValue: field.value,
      delta,
      unit: field.unit,
      bookmaker: field.bookmaker,
      threshold: field.threshold
    });
  }

  if (result.movements.length > 0 && sendAlerts && state.bot && chatId && chatLineAlertsEnabled(chatId)) {
    const freshMovements = result.movements.filter((movement) => reserveMovementAlert(movement, chatId));
    if (freshMovements.length === 0) {
      console.log(`Line movement alert skipped duplicate ${snapshot.gamePk}.`);
      return result;
    }

    const text = formatMovementAlert({ snapshot, movements: freshMovements });
    result.alertText = text;

    await state.bot.sendMessage(chatId, text).catch((error) => {
      console.error(`Line movement alert gagal ke ${chatId}:`, error.message);
    });
    result.alertSent = true;
    result.movements = freshMovements;
    console.log(`Line movement alert ${snapshot.gamePk}: ${freshMovements.length} move(s).`);
  }

  return result;
}

function stopMonitor(key) {
  const monitor = activeMonitors.get(key);
  if (!monitor) return;
  clearInterval(monitor.timer);
  activeMonitors.delete(key);
}

async function pollMonitor(key) {
  const monitor = activeMonitors.get(key);
  if (!monitor) return;

  if (Date.now() > monitor.expiresAt) {
    stopMonitor(key);
    return;
  }

  const games = monitor.games.filter((game) => !isFinalStatus(game.status));
  if (games.length === 0) {
    stopMonitor(key);
    return;
  }

  const oddsEvents = await fetchOdds();
  if (!oddsEvents.length) return;

  for (const game of games) {
    const event = findEventForGame(game, oddsEvents);
    if (!event) continue;

    const snapshot = buildSnapshot(game, event);
    if (!snapshot.gamePk) continue;
    await compareSnapshot(snapshot, monitor.chatId, { sendAlerts: true });
  }
}

export function configureLineMonitor({ bot, storage, config } = {}) {
  state.bot = bot || state.bot;
  state.storage = storage || state.storage;
  state.config = config || state.config || {};
}

export function startLineMonitor(games, chatId) {
  if (!Array.isArray(games) || games.length === 0 || !chatId) return null;
  if (!chatLineAlertsEnabled(chatId)) return null;
  if (!state.bot || !state.storage) {
    console.warn('Line movement monitor belum dikonfigurasi dengan bot/storage.');
    return null;
  }

  const activeGames = games.filter((game) => game?.gamePk && !isFinalStatus(game.status));
  if (activeGames.length === 0) return null;

  const key = monitorKey(activeGames, chatId);
  const expiresAt = Date.now() + MONITOR_TTL_HOURS * 60 * 60 * 1000;
  const existing = activeMonitors.get(key);
  if (existing) {
    existing.games = activeGames;
    existing.expiresAt = expiresAt;
    return existing;
  }

  const intervalMs = Math.max(1, intervalMinutes()) * 60 * 1000;
  const monitor = {
    chatId,
    games: activeGames,
    expiresAt,
    timer: setInterval(() => {
      pollMonitor(key).catch((error) => {
        console.error('Line movement monitor error:', error.message);
      });
    }, intervalMs)
  };

  monitor.timer.unref?.();
  activeMonitors.set(key, monitor);
  pollMonitor(key).catch((error) => {
    console.error('Line movement monitor error:', error.message);
  });
  console.log(
    `Line movement monitor aktif untuk ${chatId}: ${activeGames.length} game, interval ${intervalMinutes()} menit.`
  );

  return monitor;
}

export function stopLineMonitorForChat(chatId) {
  const target = String(chatId);
  let stopped = 0;

  for (const [key, monitor] of activeMonitors.entries()) {
    if (String(monitor.chatId) !== target) continue;
    stopMonitor(key);
    stopped += 1;
  }

  return stopped;
}

export async function checkLineMovement(games, chatId, { sendAlerts = true } = {}) {
  const activeGames = Array.isArray(games)
    ? games.filter((game) => game?.gamePk && !isFinalStatus(game.status))
    : [];
  const result = {
    checkedGames: activeGames.length,
    matchedGames: 0,
    initializedSnapshots: 0,
    movements: [],
    alertsSent: 0,
    hasOddsApiKey: Boolean(oddsApiKey())
  };

  if (!state.storage) {
    console.warn('Line movement check membutuhkan storage.');
    return result;
  }

  if (!result.hasOddsApiKey || activeGames.length === 0) {
    return result;
  }

  const oddsEvents = await fetchOdds();
  if (!oddsEvents.length) return result;

  for (const game of activeGames) {
    const event = findEventForGame(game, oddsEvents);
    if (!event) continue;

    const snapshot = buildSnapshot(game, event);
    if (!snapshot.gamePk) continue;

    result.matchedGames += 1;
    const comparison = await compareSnapshot(snapshot, chatId, { sendAlerts });
    result.initializedSnapshots += comparison.initializedCount;
    result.alertsSent += comparison.alertSent ? 1 : 0;
    result.movements.push(...comparison.movements);
  }

  return result;
}

export function lineMonitorSettings() {
  return {
    enabled: lineAlertsEnabled(),
    intervalMinutes: intervalMinutes(),
    moneylineThreshold: moneylineMoveThreshold(),
    totalThreshold: totalMoveThreshold(),
    hasOddsApiKey: Boolean(oddsApiKey())
  };
}
