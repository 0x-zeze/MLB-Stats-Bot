const ODDS_API_URL = 'https://api.the-odds-api.com/v4/sports/baseball_mlb/odds';
const DEFAULT_INTERVAL_MINUTES = 10;
const MONEYLINE_MOVE_THRESHOLD = 15;
const TOTAL_MOVE_THRESHOLD = 0.5;
const MONITOR_TTL_HOURS = 18;

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
    homeMoneyline: toFiniteNumber(homeOutcome?.price),
    awayMoneyline: toFiniteNumber(awayOutcome?.price),
    totalLine: toFiniteNumber(overOutcome?.point ?? underOutcome?.point),
    moneylineBook: h2h?.bookmaker?.title || h2h?.bookmaker?.key || 'bookmaker',
    totalBook: totals?.bookmaker?.title || totals?.bookmaker?.key || 'bookmaker'
  };
}

async function fetchOdds() {
  if (Date.now() - oddsCache.fetchedAt < 30_000) {
    return oddsCache.data;
  }

  const key = oddsApiKey();
  if (!key) {
    if (!missingKeyLogged) {
      console.warn('Line movement monitor disabled: ODDS_API_KEY/THE_ODDS_API_KEY belum diisi.');
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

function formatMovementAlert({ snapshot, marketLabel, oldValue, newValue, delta, unit, bookmaker }) {
  return [
    '📈 MLB Line Movement Alert',
    '',
    snapshot.matchup,
    '',
    `Market: ${marketLabel}`,
    `Book: ${bookmaker}`,
    `Move: ${oldValue} → ${newValue}`,
    `Change: ${formatSigned(delta, unit === 'runs' ? 1 : 0)} ${unit}`,
    '',
    'Signal: significant line movement detected.',
    'Note: gunakan sebagai market signal, bukan pick otomatis.'
  ].join('\n');
}

function snapshotFields(snapshot) {
  return [
    {
      market: 'moneyline_home',
      label: `Moneyline ${snapshot.homeTeam}`,
      value: snapshot.homeMoneyline,
      threshold: MONEYLINE_MOVE_THRESHOLD,
      unit: 'cents',
      formatter: formatOdds,
      bookmaker: snapshot.moneylineBook
    },
    {
      market: 'moneyline_away',
      label: `Moneyline ${snapshot.awayTeam}`,
      value: snapshot.awayMoneyline,
      threshold: MONEYLINE_MOVE_THRESHOLD,
      unit: 'cents',
      formatter: formatOdds,
      bookmaker: snapshot.moneylineBook
    },
    {
      market: 'total',
      label: 'Total Runs',
      value: snapshot.totalLine,
      threshold: TOTAL_MOVE_THRESHOLD,
      unit: 'runs',
      formatter: (value) => Number(value).toFixed(1),
      bookmaker: snapshot.totalBook
    }
  ].filter((field) => Number.isFinite(field.value));
}

async function compareAndAlert(snapshot, chatId) {
  if (!state.storage || !state.bot) return;
  const timestamp = new Date().toISOString();

  for (const field of snapshotFields(snapshot)) {
    const previous = state.storage.getLineSnapshot(snapshot.gamePk, field.market);
    state.storage.setLineSnapshot(snapshot.gamePk, field.market, field.value, timestamp);

    if (!previous) continue;

    const oldValue = Number(previous.value);
    const delta = field.value - oldValue;
    if (!Number.isFinite(delta) || Math.abs(delta) < field.threshold) continue;

    const text = formatMovementAlert({
      snapshot,
      marketLabel: field.label,
      oldValue: field.formatter(oldValue),
      newValue: field.formatter(field.value),
      delta,
      unit: field.unit,
      bookmaker: field.bookmaker
    });

    await state.bot.sendMessage(chatId, text).catch((error) => {
      console.error(`Line movement alert gagal ke ${chatId}:`, error.message);
    });
    console.log(
      `Line movement alert ${snapshot.gamePk} ${field.market}: ${oldValue} -> ${field.value}`
    );
  }
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
    await compareAndAlert(snapshot, monitor.chatId);
  }
}

export function configureLineMonitor({ bot, storage, config } = {}) {
  state.bot = bot || state.bot;
  state.storage = storage || state.storage;
  state.config = config || state.config || {};
}

export function startLineMonitor(games, chatId) {
  if (!Array.isArray(games) || games.length === 0 || !chatId) return null;
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
