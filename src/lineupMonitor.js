import { uiBullet, uiKV, uiSection, uiTitle } from './telegramFormat.js';
import { capturePlatoonForGame } from './platoonCapture.js';

const DEFAULT_INTERVAL_MINUTES = 15;
const MONITOR_TTL_HOURS = 12;
const MLB_BASE_URL = 'https://statsapi.mlb.com/api/v1';

const activeMonitors = new Map();
const lineupCache = new Map();
const state = {
  bot: null,
  storage: null,
  config: {}
};

function intervalMinutes() {
  const configured = Number(state.config?.lineupMonitor?.intervalMinutes);
  if (Number.isFinite(configured) && configured > 0) return configured;
  const envValue = Number.parseInt(process.env.LINEUP_MONITOR_INTERVAL_MINUTES || '', 10);
  return Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_INTERVAL_MINUTES;
}

function lineupMonitorEnabled() {
  if (!state.storage) return false;
  const envValue = process.env.LINEUP_MONITOR_ENABLED;
  if (envValue !== undefined && envValue !== '') {
    return ['1', 'true', 'yes', 'on'].includes(String(envValue).toLowerCase());
  }
  return true;
}

function chatLineupAlertsEnabled(chatId) {
  if (!lineupMonitorEnabled()) return false;
  if (!state.storage || chatId === undefined || chatId === null) return true;
  const subscriber = state.storage.getSubscriber?.(chatId);
  return subscriber?.lineupAlerts?.enabled !== false;
}

function isFinalOrLive(status) {
  const value = String(status || '').toLowerCase();
  return (
    value.includes('final') ||
    value.includes('completed') ||
    value.includes('progress') ||
    value.includes('live') ||
    value.includes('cancelled') ||
    value.includes('canceled') ||
    value.includes('postponed')
  );
}

function monitorKey(games, chatId) {
  const gameIds = games
    .map((game) => String(game.gamePk || game.game_id || game.id || ''))
    .filter(Boolean)
    .sort()
    .join(',');
  return `lineup:${chatId}:${gameIds}`;
}

async function fetchBoxscore(gamePk) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${MLB_BASE_URL}/game/${gamePk}/boxscore`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'mlb-stats-bot/lineup-monitor' }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractLineupFromBoxscore(boxTeam) {
  if (!boxTeam) return { confirmed: false, count: 0, batters: [], starter: null };
  const players = Object.values(boxTeam.players || {});
  const hitters = players
    .filter((p) => p?.battingOrder)
    .sort((a, b) => Number.parseInt(a.battingOrder, 10) - Number.parseInt(b.battingOrder, 10));

  const slots = new Map();
  for (const hitter of hitters) {
    const slot = Math.floor(Number.parseInt(hitter.battingOrder, 10) / 100) || Number.parseInt(hitter.battingOrder, 10);
    if (slot >= 1 && slot <= 9 && !slots.has(slot)) {
      slots.set(slot, hitter);
    }
  }

  const ordered = [...slots.entries()].sort(([a], [b]) => a - b).map(([, h]) => h);
  const batters = ordered
    .map((p) => ({
      name: p?.person?.fullName || p?.person?.boxscoreName || '',
      position: p?.position?.abbreviation || ''
    }))
    .filter((b) => b.name);

  // The starting pitcher is the first id in the boxscore team's pitchers array.
  const starterId = Array.isArray(boxTeam.pitchers) ? boxTeam.pitchers[0] : null;
  const starterPlayer = starterId != null ? boxTeam.players?.[`ID${starterId}`] : null;
  const starter = starterPlayer
    ? {
        name: starterPlayer.person?.fullName || starterPlayer.person?.boxscoreName || '',
        hand: starterPlayer.person?.pitchHand?.code || ''
      }
    : null;

  return {
    confirmed: ordered.length >= 9,
    count: ordered.length,
    batters,
    starter: starter && starter.name ? starter : null
  };
}

function cacheKey(gamePk, side) {
  return `${gamePk}:${side}`;
}

function starterText(predictionTeam, boxStarter) {
  // Prefer the prediction's starterLine (carries ERA/WHIP); fall back to the
  // live boxscore starter (name + throwing hand) when the prediction lacks it.
  const line = predictionTeam?.starterLine;
  if (line && !String(line).includes('TBD')) return line;
  if (boxStarter?.name) {
    return boxStarter.hand ? `${boxStarter.name} (${boxStarter.hand}HP)` : boxStarter.name;
  }
  return null;
}

function appendTeamLineup(lines, label, predictionTeam, lineup) {
  if (!lineup?.confirmed) return;
  lines.push(uiKV('📋', `${label}`, `confirmed ${lineup.count}/9`));

  const starter = starterText(predictionTeam, lineup.starter);
  if (starter) lines.push(uiBullet('⚾', `SP: ${starter}`));

  lineup.batters.forEach((batter, index) => {
    const position = batter.position ? ` (${batter.position})` : '';
    lines.push(uiBullet(`${index + 1}.`, `${batter.name}${position}`));
  });
  lines.push('');
}

function formatLineupAlert(game, awayLineup, homeLineup) {
  const away = game.away?.abbreviation || game.away?.name || 'Away';
  const home = game.home?.abbreviation || game.home?.name || 'Home';

  const lines = [uiTitle('📋', `Lineup Confirmed | ${away} @ ${home}`), ''];

  appendTeamLineup(lines, away, game.away, awayLineup);
  appendTeamLineup(lines, home, game.home, homeLineup);

  lines.push(uiBullet('💡', 'Lineup confirmed — prediction quality meningkat.'));

  return lines.join('\n');
}

async function pollLineupMonitor(key) {
  const monitor = activeMonitors.get(key);
  if (!monitor) return;

  if (Date.now() > monitor.expiresAt) {
    stopMonitor(key);
    return;
  }

  const activeGames = monitor.games.filter((game) => !isFinalOrLive(game.status));
  if (activeGames.length === 0) {
    stopMonitor(key);
    return;
  }

  for (const game of activeGames) {
    const gamePk = game.gamePk || game.game_id || game.id;
    if (!gamePk) continue;

    const boxscore = await fetchBoxscore(gamePk);
    if (!boxscore) continue;

    const awayLineup = extractLineupFromBoxscore(boxscore.teams?.away);
    const homeLineup = extractLineupFromBoxscore(boxscore.teams?.home);

    const awayCacheId = cacheKey(gamePk, 'away');
    const homeCacheId = cacheKey(gamePk, 'home');
    const prevAway = lineupCache.get(awayCacheId);
    const prevHome = lineupCache.get(homeCacheId);

    lineupCache.set(awayCacheId, awayLineup);
    lineupCache.set(homeCacheId, homeLineup);

    const awayJustConfirmed = awayLineup.confirmed && (!prevAway || !prevAway.confirmed);
    const homeJustConfirmed = homeLineup.confirmed && (!prevHome || !prevHome.confirmed);

    // Capture player platoon splits the moment a lineup confirms — independent of
    // whether this chat has alerts enabled. Write-once per game; for LATER
    // backtesting, not yet wired into the live probability.
    if ((awayJustConfirmed || homeJustConfirmed) && state.storage) {
      await capturePlatoonForGame(game, boxscore, state.storage).catch((error) => {
        console.warn(`Platoon capture failed for game ${gamePk}:`, error.message);
        return null;
      });
    }

    if (awayJustConfirmed || homeJustConfirmed) {
      if (!state.bot || !chatLineupAlertsEnabled(monitor.chatId)) continue;

      const alertText = formatLineupAlert(game, awayJustConfirmed ? awayLineup : null, homeJustConfirmed ? homeLineup : null);
      await state.bot.sendMessage(monitor.chatId, alertText).catch((error) => {
        console.error(`Lineup alert gagal ke ${monitor.chatId}:`, error.message);
      });
      console.log(`Lineup confirmed alert sent for game ${gamePk} to ${monitor.chatId}.`);
    }
  }
}

function stopMonitor(key) {
  const monitor = activeMonitors.get(key);
  if (!monitor) return;
  clearInterval(monitor.timer);
  activeMonitors.delete(key);
}

export function configureLineupMonitor({ bot, storage, config } = {}) {
  state.bot = bot || state.bot;
  state.storage = storage || state.storage;
  state.config = config || state.config || {};
}

export function startLineupMonitor(games, chatId) {
  if (!Array.isArray(games) || games.length === 0 || !chatId) return null;
  if (!lineupMonitorEnabled()) return null;
  if (!chatLineupAlertsEnabled(chatId)) return null;
  if (!state.bot || !state.storage) return null;

  const activeGames = games.filter((game) => (game.gamePk || game.game_id || game.id) && !isFinalOrLive(game.status));
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
      pollLineupMonitor(key).catch((error) => {
        console.error('Lineup monitor poll error:', error.message);
      });
    }, intervalMs)
  };

  monitor.timer.unref?.();
  activeMonitors.set(key, monitor);
  pollLineupMonitor(key).catch((error) => {
    console.error('Lineup monitor initial poll error:', error.message);
  });
  console.log(`Lineup monitor started for ${chatId}: ${activeGames.length} games, interval ${intervalMinutes()} min.`);

  return monitor;
}

export function stopLineupMonitorForChat(chatId) {
  const target = String(chatId);
  let stopped = 0;
  for (const [key, monitor] of activeMonitors.entries()) {
    if (String(monitor.chatId) !== target) continue;
    stopMonitor(key);
    stopped += 1;
  }
  return stopped;
}

export function lineupMonitorSettings() {
  return {
    enabled: lineupMonitorEnabled(),
    intervalMinutes: intervalMinutes()
  };
}
