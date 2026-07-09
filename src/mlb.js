import {
  clamp,
  dateInTimezone,
  formatGameTime,
  percent,
  safeFixed,
  sigmoid,
  toNumber
} from './utils.js';
import { UI_LINE, UI_THIN_LINE, uiBullet, uiKV, uiSection, uiTitle } from './telegramFormat.js';
import { getEvolutionRule, loadEvolutionControls, moneylineWeightMultiplier } from './evolutionControls.js';
import { calibratePercent, hasCalibrationMap } from './calibration.js';
import { loadConfig } from './config.js';
import { evaluateMoneyline } from './rule_engine.js';

const MLB_BASE_URL = 'https://statsapi.mlb.com/api/v1';
const _mlbConfig = loadConfig();
const MLB_TIMEZONE = _mlbConfig.timezone;
const GAME_SEPARATOR = UI_LINE;
const SECTION_SEPARATOR = UI_THIN_LINE;
const DEFAULT_MONEYLINE_VALUE_EDGE_THRESHOLD = 4.0;
const STRONG_VALUE_EDGE_THRESHOLD = 4.0;
// Calibrated win-probability floor for a graded VALUE bet. Deep analysis of
// 773 moneyline outcomes showed the model is OVERCONFIDENT at high probs:
//   50-55% predicted → 56.8% actual (underconfident ← BEST bucket)
//   55-60% predicted → 52.2% actual (overconfident by 5pp)
//   65-70% predicted → 49.4% actual (overconfident by 18pp!)
// Lowering the floor from 62% to 52% lets the model bet on picks where it
// is slightly above 50% — the range where it is most accurately calibrated.
// The old 62% floor selected for OVERCONFIDENT picks → 37.3% WR on VALUE bets.
const MIN_VALUE_PROBABILITY = 52.0;
// Team quality gate: team must have >= this season win% to qualify for VALUE.
// Picks on teams with .520+ WR: 70.2% historical accuracy.
// Picks on sub-.500 teams: 35.2% accuracy. Market prices them correctly.
const MIN_TEAM_QUALITY_PCT = 0.520;
// Away underdog limit: block VALUE bets on away teams at plus-money odds
// beyond this threshold. Away underdogs are the model's worst leak:
// AWAY+VALUE = 44.9% WR. This kills the away longshot trap.
const MAX_AWAY_UNDERDOG_ODDS = 115;
const OPENER_KEYWORD_RE = /\b(opener|bulk|piggyback)\b|opener\s*\/\s*bulk/i;
const OPENER_NOTE_KEYS = new Set([
  'note',
  'notes',
  'description',
  'summary',
  'role',
  'type',
  'gameNote',
  'gameNotes',
  'probablePitcherNote',
  'probablePitcherNotes'
]);
const PARK_FACTOR_BASELINES = new Map([
  [108, { runFactor: 1.0, homeRunFactor: 1.02, label: 'Angel Stadium' }],
  [109, { runFactor: 1.0, homeRunFactor: 1.02, label: 'Chase Field' }],
  [110, { runFactor: 0.96, homeRunFactor: 0.94, label: 'Camden Yards' }],
  [111, { runFactor: 1.06, homeRunFactor: 0.98, label: 'Fenway Park' }],
  [112, { runFactor: 1.01, homeRunFactor: 1.04, label: 'Wrigley Field' }],
  [113, { runFactor: 1.04, homeRunFactor: 1.14, label: 'Great American Ball Park' }],
  [114, { runFactor: 0.98, homeRunFactor: 0.97, label: 'Progressive Field' }],
  [115, { runFactor: 1.15, homeRunFactor: 1.12, label: 'Coors Field' }],
  [116, { runFactor: 0.98, homeRunFactor: 0.96, label: 'Comerica Park' }],
  [117, { runFactor: 0.99, homeRunFactor: 1.01, label: 'Daikin Park' }],
  [118, { runFactor: 1.02, homeRunFactor: 0.96, label: 'Kauffman Stadium' }],
  [119, { runFactor: 0.99, homeRunFactor: 1.02, label: 'Dodger Stadium' }],
  [120, { runFactor: 1.0, homeRunFactor: 1.0, label: 'Nationals Park' }],
  [121, { runFactor: 0.97, homeRunFactor: 0.98, label: 'Citi Field' }],
  [133, { runFactor: 0.98, homeRunFactor: 0.98, label: 'Athletics home park' }],
  [134, { runFactor: 0.99, homeRunFactor: 0.94, label: 'PNC Park' }],
  [135, { runFactor: 0.96, homeRunFactor: 0.96, label: 'Petco Park' }],
  [136, { runFactor: 0.94, homeRunFactor: 0.95, label: 'T-Mobile Park' }],
  [137, { runFactor: 0.94, homeRunFactor: 0.9, label: 'Oracle Park' }],
  [138, { runFactor: 0.98, homeRunFactor: 0.97, label: 'Busch Stadium' }],
  [139, { runFactor: 0.98, homeRunFactor: 0.99, label: 'Tropicana Field' }],
  [140, { runFactor: 1.02, homeRunFactor: 1.04, label: 'Globe Life Field' }],
  [141, { runFactor: 1.0, homeRunFactor: 1.03, label: 'Rogers Centre' }],
  [142, { runFactor: 0.99, homeRunFactor: 1.0, label: 'Target Field' }],
  [143, { runFactor: 1.03, homeRunFactor: 1.08, label: 'Citizens Bank Park' }],
  [144, { runFactor: 1.01, homeRunFactor: 1.04, label: 'Truist Park' }],
  [145, { runFactor: 1.01, homeRunFactor: 1.05, label: 'Rate Field' }],
  [146, { runFactor: 0.95, homeRunFactor: 0.93, label: 'loanDepot park' }],
  [147, { runFactor: 1.01, homeRunFactor: 1.08, label: 'Yankee Stadium' }],
  [158, { runFactor: 0.99, homeRunFactor: 1.02, label: 'American Family Field' }]
]);
const BALLPARK_YRFI_RATES = new Map([
  ['Coors Field', 0.72],
  ['Great American Ball Park', 0.65],
  ['Globe Life Field', 0.63],
  ['Fenway Park', 0.62],
  ['Wrigley Field', 0.61],
  ['Yankee Stadium', 0.60],
  ['Chase Field', 0.60],
  ['Minute Maid Park', 0.59],
  ['Daikin Park', 0.59],
  ['Citizens Bank Park', 0.59],
  ['American Family Field', 0.58],
  ['Oracle Park', 0.55],
  ['Petco Park', 0.54],
  ['Dodger Stadium', 0.54],
  ['T-Mobile Park', 0.53],
  ['Tropicana Field', 0.53]
]);
const DEFAULT_YRFI_RATE = 0.57;

const DEFAULTS = {
  rpg: 4.4,
  ops: 0.72,
  era: 4.2,
  whip: 1.3,
  winPct: 0.5,
  iso: 0.15,
  kRate: 0.22,
  bbRate: 0.085,
  kMinusBb: 0.12,
  hr9: 1.1,
  // Per-half-inning scoring prior. Empirically a run scores in the 1st in
  // ~55% of games (anyRun), which implies a per-half rate near 0.33 via
  // 1-(1-r)^2 = 0.55. The old 0.26 centered the model at ~45% and made it pick
  // NO ~73% of the time on games that actually scored. See gameFirstInningRunRate.
  firstInningRunRate: 0.33,
  gameFirstInningRunRate: 0.55
};

// --- Situational Weight Adjustment ---
const BASE_WEIGHTS = {
  offense: 0.30,
  starting_pitcher: 0.38,
  bullpen: 0.90,
  recent_form: 0.28,
  home_advantage: 1.0
};
const MAX_WEIGHT_SHIFT = 0.15;

function situationalWeightAdjustment(venueId, openerDetected, gameDateYmd) {
  const parkInfo = PARK_FACTOR_BASELINES.get(venueId);
  const runFactor = parkInfo ? parkInfo.runFactor : 1.0;
  const parkType = runFactor >= 1.05 ? 'hitter_park' : runFactor <= 0.95 ? 'pitcher_park' : 'neutral';
  const month = gameDateYmd ? parseInt(gameDateYmd.slice(5, 7), 10) : 6;
  const phase = month <= 4 ? 'early' : month >= 8 ? 'late' : 'mid';

  const adj = { offense: 0, starting_pitcher: 0, bullpen: 0, recent_form: 0, home_advantage: 0 };

  if (parkType === 'hitter_park') { adj.offense += 0.08; adj.starting_pitcher -= 0.05; }
  else if (parkType === 'pitcher_park') { adj.starting_pitcher += 0.08; adj.offense -= 0.05; }

  if (openerDetected) { adj.starting_pitcher -= 0.12; adj.bullpen += 0.15; }

  if (phase === 'early') { adj.recent_form -= 0.10; adj.starting_pitcher += 0.03; }
  else if (phase === 'late') { adj.recent_form += 0.08; adj.bullpen += 0.05; }

  const multipliers = {};
  for (const key of Object.keys(BASE_WEIGHTS)) {
    const shift = clamp(adj[key] || 0, -MAX_WEIGHT_SHIFT, MAX_WEIGHT_SHIFT);
    multipliers[key] = 1.0 + shift;
  }
  return multipliers;
}

// --- Sharp Money Detection ---
export function detectSharpMoneySignal(modelPick, openingOdds, closingOdds) {
  if (!openingOdds || !closingOdds) return { direction: 'neutral', magnitude: 0, steam: false, risk: 0 };
  const opening = toNumber(openingOdds[modelPick], 0);
  const closing = toNumber(closingOdds[modelPick], 0);
  if (!opening || !closing) return { direction: 'neutral', magnitude: 0, steam: false, risk: 0 };

  const movement = closing - opening;
  const magnitude = Math.abs(movement);
  const direction = magnitude < 3 ? 'neutral' : movement < 0 ? 'toward_model' : 'against_model';
  const steam = magnitude >= 20;

  let risk = 0;
  if (direction === 'against_model') risk += Math.min(magnitude * 0.015, 0.30);
  if (steam && direction === 'against_model') risk += 0.20;
  if (direction === 'toward_model') risk -= Math.min(magnitude * 0.008, 0.15);

  return { direction, magnitude, steam, risk: clamp(risk, 0, 1) };
}

// --- Prediction Tier ---
function determinePredictionTier(gameStartTime) {
  if (!gameStartTime) return { tier: 'standard', label: 'Standard', confidenceCap: 85 };
  const now = new Date();
  const start = new Date(gameStartTime);
  const hoursToGame = Math.max(0, (start - now) / 3600000);

  if (hoursToGame >= 6) return { tier: 'early_preview', label: 'Early Preview', confidenceCap: 60 };
  if (hoursToGame >= 2) return { tier: 'standard', label: 'Standard', confidenceCap: 85 };
  return { tier: 'final', label: 'Final Prediction', confidenceCap: 95 };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'mlb-alert-telegram-agent/0.1'
      }
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function seasonFromDate(dateYmd) {
  return Number.parseInt(dateYmd.slice(0, 4), 10);
}

function seasonStartDate(season) {
  return `${season}-03-01`;
}

function teamMemoryBias(modelMemory, teamId) {
  return clamp(toNumber(modelMemory?.teamBias?.[String(teamId)], 0), -0.08, 0.08);
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

function safeTeamLabel(team) {
  return team?.abbreviation || team?.name || 'team';
}

function buildMatchupMemoryContext(modelMemory, awayTeam, homeTeam) {
  const key = matchupMemoryKey(awayTeam.id, homeTeam.id);
  const entry = modelMemory?.matchupMemory?.[key];
  if (!entry) {
    return {
      key,
      games: 0,
      edge: 0,
      note: 'Belum ada matchup memory tersimpan.',
      recentGames: []
    };
  }

  const recentGames = (entry.recentGames || []).slice(0, 5);
  const weights = [0.03, 0.022, 0.015, 0.01, 0.006];
  let sequenceEdge = 0;
  let missedEdge = 0;

  recentGames.forEach((game, index) => {
    const weight = weights[index] || 0.004;
    const winnerId = String(game.winner?.id || '');
    if (winnerId === String(homeTeam.id)) sequenceEdge += weight;
    if (winnerId === String(awayTeam.id)) sequenceEdge -= weight;

    if (game.correct === false) {
      if (winnerId === String(homeTeam.id)) missedEdge += weight * 0.5;
      if (winnerId === String(awayTeam.id)) missedEdge -= weight * 0.5;
    }
  });

  let edge = sequenceEdge + clamp(missedEdge, -0.03, 0.03);
  const averageMargin = toNumber(entry.averageMargin, 0);
  const alternating = Boolean(entry.alternating);
  const streakLength = Number(entry.currentStreak?.length || 0);

  if (alternating) edge *= 0.45;
  if (averageMargin > 0 && averageMargin <= 1.5) edge *= 0.6;
  if (streakLength >= 3) edge *= 0.8;

  const finalEdge = clamp(edge, -0.08, 0.08);
  const edgeTeam =
    finalEdge > 0.01 ? safeTeamLabel(homeTeam) : finalEdge < -0.01 ? safeTeamLabel(awayTeam) : 'netral';
  const note =
    entry.note ||
    (recentGames.length
      ? `Matchup memory ${recentGames.length} game recent, edge kecil ke ${edgeTeam}.`
      : 'Belum ada matchup memory tersimpan.');

  return {
    key,
    games: entry.totalGames || recentGames.length,
    edge: finalEdge,
    edgeTeam,
    note,
    currentStreak: entry.currentStreak || null,
    alternating,
    averageMargin,
    pickStats: entry.pickStats || { total: 0, correct: 0 },
    recentGames: recentGames.map((game) => ({
      dateYmd: game.dateYmd,
      winner: game.winner,
      loser: game.loser,
      margin: game.margin,
      correct: game.correct
    }))
  };
}

function leagueRecordPct(record) {
  if (!record) return DEFAULTS.winPct;
  if (record.pct !== undefined) return toNumber(record.pct, DEFAULTS.winPct);

  const wins = toNumber(record.wins, 0);
  const losses = toNumber(record.losses, 0);
  const total = wins + losses;
  return total > 0 ? wins / total : DEFAULTS.winPct;
}

function recordText(record) {
  if (!record) return '-';

  const wins = record.wins ?? 0;
  const losses = record.losses ?? 0;
  return `${wins}-${losses}`;
}

function winProbText(team) {
  return `${team.abbreviation || team.name} ${percent(team.winProbability)}`;
}

function displayedProbabilities(item) {
  return {
    away: item.agentAnalysis?.awayProbability ?? item.away.winProbability,
    home: item.agentAnalysis?.homeProbability ?? item.home.winProbability
  };
}

function agentPick(item) {
  if (item.agentAnalysis?.pickTeamId === item.away.id) return item.away;
  if (item.agentAnalysis?.pickTeamId === item.home.id) return item.home;
  return item.winner;
}

function displayedWinProbText(team, value) {
  return `${team.abbreviation || team.name} ${percent(value)}`;
}

function h2hProbText(team, probability) {
  return `${team.abbreviation || team.name} ${percent(probability)}`;
}

function firstInningPickText(firstInning) {
  const pick = firstInning?.agent?.pick || firstInning?.baselinePick || 'NO';
  const probability = firstInning?.agent?.probability ?? firstInning?.baselineProbability ?? 50;
  if (String(pick).toUpperCase() === 'NO BET') {
    // Advisory-only: show the lean as context, framed by confidence.
    const lean = firstInning?.baselineLean || (probability >= 52 ? 'YES' : 'NO');
    return `lean ${lean} ${percent(probability)} (advisory)`;
  }
  const label = pick === 'YES' ? 'YES / YRFI' : 'NO / NRFI';
  return `${label} ${percent(probability)}`;
}

function openerAlertLines(item) {
  return [item.away, item.home]
    .filter((team) => team?.openerSituation?.isOpener)
    .map((team) => {
      const pitcherName = team.starter?.fullName || team.starter?.name || 'Listed pitcher';
      return uiKV('⚠️', 'Opener situation', `${pitcherName} may not be the primary pitcher`);
    });
}

function lateUpdateWarnings(item, { compact = false } = {}) {
  const warnings = [];
  const hasOpener = [item.away, item.home].some((team) => team?.openerSituation?.isOpener);
  const missingStarter = [item.away, item.home].some((team) => {
    const name = team?.starter?.fullName || team?.starter?.name || team?.starterLine || '';
    return !name || String(name).toLowerCase().includes('tbd');
  });
  if (hasOpener) warnings.push('opener/bulk pitcher');
  if (missingStarter) warnings.push('probable pitcher TBD');

  if (!compact) {
    const lineups = [item.lineups?.away, item.lineups?.home].filter(Boolean);
    const incompleteLineup =
      lineups.length < 2 || lineups.some((lineup) => !lineup.confirmed || toNumber(lineup.count, 0) < 9);
    if (incompleteLineup) warnings.push('lineup belum confirmed');
    if (!item.currentOdds?.awayMoneyline || !item.currentOdds?.homeMoneyline) warnings.push('moneyline odds belum lengkap');
  }

  return [...new Set(warnings)].slice(0, compact ? 2 : 5);
}

function lateUpdateLines(item, options = {}) {
  const warnings = lateUpdateWarnings(item, options);
  return warnings.length ? [uiKV('⚠️', 'Late Watch', warnings.join(' | '))] : [];
}

export function formatMoneylineOdds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed === 0) return '-';
  return parsed > 0 ? `+${parsed}` : String(parsed);
}

function americanImpliedProbabilityPercent(value) {
  const odds = Number(value);
  if (!Number.isFinite(odds) || odds === 0) return null;
  const probabilityValue = odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
  return probabilityValue * 100;
}

// Two-sided de-vig: the raw implied probabilities of both moneyline sides sum to
// >100% (the overround / vig the book charges). The fair, no-vig probability for
// each side is its raw implied normalized by the total. Edge must be measured
// against this fair line, not the juiced raw implied — otherwise the vig is
// silently counted against (favorites) or for (underdogs) every pick.
function devigMoneylinePercent(awayOdds, homeOdds) {
  const awayImplied = americanImpliedProbabilityPercent(awayOdds);
  const homeImplied = americanImpliedProbabilityPercent(homeOdds);
  if (awayImplied === null || homeImplied === null) return null;
  const total = awayImplied + homeImplied;
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    away: (awayImplied / total) * 100,
    home: (homeImplied / total) * 100,
    overround: total - 100
  };
}

function round1(value) {
  return Math.round(toNumber(value, 0) * 10) / 10;
}

// American odds → net profit multiple per 1 unit staked (b in the Kelly formula).
// -150 → 0.667 (risk 1 to win 0.667); +130 → 1.30.
function americanProfitMultiple(value) {
  const odds = Number(value);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
}

// Quarter-Kelly stake as a % of bankroll, computed from the pure CALIBRATED
// model probability (not winProbabilityRaw and not market-informed display odds)
// and the offered American odds. Calibration deliberately compresses model
// overconfidence; sizing off raw conviction would re-inflate the edge and
// oversize bets. Quarter-Kelly (fraction 0.25) matches the bot's
// risk_management.py default. Returns null when there is no positive-EV stake.
const KELLY_FRACTION = 0.25;
function quarterKellyPercent(modelProbabilityPercent, odds) {
  const b = americanProfitMultiple(odds);
  if (b === null) return null;
  const p = toNumber(modelProbabilityPercent, 0) / 100;
  if (!(p > 0) || p >= 1) return null;
  const q = 1 - p;
  const fullKelly = (b * p - q) / b;
  if (!(fullKelly > 0)) return null;
  return round1(fullKelly * KELLY_FRACTION * 100);
}

function pureModelProbabilityForSide(item, side) {
  const team = side === 'away' ? item.away : item.home;
  const breakdownProbability = side === 'away'
    ? item.modelBreakdown?.pureAwayProbability
    : item.modelBreakdown?.pureHomeProbability;
  return toNumber(team?.pureModelProbability ?? breakdownProbability ?? team?.winProbability, 50);
}

function moneylineValueOption(item, side) {
  const odds = side === 'away' ? item.currentOdds?.awayMoneyline : item.currentOdds?.homeMoneyline;
  const impliedProbability = americanImpliedProbabilityPercent(odds);
  if (!Number.isFinite(Number(odds)) || impliedProbability === null) return null;

  const team = side === 'away' ? item.away : item.home;
  const modelProbability = pureModelProbabilityForSide(item, side);

  // Edge against the no-vig fair line when both sides are available; otherwise
  // fall back to raw implied (single-sided) so a missing opposite price doesn't
  // drop the option entirely.
  const devig = devigMoneylinePercent(item.currentOdds?.awayMoneyline, item.currentOdds?.homeMoneyline);
  const fairProbability = devig ? (side === 'away' ? devig.away : devig.home) : impliedProbability;
  const edge = modelProbability - fairProbability;

  return {
    side,
    teamId: team?.id,
    teamName: team?.name,
    teamAbbreviation: team?.abbreviation,
    odds,
    book: item.currentOdds?.moneylineBook || 'market',
    modelProbability: round1(modelProbability),
    impliedProbability: round1(impliedProbability),
    fairProbability: round1(fairProbability),
    overround: devig ? round1(devig.overround) : null,
    edge: round1(edge),
    // Quarter-Kelly stake (% of bankroll) off the calibrated model probability
    // and offered odds. null when there is no positive-EV stake.
    kellyStakePercent: edge > 0 ? quarterKellyPercent(modelProbability, odds) : null
  };
}

function moneylineValueEdgeThreshold() {
  const configured = toNumber(loadConfig().minimumMoneylineEdge, 0.04);
  return configured <= 1 ? configured * 100 : configured;
}

function moneylineOddsMaxAgeMinutes() {
  const configured = toNumber(loadConfig().moneylineOddsMaxAgeMinutes, 10);
  return configured > 0 ? configured : 10;
}

function moneylineOddsAgeMinutes(item, now = Date.now()) {
  const timestamp = item?.currentOdds?.oddsFetchedAt || item?.currentOdds?.fetchedAt || item?.currentOdds?.updatedAt;
  const fetchedAt = Date.parse(timestamp || '');
  if (!Number.isFinite(fetchedAt)) return null;
  return Math.max(0, (now - fetchedAt) / 60000);
}

function moneylineOddsFreshnessReason(item, now = Date.now()) {
  const ageMinutes = moneylineOddsAgeMinutes(item, now);
  const maxAgeMinutes = moneylineOddsMaxAgeMinutes();
  if (ageMinutes === null) return 'odds moneyline timestamp tidak tersedia';
  if (ageMinutes > maxAgeMinutes) {
    return `odds moneyline stale ${ageMinutes.toFixed(0)}m > ${maxAgeMinutes.toFixed(0)}m`;
  }
  return '';
}

// Thin adapter over the declarative rule engine (src/rule_engine.js). The
// predicate logic and reason strings now live in data/rules/moneyline_rules.json
// + the JS_HANDLERS registry; this function only assembles the evaluation
// context (host-computed helpers the handlers depend on) and delegates. The
// early return for a missing option is kept here because it precedes any rule
// context. See tests/test_rule_engine_parity.js for the byte-identical contract.
function valueSafetyReasons(item, option, evolutionControls = loadEvolutionControls()) {
  if (!option) return ['odds moneyline belum tersedia'];
  const pickedTeamRecord = option.side === 'home' ? item.home?.record : item.away?.record;
  const ctx = {
    item,
    option,
    evolutionControls,
    edgeThreshold: moneylineValueEdgeThreshold(),
    oddsFreshnessReason: moneylineOddsFreshnessReason(item),
    modelFavoredSide: pureModelProbabilityForSide(item, 'home') >= pureModelProbabilityForSide(item, 'away') ? 'home' : 'away',
    pickedTeamWinPct: leagueRecordPct(pickedTeamRecord),
    getEvolutionRule
  };
  return evaluateMoneyline(ctx);
}

function auditMemoryNotes(item, option, evolutionControls = loadEvolutionControls()) {
  const patterns = Array.isArray(evolutionControls?.memory?.mistake_patterns)
    ? evolutionControls.memory.mistake_patterns
    : [];
  if (patterns.length === 0) return [];

  const notes = [];
  const breakdown = item.modelBreakdown || {};
  const matchupEdge = Math.abs(toNumber(breakdown.matchupEdge, 0));
  const recordContextEdge = Math.abs(toNumber(breakdown.recordContextEdge, 0));
  const starterEdge = Math.abs(toNumber(breakdown.starterEdge, 0));
  const offenseEdge = Math.abs(toNumber(breakdown.offenseEdge, 0));
  const lineupEdge = Math.abs(toNumber(breakdown.lineupEdge, 0));
  const bullpenEdge = Math.abs(toNumber(breakdown.bullpenEdge, 0));
  const modelProbabilityEdge = option ? Math.abs(toNumber(option.modelProbability, 50) - 50) : 0;
  const valueEdge = option ? toNumber(option.edge, 0) : 0;
  const lineups = [item.lineups?.away, item.lineups?.home].filter(Boolean);
  const hasIncompleteLineup = lineups.some((lineup) => !lineup.confirmed || toNumber(lineup.count, 0) < 9);

  for (const pattern of patterns.slice(0, 12)) {
    const type = String(pattern.type || '').toLowerCase();
    const factor = String(pattern.factor || '').toLowerCase();
    const caution = String(pattern.caution || '').trim();
    if (!caution) continue;

    if ((type.includes('weak_edge') || factor.includes('edge:weak') || factor === 'market_edge') && (valueEdge < 1.0 || modelProbabilityEdge < 3) && matchupEdge < 0.05) {
      notes.push(caution);
    } else if ((type === 'record_bias' || factor === 'record_context') && ((breakdown.recordDominated && matchupEdge < 0.18) || (recordContextEdge > matchupEdge * 1.25 && matchupEdge < 0.18))) {
      notes.push(caution);
    } else if (factor === 'starting_pitcher' && starterEdge >= 0.18 && starterEdge > Math.max(offenseEdge, lineupEdge, bullpenEdge)) {
      notes.push(caution);
    } else if (factor === 'lineup' && hasIncompleteLineup) {
      notes.push(caution);
    } else if (factor === 'bullpen' && bullpenEdge >= 0.04) {
      notes.push(caution);
    } else if (type === 'factor_needs_review' && factor === 'unknown') {
      notes.push(caution);
    }
  }

  return [...new Set(notes)].slice(0, 5);
}

export function applyMoneylineValueMarket(item) {
  if (!item) return item;
  const evolutionControls = loadEvolutionControls();

  const options = ['away', 'home']
    .map((side) => moneylineValueOption(item, side))
    .filter(Boolean)
    .sort((left, right) => right.edge - left.edge);
  const best = options[0] || null;
  const reasons = valueSafetyReasons(item, best, evolutionControls);
  const auditAdjustments = reasons.filter((reason) => String(reason).toLowerCase().includes('audit guardrail'));
  const memoryNotes = auditMemoryNotes(item, best, evolutionControls);

  item.valuePick = best;
  item.moneylineValueOptions = options;
  item.auditAdjustments = auditAdjustments;
  item.auditMemoryNotes = memoryNotes;
  item.auditCautions = evolutionControls.memory?.next_game_cautions || [];
  item.activeEvolutionVersions = {
    rule: evolutionControls.activeRuleVersion,
    weights: evolutionControls.activeWeightVersion,
    memory: evolutionControls.memory?.version || 'audit-memory-v1.0'
  };
  item.betDecision = best
    ? {
        market: 'moneyline',
        status: reasons.length ? 'NO BET' : 'VALUE',
        teamId: best.teamId,
        teamName: best.teamName,
        teamAbbreviation: best.teamAbbreviation,
        odds: best.odds,
        book: best.book,
        modelProbability: best.modelProbability,
        impliedProbability: best.impliedProbability,
        edge: best.edge,
        reason: reasons[0] || `model ${best.modelProbability.toFixed(1)}% vs implied ${best.impliedProbability.toFixed(1)}%`,
        reasons,
        auditAdjustments,
        auditMemoryNotes: memoryNotes
      }
    : {
        market: 'moneyline',
        status: 'LEAN ONLY',
        reason: 'odds moneyline belum tersedia',
        reasons,
        auditAdjustments,
        auditMemoryNotes: memoryNotes
      };

  return item;
}

// Confidence band for the picked side, derived purely from the calibrated win
// probability (the only signal shown to discriminate winners). Replaces the old
// VALUE / NO BET / LEAN ONLY status labels in the user-facing output; the
// internal betDecision.status is unchanged and still drives the ledger.
export function confidenceBand(percent) {
  if (percent >= 58) return 'tinggi';
  if (percent >= MIN_VALUE_PROBABILITY) return 'sedang';
  return 'rendah';
}

// The model's own favored side and its calibrated win probability — this is what
// "confidence" means to the reader, independent of which side the edge-based
// value option happens to land on.
function modelPickSide(item) {
  const away = toNumber(item?.away?.winProbability, 0);
  const home = toNumber(item?.home?.winProbability, 0);
  return home >= away
    ? { team: item?.home, percent: home }
    : { team: item?.away, percent: away };
}

function confidenceText(percent) {
  return `${percent.toFixed(1)}% (${confidenceBand(percent)})`;
}

export function moneylineDecisionLines(item) {
  const decision = item?.betDecision;
  if (!decision) return [];

  // A graded bet (cleared the conviction floor): show the actionable priced pick
  // framed by its confidence. By construction the value side is >=62% here.
  if (decision.status === 'VALUE') {
    return [
      uiKV('💰', 'Pick', `${decision.teamName} ${formatMoneylineOdds(decision.odds)} | ${decision.book}`),
      uiKV('🎚️', 'Confidence', `${confidenceText(toNumber(decision.modelProbability, 0))} | edge ${decision.edge >= 0 ? '+' : ''}${toNumber(decision.edge, 0).toFixed(1)}%`)
    ];
  }

  // Below the floor or no odds: show the MODEL's favored side as an advisory
  // lean with its confidence — never dressed up as a recommended bet.
  const model = modelPickSide(item);
  const oddsContext = item.valuePick && Number.isFinite(Number(item.valuePick.odds))
    ? ` | best price ${formatMoneylineOdds(item.valuePick.odds)} ${item.valuePick.book}`
    : '';
  return [
    uiKV('🎚️', 'Confidence', `${model.team?.name || 'lean'} ${confidenceText(model.percent)} (advisory)${oddsContext}`)
  ];
}

function dataQualityText(item) {
  const score = item?.quality?.score;
  const parts = [];
  if (score !== undefined && score !== null) {
    parts.push(`${Math.round(toNumber(score, 0))}/100`);
  } else {
    parts.push('unknown');
  }

  const lineup = item?.quality?.fields?.lineup?.status || item?.lineupStatus;
  const odds = item?.quality?.fields?.odds?.status || (item?.currentOdds ? 'Fresh' : 'Unavailable');
  if (lineup) parts.push(`lineup ${lineup}`);
  if (odds) parts.push(`odds ${odds}`);
  return parts.join(' | ');
}

function bettingSafetyLines(item, pick) {
  const decision = item?.betDecision || {};
  const model = modelPickSide(item);
  const confidence = confidenceText(model.percent);
  const valueText =
    decision.status === 'VALUE'
      ? `${decision.teamName} ${formatMoneylineOdds(decision.odds)} | edge +${toNumber(decision.edge, 0).toFixed(1)}%`
      : `model condong ${model.team?.name || pick?.name || 'TBD'}`;
  return [
    uiKV('🧭', 'Prediction', pick?.name || 'unavailable'),
    uiKV('🏁', 'YRFI/NRFI', firstInningPickText(item?.firstInning)),
    uiKV('💰', 'Value', valueText),
    uiKV('🎯', 'Prediksi', `${model.team?.name || 'TBD'} ${confidence}`),
    uiKV('🧪', 'Data Quality', dataQualityText(item)),
    uiKV('⚠️', 'Risk Warning', 'Analysis only; probabilities are estimates, not guarantees')
  ];
}

function weightSummary(weights) {
  if (!weights || typeof weights !== 'object') return '';
  const labels = {
    starting_pitcher: 'SP',
    sp: 'SP',
    team_strength: 'Log5',
    log5: 'Log5',
    offense: 'Off',
    bullpen: 'BP',
    recent_form: 'Form',
    form: 'Form',
    home_field: 'Home',
    home: 'Home'
  };
  return Object.entries(weights)
    .filter(([, value]) => Number.isFinite(Number(value)))
    .map(([key, value]) => `${labels[key] || key} ${(Number(value) * 100).toFixed(0)}%`)
    .join(' | ');
}

function playerEntryText(entry, valueKey = 'contribution') {
  if (!entry || typeof entry !== 'object') return '';
  const name = entry.name || entry.player || 'Player';
  const value = Number(entry[valueKey]);
  const scoreText = Number.isFinite(value) ? ` ${value >= 0 ? '+' : ''}${value.toFixed(3)}` : '';
  const reason = entry.reason ? ` — ${entry.reason}` : '';
  return `${name}${scoreText}${reason}`;
}

function playerImpactLines(item) {
  const gameMode = item?.game_mode || item?.gameMode || item?.dynamicWeights?.mode;
  const weights = item?.weights_used || item?.weightsUsed || item?.dynamicWeights?.weights;
  const narrative = item?.player_narrative || item?.playerNarrative || item?.player_scores?.narrative || item?.playerScores?.narrative;
  const homeContributors = item?.key_contributors_home || item?.keyContributorsHome || item?.player_scores?.home?.key_contributors || item?.playerScores?.home?.keyContributors || [];
  const awayContributors = item?.key_contributors_away || item?.keyContributorsAway || item?.player_scores?.away?.key_contributors || item?.playerScores?.away?.keyContributors || [];
  const risks = item?.key_risks || item?.keyRisks || [];
  const lines = [];

  if (gameMode) lines.push(uiKV('🎛️', 'Game mode', gameMode));
  const weightText = weightSummary(weights);
  if (weightText) lines.push(uiKV('⚖️', 'Weights', weightText));
  if (Array.isArray(awayContributors) && awayContributors.length) {
    lines.push(uiKV('🧢', item?.away?.abbreviation || item?.away?.name || 'Away', awayContributors.slice(0, 2).map((entry) => playerEntryText(entry)).filter(Boolean).join(' | ')));
  }
  if (Array.isArray(homeContributors) && homeContributors.length) {
    lines.push(uiKV('🏠', item?.home?.abbreviation || item?.home?.name || 'Home', homeContributors.slice(0, 2).map((entry) => playerEntryText(entry)).filter(Boolean).join(' | ')));
  }
  if (Array.isArray(risks) && risks.length) {
    lines.push(uiKV('⚠️', 'Player risks', risks.slice(0, 3).map((entry) => playerEntryText(entry, 'risk')).filter(Boolean).join(' | ')));
  }
  if (narrative) lines.push(uiBullet('•', narrative));

  return lines;
}

function compactPredictionBlock(item) {
  const model = modelPickSide(item);
  return [
    uiKV('🏟️', 'Matchup', `${item.away.name} @ ${item.home.name}`),
    uiKV('🕒', 'Waktu', item.start),
    uiKV('📍', 'Stadium', item.venue),
    uiKV('📊', 'Probabilitas', `${winProbText(item.away)} | ${winProbText(item.home)}`),
    uiKV('✅', 'Pick Model', model.team?.name || item.winner?.name || 'TBD'),
    uiKV('🎯', 'Prediksi', `${model.team?.name || 'TBD'} ${confidenceText(model.percent)}`),
    ...lateUpdateLines(item, { compact: true })
  ].join('\n');
}

function splitInfoLine(value) {
  return String(value || '-')
    .split(' | ')
    .filter(Boolean)
    .map((part) => uiBullet('•', part));
}

function splitRecord(standing, type) {
  return standing?.records?.splitRecords?.find((record) => record.type === type) || null;
}

function expectedRecord(standing) {
  return standing?.records?.expectedRecords?.find((record) => record.type === 'xWinLoss') || null;
}

function splitPct(standing, type) {
  return leagueRecordPct(splitRecord(standing, type));
}

function runDiffPerGame(standing) {
  const games = Math.max(1, toNumber(standing?.gamesPlayed, 1));
  return toNumber(standing?.runDifferential, 0) / games;
}

function firstFiniteNumber(values, fallback) {
  for (const value of values) {
    const parsed = toNumber(value, Number.NaN);
    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function pythagoreanWinPct(standing, profile) {
  const games = Math.max(
    1,
    firstFiniteNumber([standing?.gamesPlayed, profile?.hitting?.gamesPlayed], 1)
  );
  const runsFor = Math.max(
    1,
    firstFiniteNumber([standing?.runsScored, profile?.hitting?.runs], DEFAULTS.rpg * games)
  );
  const runsAgainst = Math.max(
    1,
    firstFiniteNumber([standing?.runsAllowed, profile?.pitching?.runs], DEFAULTS.rpg * games)
  );
  const exponent = 1.83;
  const scoredPower = Math.pow(runsFor, exponent);
  const allowedPower = Math.pow(runsAgainst, exponent);
  return clamp(scoredPower / (scoredPower + allowedPower), 0.25, 0.75);
}

function log5Probability(teamWinPct, opponentWinPct) {
  const team = clamp(toNumber(teamWinPct, DEFAULTS.winPct), 0.05, 0.95);
  const opponent = clamp(toNumber(opponentWinPct, DEFAULTS.winPct), 0.05, 0.95);
  const denominator = team + opponent - 2 * team * opponent;
  if (Math.abs(denominator) < 0.0001) return DEFAULTS.winPct;
  return clamp((team - team * opponent) / denominator, 0.05, 0.95);
}

function signed(value) {
  const parsed = toNumber(value, 0);
  return parsed > 0 ? `+${parsed}` : String(parsed);
}

function ratePct(value, fallback = 0) {
  return `${(toNumber(value, fallback) * 100).toFixed(1)}%`;
}

function parseInnings(value) {
  if (value === null || value === undefined || value === '') return 0;
  const [whole, partial = '0'] = String(value).split('.');
  const wholeNum = Number.parseInt(whole, 10);
  const partialNum = Number.parseInt(partial, 10);
  const safeWhole = Number.isFinite(wholeNum) ? wholeNum : 0;
  const safePartial = Number.isFinite(partialNum) ? partialNum : 0;
  const outs = safeWhole * 3 + safePartial;
  return outs / 3;
}

function ymdOffset(dateYmd, offsetDays) {
  const date = new Date(`${dateYmd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function firstInningHistoryEndDate(dateYmd) {
  return ymdOffset(dateYmd, -1);
}

function ymdDiff(laterYmd, earlierYmd) {
  const later = new Date(`${laterYmd}T00:00:00Z`);
  const earlier = new Date(`${earlierYmd}T00:00:00Z`);
  return Math.round((later.getTime() - earlier.getTime()) / 86_400_000);
}

function splitRecordText(record) {
  return record ? `${record.wins}-${record.losses} (${safeFixed(toNumber(record.pct, 0) * 100, 0)}%)` : '-';
}

function compactText(value, maxLength = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
}

function gamesPlayed(stat) {
  return Math.max(1, toNumber(stat?.gamesPlayed, 1));
}

function rpg(stat) {
  return toNumber(stat?.runs, DEFAULTS.rpg * gamesPlayed(stat)) / gamesPlayed(stat);
}

function statOps(stat) {
  return toNumber(stat?.ops, DEFAULTS.ops);
}

function statEra(stat) {
  return toNumber(stat?.era, DEFAULTS.era);
}

function statWhip(stat) {
  return toNumber(stat?.whip, DEFAULTS.whip);
}

function kToBb(stat) {
  const strikeouts = toNumber(stat?.strikeOuts, 0);
  const walks = toNumber(stat?.baseOnBalls, 0);
  if (strikeouts <= 0 && walks <= 0) return 2.2;
  return strikeouts / Math.max(1, walks);
}

function statIso(stat) {
  return toNumber(stat?.iso, DEFAULTS.iso);
}

function battingKRate(stat) {
  return toNumber(stat?.strikeoutsPerPlateAppearance, DEFAULTS.kRate);
}

function battingBbRate(stat) {
  return toNumber(stat?.walksPerPlateAppearance, DEFAULTS.bbRate);
}

function pitchingKMinusBb(stat) {
  return toNumber(stat?.strikeoutsMinusWalksPercentage, DEFAULTS.kMinusBb);
}

function pitchingHr9(stat) {
  return toNumber(stat?.homeRunsPer9, DEFAULTS.hr9);
}

function pitcherLabel(pitcher, stats) {
  if (!pitcher?.fullName) return 'TBD';
  const hand = pitcher.pitchHand?.code ? `${pitcher.pitchHand.code}HP ` : '';
  if (!stats) return `${pitcher.fullName} ${hand}`.trim();
  return `${pitcher.fullName} ${hand}ERA ${safeFixed(stats.era)} WHIP ${safeFixed(stats.whip)}`;
}

function normalizedKey(value) {
  return String(value || '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
}

function collectOpenerNoteText(value, parentKey = '') {
  if (!value) return [];
  if (typeof value === 'string') {
    return OPENER_NOTE_KEYS.has(parentKey) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectOpenerNoteText(item, parentKey));
  }
  if (typeof value !== 'object') return [];

  const lines = [];
  for (const [key, nested] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    const isNoteKey =
      OPENER_NOTE_KEYS.has(key) ||
      OPENER_NOTE_KEYS.has(normalized) ||
      /note|description|summary|role|type/i.test(key);
    if (typeof nested === 'string' && isNoteKey) {
      lines.push(nested);
    } else if (nested && typeof nested === 'object') {
      lines.push(...collectOpenerNoteText(nested, isNoteKey ? normalized : parentKey));
    }
  }
  return lines;
}

function pitcherRoleFromText(text) {
  const lowered = String(text || '').toLowerCase();
  if (lowered.includes('bulk') && !lowered.includes('opener')) return 'bulk';
  if (OPENER_KEYWORD_RE.test(lowered)) return 'opener';
  return 'starter';
}

function pitcherStartRatio(stats) {
  const gamesStarted = toNumber(stats?.gamesStarted ?? stats?.starts, Number.NaN);
  const appearances = toNumber(
    stats?.gamesPitched ?? stats?.appearances ?? stats?.games,
    Number.NaN
  );
  if (!Number.isFinite(gamesStarted) || !Number.isFinite(appearances) || appearances <= 0) {
    return null;
  }
  return clamp(gamesStarted / appearances, 0, 1);
}

function detectOpenerSituation(game, side, pitcher, stats) {
  const teamEntry = game?.teams?.[side] || {};
  const noteText = [
    ...collectOpenerNoteText(game),
    ...collectOpenerNoteText(teamEntry),
    ...collectOpenerNoteText(pitcher)
  ].join(' ');
  const noteMatch = OPENER_KEYWORD_RE.test(noteText);
  const startRatio = pitcherStartRatio(stats);
  const appearances = toNumber(stats?.gamesPitched ?? stats?.appearances ?? stats?.games, 0);
  const lowStartShare = startRatio !== null && startRatio < 0.3 && appearances >= 10;

  if (noteMatch) {
    return {
      isOpener: true,
      pitcherRole: pitcherRoleFromText(noteText),
      confidence: lowStartShare ? 'high' : 'medium',
      careerGsPct: startRatio,
      note: noteText.trim()
    };
  }

  if (lowStartShare) {
    return {
      isOpener: true,
      pitcherRole: 'opener',
      confidence: 'medium',
      careerGsPct: startRatio,
      note: 'Career GS% below opener threshold.'
    };
  }

  return {
    isOpener: false,
    pitcherRole: 'starter',
    confidence: 'low',
    careerGsPct: startRatio
  };
}

function effectivePitcherStats(stats, openerSituation) {
  return openerSituation?.isOpener ? null : stats;
}

function getTeamStatMap(statsData) {
  const teams = new Map();

  for (const block of statsData.stats || []) {
    const group = block.group?.displayName?.toLowerCase();
    if (!group) continue;

    for (const split of block.splits || []) {
      const teamId = split.team?.id;
      if (!teamId) continue;

      if (!teams.has(teamId)) {
        teams.set(teamId, {
          team: split.team,
          hitting: null,
          hittingAdvanced: null,
          pitching: null,
          pitchingAdvanced: null
        });
      }

      const profile = teams.get(teamId);
      const type = block.type?.displayName;
      if (group === 'hitting' && type === 'season') profile.hitting = split.stat;
      if (group === 'hitting' && type === 'seasonAdvanced') profile.hittingAdvanced = split.stat;
      if (group === 'pitching' && type === 'season') profile.pitching = split.stat;
      if (group === 'pitching' && type === 'seasonAdvanced') profile.pitchingAdvanced = split.stat;
    }
  }

  return teams;
}

function getStandingMap(standingsData) {
  const teams = new Map();

  for (const division of standingsData.records || []) {
    for (const teamRecord of division.teamRecords || []) {
      if (teamRecord.team?.id) {
        teams.set(teamRecord.team.id, teamRecord);
      }
    }
  }

  return teams;
}

async function fetchRecentTeamGames(teamIds, dateYmd, daysBack = 3) {
  const params = new URLSearchParams({
    sportId: '1',
    gameTypes: 'R',
    startDate: ymdOffset(dateYmd, -daysBack),
    endDate: ymdOffset(dateYmd, -1),
    hydrate: 'team'
  });

  const idSet = new Set(teamIds);
  const data = await fetchJson(`${MLB_BASE_URL}/schedule?${params}`);
  return (data.dates || [])
    .flatMap((date) => date.games || [])
    .filter((game) => game.status?.abstractGameState === 'Final')
    .filter((game) => idSet.has(game.teams.away.team.id) || idSet.has(game.teams.home.team.id));
}

async function fetchScheduleFatigueProfiles(teamIds, dateYmd) {
  const profiles = new Map(teamIds.map((teamId) => [teamId, finalizeScheduleFatigueProfile(teamId, [], dateYmd)]));
  const games = await fetchRecentTeamGames(teamIds, dateYmd, 10);

  for (const teamId of teamIds) {
    const teamGames = games
      .filter((game) => game.teams.away.team.id === teamId || game.teams.home.team.id === teamId)
      .map((game) => ({
        date: game.officialDate || String(game.gameDate || '').slice(0, 10),
        side: game.teams.away.team.id === teamId ? 'away' : 'home'
      }))
      .filter((game) => game.date);
    profiles.set(teamId, finalizeScheduleFatigueProfile(teamId, teamGames, dateYmd));
  }

  return profiles;
}

function finalizeScheduleFatigueProfile(teamId, games, dateYmd) {
  const sorted = [...games].sort((left, right) => String(right.date).localeCompare(String(left.date)));
  const lastGame = sorted[0] || null;
  const restDays = lastGame ? Math.max(0, ymdDiff(dateYmd, lastGame.date) - 1) : 10;
  const dateCounts = new Map();
  for (const game of sorted.filter((item) => ymdDiff(dateYmd, item.date) <= 3)) {
    dateCounts.set(game.date, (dateCounts.get(game.date) || 0) + 1);
  }
  const doubleheaderLast3Days = [...dateCounts.values()].some((count) => count >= 2);

  let roadStreak = 0;
  for (const game of sorted) {
    if (game.side !== 'away') break;
    roadStreak += 1;
  }

  let fatiguePoints = 0;
  if (sorted.length >= 9) fatiguePoints += 2;
  else if (sorted.length >= 7) fatiguePoints += 1;
  if (doubleheaderLast3Days) fatiguePoints += 1;
  if (roadStreak >= 7) fatiguePoints += 2;
  else if (roadStreak >= 4) fatiguePoints += 1;
  if (restDays === 0) fatiguePoints += 1;
  const fatigueLevel = fatiguePoints >= 3 ? 'high' : fatiguePoints >= 1 ? 'medium' : 'low';

  return {
    teamId,
    restDays,
    roadStreak,
    recentGameCount: sorted.length,
    doubleheaderLast3Days,
    fatigueLevel,
    offenseAdjustment: doubleheaderLast3Days ? -0.05 : 0,
    teamAdjustment: roadStreak >= 7 ? -0.03 : 0,
    line: `${sorted.length}G last 10d, rest ${restDays}d, road streak ${roadStreak}, fatigue ${fatigueLevel}${doubleheaderLast3Days ? ', doubleheader flag' : ''}`
  };
}

function pitcherRestProfile(pitcher, recentStarts, dateYmd) {
  if (!pitcher) {
    return {
      pitcher: 'TBD',
      restDays: null,
      multiplier: 1,
      flag: 'SP rest unavailable'
    };
  }

  const lastStartDate = recentStarts?.lastStartDate || '';
  const rawRestDays = lastStartDate ? Math.max(0, ymdDiff(dateYmd, lastStartDate) - 1) : null;
  const restDays = rawRestDays !== null && rawRestDays <= 30 ? rawRestDays : null;
  const multiplier = restDays === null ? 1 : restDays <= 3 ? 0.85 : restDays >= 6 ? 0.93 : 1;
  const label =
    restDays === null
      ? 'SP rest unavailable'
      : restDays <= 3
        ? `${pitcher.fullName} short rest ${restDays}d`
        : restDays >= 6
          ? `${pitcher.fullName} long rest ${restDays}d`
          : `${pitcher.fullName} normal rest ${restDays}d`;

  return {
    pitcher: pitcher.fullName,
    restDays,
    multiplier,
    flag: label
  };
}

function scheduleFatigueEdge(homeFatigue, awayFatigue, homeRest, awayRest) {
  const homePenalty =
    Math.abs(toNumber(homeFatigue.offenseAdjustment, 0)) +
    Math.abs(toNumber(homeFatigue.teamAdjustment, 0)) +
    (toNumber(homeRest.multiplier, 1) < 1 ? (1 - toNumber(homeRest.multiplier, 1)) * 0.25 : 0);
  const awayPenalty =
    Math.abs(toNumber(awayFatigue.offenseAdjustment, 0)) +
    Math.abs(toNumber(awayFatigue.teamAdjustment, 0)) +
    (toNumber(awayRest.multiplier, 1) < 1 ? (1 - toNumber(awayRest.multiplier, 1)) * 0.25 : 0);
  return clamp(awayPenalty - homePenalty, -0.08, 0.08);
}

function fatigueFlagLines(away, home, awaySchedule, homeSchedule, awayRest, homeRest) {
  const lines = [
    `${away.abbreviation || away.name} schedule ${awaySchedule.line}`,
    `${home.abbreviation || home.name} schedule ${homeSchedule.line}`
  ];

  for (const [team, schedule] of [
    [away, awaySchedule],
    [home, homeSchedule]
  ]) {
    if (schedule.doubleheaderLast3Days) {
      lines.push(`${team.abbreviation || team.name} doubleheader in last 3 days: offense fatigue flag`);
    }
    if (schedule.roadStreak >= 7) {
      lines.push(`${team.abbreviation || team.name} ${schedule.roadStreak}-game road streak: team fatigue flag`);
    }
  }

  for (const rest of [awayRest, homeRest]) {
    if (rest.restDays !== null && (rest.restDays < 4 || rest.restDays >= 6)) {
      lines.push(rest.flag);
    }
  }

  return lines;
}

async function fetchBoxscore(gamePk) {
  return fetchJson(`${MLB_BASE_URL}/game/${gamePk}/boxscore`);
}

async function fetchLiveFeed(gamePk) {
  return fetchJson(`${MLB_BASE_URL}/game/${gamePk}/feed/live`);
}

function lineupPlayerName(player) {
  return player?.person?.fullName || player?.person?.displayName || player?.person?.boxscoreName || null;
}

function battingOrderSlot(player) {
  const raw = Number.parseInt(player?.battingOrder, 10);
  if (!Number.isFinite(raw)) return 99;
  return Math.floor(raw / 100) || raw;
}

function hitterBattingStats(player) {
  return (
    player?.seasonStats?.batting ||
    player?.stats?.batting ||
    player?.stat?.batting ||
    player?.batting ||
    {}
  );
}

function firstStatNumber(stats, keys, fallback = 0) {
  for (const key of keys) {
    const value = stats?.[key];
    if (value === undefined || value === null || value === '') continue;
    const parsed = toNumber(value, Number.NaN);
    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function hitterLineupScore(player, slot) {
  const stats = hitterBattingStats(player);
  const plateAppearances = firstStatNumber(stats, ['plateAppearances', 'pa'], 0);
  const atBats = firstStatNumber(stats, ['atBats', 'ab'], 0);
  const known = plateAppearances >= 25 || atBats >= 25 || stats.ops !== undefined || stats.onBasePercentage !== undefined;
  if (!known) return { value: 0, known: false };

  const ops = firstStatNumber(stats, ['ops'], DEFAULTS.ops);
  const obp = firstStatNumber(stats, ['obp', 'onBasePercentage'], 0.32);
  const slg = firstStatNumber(stats, ['slg', 'sluggingPercentage'], 0.4);
  const homeRuns = firstStatNumber(stats, ['homeRuns', 'hr'], 0);
  const sample = Math.max(plateAppearances, atBats, 1);
  const powerPerPa = homeRuns / sample;
  const slotWeight = slot <= 2 ? 1.18 : slot <= 5 ? 1.08 : slot <= 7 ? 0.92 : 0.78;
  const score =
    ((ops - DEFAULTS.ops) / 0.22) * 0.075 +
    ((obp - 0.32) / 0.08) * 0.035 +
    ((slg - 0.4) / 0.14) * 0.035 +
    ((powerPerPa - 0.035) / 0.035) * 0.02;

  return {
    value: clamp(score * slotWeight, -0.16, 0.18),
    known: true
  };
}

function extractLineupProfile(boxTeam) {
  const players = Object.values(boxTeam?.players || {});
  const hitters = players
    .filter((player) => player?.battingOrder)
    .sort((a, b) => Number.parseInt(a.battingOrder, 10) - Number.parseInt(b.battingOrder, 10));
  const slots = new Map();

  for (const hitter of hitters) {
    const slot = battingOrderSlot(hitter);
    if (slot >= 1 && slot <= 9 && !slots.has(slot)) {
      slots.set(slot, hitter);
    }
  }

  const orderedHitters = [...slots.entries()]
    .sort(([slotA], [slotB]) => slotA - slotB)
    .map(([, hitter]) => hitter);
  const topFive = orderedHitters
    .slice(0, 5)
    .map(lineupPlayerName)
    .filter(Boolean);
  const leadoffStats = hitterBattingStats(orderedHitters[0]);
  const leadoffObpValue = orderedHitters[0]
    ? firstStatNumber(leadoffStats, ['obp', 'onBasePercentage'], Number.NaN)
    : Number.NaN;
  const hitterScores = orderedHitters.map((hitter, index) => hitterLineupScore(hitter, index + 1));
  const knownStatCount = hitterScores.filter((score) => score.known).length;
  const weightedScore =
    knownStatCount >= 4
      ? hitterScores.reduce((sum, score) => sum + score.value, 0) / Math.max(1, orderedHitters.length)
      : 0;

  return {
    confirmed: orderedHitters.length >= 9,
    count: orderedHitters.length,
    topFive,
    leadoffObp: Number.isFinite(leadoffObpValue) ? leadoffObpValue : null,
    knownStatCount,
    qualityScore: clamp(weightedScore, -0.12, 0.12)
  };
}

async function fetchGameLineupProfile(gamePk) {
  const boxscore = await fetchBoxscore(gamePk);

  return {
    away: extractLineupProfile(boxscore.teams?.away),
    home: extractLineupProfile(boxscore.teams?.home)
  };
}

async function fetchBullpenProfiles(teamIds, dateYmd) {
  const profiles = new Map(
    teamIds.map((teamId) => [
      teamId,
      {
        teamId,
        games: 0,
        bullpenPitches: 0,
        bullpenOuts: 0,
        relieverAppearances: 0,
        relieverDates: new Map(),
        highPitchRelievers: 0
      }
    ])
  );
  const games = await fetchRecentTeamGames(teamIds, dateYmd, 3);

  const MAX_CONCURRENT = 5;
  const queue = [...games];
  const results = [];
  async function runNext() {
    while (queue.length) {
      const game = queue.shift();
      let boxscore;
      try {
        boxscore = await fetchBoxscore(game.gamePk);
      } catch {
        continue;
      }

      for (const side of ['away', 'home']) {
        const team = game.teams[side].team;
        const profile = profiles.get(team.id);
        if (!profile) continue;

        profile.games += 1;
        const boxTeam = boxscore.teams?.[side];
        for (const personId of boxTeam?.pitchers || []) {
          const player = boxTeam.players?.[`ID${personId}`];
          const stats = player?.stats?.pitching || {};
          if (toNumber(stats.gamesStarted, 0) > 0) continue;

          const pitches = toNumber(stats.numberOfPitches, 0);
          profile.bullpenPitches += pitches;
          profile.bullpenOuts += Math.round(parseInnings(stats.inningsPitched) * 3);
          profile.relieverAppearances += 1;
          if (pitches >= 25) profile.highPitchRelievers += 1;

          const key = String(personId);
          if (!profile.relieverDates.has(key)) profile.relieverDates.set(key, new Set());
          profile.relieverDates.get(key).add(game.officialDate || game.gameDate);
        }
      }
    }
  }
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, games.length) }, () => runNext());
  await Promise.all(workers);

  for (const [teamId, profile] of profiles.entries()) {
    profiles.set(teamId, finalizeBullpenProfile(profile));
  }

  return profiles;
}

function finalizeBullpenProfile(profile) {
  const backToBackRelievers = [...profile.relieverDates.values()].filter((dates) => dates.size >= 2).length;
  const innings = profile.bullpenOuts / 3;
  const fatigueScore =
    profile.bullpenPitches / 120 +
    backToBackRelievers * 0.2 +
    profile.highPitchRelievers * 0.12 +
    Math.max(0, profile.games - 2) * 0.15;
  const level = fatigueScore >= 1.7 ? 'high' : fatigueScore >= 0.9 ? 'medium' : 'low';

  return {
    teamId: profile.teamId,
    games: profile.games,
    bullpenPitches: profile.bullpenPitches,
    bullpenInnings: innings,
    relieverAppearances: profile.relieverAppearances,
    backToBackRelievers,
    highPitchRelievers: profile.highPitchRelievers,
    fatigueScore,
    level,
    line: `${profile.games}G last 3d, ${Math.round(profile.bullpenPitches)} pitches, ${safeFixed(innings, 1)} IP, B2B relievers ${backToBackRelievers}, fatigue ${level}`
  };
}

async function fetchSchedule(dateYmd) {
  const params = new URLSearchParams({
    sportId: '1',
    date: dateYmd,
    gameTypes: 'R',
    hydrate: 'probablePitcher,team,venue,weather,linescore'
  });

  const data = await fetchJson(`${MLB_BASE_URL}/schedule?${params}`);
  const allGames = (data.dates || []).flatMap((date) => date.games || []);
  const seen = new Set();
  return allGames.filter((game) => {
    if (seen.has(game.gamePk)) return false;
    seen.add(game.gamePk);
    return true;
  });
}

function injuryTransactionStartDate(season) {
  return `${season}-01-01`;
}

function injuryNoteFromTransaction(description) {
  const text = compactText(description, 220);
  if (!text) return '';

  const injuredListMatch = text.match(/injured list(?: retroactive to [^.]+)?\.\s*(.+)$/i);
  if (injuredListMatch?.[1]) return compactText(injuredListMatch[1], 120);

  const transferredMatch = text.match(/transferred .* injured list\.\s*(.+)$/i);
  if (transferredMatch?.[1]) return compactText(transferredMatch[1], 120);

  return compactText(text, 120);
}

async function fetchTeamInjuryProfile(teamId, dateYmd, season) {
  const rosterParams = new URLSearchParams({
    rosterType: '40Man',
    date: dateYmd
  });
  const transactionParams = new URLSearchParams({
    teamId: String(teamId),
    startDate: injuryTransactionStartDate(season),
    endDate: dateYmd
  });

  const [rosterData, transactionData] = await Promise.all([
    fetchJson(`${MLB_BASE_URL}/teams/${teamId}/roster?${rosterParams}`),
    fetchJson(`${MLB_BASE_URL}/transactions?${transactionParams}`)
  ]);

  const latestInjuryTransactions = new Map();
  for (const transaction of transactionData.transactions || []) {
    const personId = transaction.person?.id;
    const description = transaction.description || '';
    if (!personId || !/injured list|injury|injured/i.test(description)) continue;

    latestInjuryTransactions.set(personId, {
      date: transaction.date || '',
      description,
      note: injuryNoteFromTransaction(description)
    });
  }

  return (rosterData.roster || [])
    .filter((item) => /injured/i.test(item.status?.description || ''))
    .map((item) => {
      const latest = latestInjuryTransactions.get(item.person?.id) || null;
      return {
        id: item.person?.id,
        name: item.person?.fullName || 'Unknown player',
        position: item.position?.abbreviation || item.position?.name || '-',
        status: item.status?.description || 'Injured',
        note: latest?.note || '',
        transactionDate: latest?.date || ''
      };
    })
    .sort((a, b) => {
      const statusSort = String(a.status).localeCompare(String(b.status));
      return statusSort || String(a.name).localeCompare(String(b.name));
    });
}

async function fetchInjuryProfiles(teamIds, dateYmd, season) {
  const injuries = new Map();

  await Promise.all(
    teamIds.map(async (teamId) => {
      try {
        injuries.set(teamId, await fetchTeamInjuryProfile(teamId, dateYmd, season));
      } catch {
        injuries.set(teamId, []);
      }
    })
  );

  return injuries;
}

async function fetchTeamStats(season) {
  const params = new URLSearchParams({
    season: String(season),
    stats: 'season,seasonAdvanced',
    group: 'hitting,pitching',
    sportIds: '1',
    gameType: 'R'
  });

  return getTeamStatMap(await fetchJson(`${MLB_BASE_URL}/teams/stats?${params}`));
}

async function fetchStandings(season, dateYmd) {
  const params = new URLSearchParams({
    leagueId: '103,104',
    season: String(season),
    standingsTypes: 'regularSeason',
    date: dateYmd
  });

  return getStandingMap(await fetchJson(`${MLB_BASE_URL}/standings?${params}`));
}

const firstInningProfileCache = new Map();

async function fetchFirstInningProfiles(season, dateYmd) {
  // Cutoff is always dateYmd-1 and only Final games are included, so the result
  // is immutable per (season, date) — memoize to avoid refetching ~2 boxscore +
  // live-feed calls per league game (~2000 MLB API calls) on every prediction.
  const cacheKey = `${season}:${dateYmd}`;
  const cached = firstInningProfileCache.get(cacheKey);
  if (cached) return cached;

  const result = await buildFirstInningProfiles(season, dateYmd);
  firstInningProfileCache.set(cacheKey, result);
  return result;
}

async function buildFirstInningProfiles(season, dateYmd) {
  const params = new URLSearchParams({
    sportId: '1',
    season: String(season),
    gameTypes: 'R',
    startDate: seasonStartDate(season),
    endDate: firstInningHistoryEndDate(dateYmd),
    hydrate: 'linescore,team'
  });

  const data = await fetchJson(`${MLB_BASE_URL}/schedule?${params}`);
  const profiles = new Map();
  const pitcherProfiles = new Map();
  const games = (data.dates || [])
    .flatMap((date) => date.games || [])
    .filter((game) => game.status?.abstractGameState === 'Final')
    .filter((game) => game.linescore?.innings?.[0]);

  for (const game of games) {
    addFirstInningGame(profiles, game, game.teams.away.team, 'away');
    addFirstInningGame(profiles, game, game.teams.home.team, 'home');
  }

  const MAX_CONCURRENT = 5;
  const queue = [...games];
  async function runNext() {
    while (queue.length) {
      const game = queue.shift();
      let boxscore;
      let liveFeed;
      try {
        [boxscore, liveFeed] = await Promise.all([fetchBoxscore(game.gamePk), fetchLiveFeed(game.gamePk)]);
      } catch {
        continue;
      }

      addPitcherFirstInningGame(pitcherProfiles, game, boxscore, liveFeed, 'home');
      addPitcherFirstInningGame(pitcherProfiles, game, boxscore, liveFeed, 'away');
    }
  }
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, games.length) }, () => runNext());
  await Promise.all(workers);

  for (const [teamId, profile] of profiles.entries()) {
    profiles.set(teamId, finalizeFirstInningProfile(profile));
  }
  for (const [pitcherId, profile] of pitcherProfiles.entries()) {
    pitcherProfiles.set(pitcherId, finalizePitcherFirstInningProfile(profile));
  }

  profiles.pitchers = pitcherProfiles;
  return profiles;
}

async function fetchPitcherStats(personId, season) {
  if (!personId) return null;

  const params = new URLSearchParams({
    stats: 'season',
    group: 'pitching',
    season: String(season),
    gameType: 'R'
  });

  const data = await fetchJson(`${MLB_BASE_URL}/people/${personId}/stats?${params}`);
  return data.stats?.[0]?.splits?.[0]?.stat || null;
}

async function fetchPerson(personId) {
  if (!personId) return null;
  const data = await fetchJson(`${MLB_BASE_URL}/people/${personId}`);
  return data.people?.[0] || null;
}

async function fetchPitcherRecentStarts(personId, season, limit = 5) {
  if (!personId) return null;

  const params = new URLSearchParams({
    stats: 'gameLog',
    group: 'pitching',
    season: String(season),
    gameType: 'R'
  });
  const data = await fetchJson(`${MLB_BASE_URL}/people/${personId}/stats?${params}`);
  const starts = (data.stats?.[0]?.splits || [])
    .filter((split) => toNumber(split.stat?.gamesStarted, 0) > 0)
    .slice(-limit);

  return summarizePitcherStarts(starts);
}

function summarizePitcherStarts(starts) {
  if (!starts || starts.length === 0) {
    return {
      games: 0,
      line: 'recent starts unavailable'
    };
  }

  const innings = starts.reduce((sum, split) => sum + parseInnings(split.stat?.inningsPitched), 0);
  const earnedRuns = starts.reduce((sum, split) => sum + toNumber(split.stat?.earnedRuns, 0), 0);
  const hits = starts.reduce((sum, split) => sum + toNumber(split.stat?.hits, 0), 0);
  const walks = starts.reduce((sum, split) => sum + toNumber(split.stat?.baseOnBalls, 0), 0);
  const strikeouts = starts.reduce((sum, split) => sum + toNumber(split.stat?.strikeOuts, 0), 0);
  const homeRuns = starts.reduce((sum, split) => sum + toNumber(split.stat?.homeRuns, 0), 0);
  const pitches = starts.reduce((sum, split) => sum + toNumber(split.stat?.numberOfPitches, 0), 0);
  const era = innings > 0 ? (earnedRuns * 9) / innings : 0;
  const whip = innings > 0 ? (hits + walks) / innings : 0;
  const kbb = strikeouts / Math.max(1, walks);
  const last = starts[starts.length - 1];

  return {
    games: starts.length,
    innings,
    era,
    whip,
    strikeouts,
    walks,
    homeRuns,
    avgPitches: pitches / starts.length,
    lastStartDate: last?.date || '',
    lastStartPitches: toNumber(last?.stat?.numberOfPitches, 0),
    line: `last ${starts.length}: ERA ${safeFixed(era)}, WHIP ${safeFixed(whip)}, K/BB ${safeFixed(kbb, 1)}, HR ${homeRuns}, avg ${safeFixed(pitches / starts.length, 0)} pitches`
  };
}

function emptyFirstInningProfile(team) {
  return {
    team: {
      id: team.id,
      name: team.name,
      abbreviation: team.abbreviation
    },
    games: []
  };
}

function addFirstInningGame(profiles, game, team, side) {
  if (!profiles.has(team.id)) {
    profiles.set(team.id, emptyFirstInningProfile(team));
  }

  const first = game.linescore?.innings?.[0];
  if (!first) return;

  const defenseSide = side === 'away' ? 'home' : 'away';
  const offenseRuns = toNumber(first[side]?.runs, 0);
  const allowedRuns = toNumber(first[defenseSide]?.runs, 0);

  profiles.get(team.id).games.push({
    gamePk: game.gamePk,
    date: game.officialDate || game.gameDate,
    scored: offenseRuns > 0,
    allowed: allowedRuns > 0,
    anyRun: offenseRuns + allowedRuns > 0,
    offenseRuns,
    allowedRuns
  });
}

function boxscorePlayer(boxscore, side, personId) {
  return boxscore?.teams?.[side]?.players?.[`ID${personId}`] || null;
}

function actualStarterForSide(boxscore, side) {
  const boxTeam = boxscore?.teams?.[side];
  for (const personId of boxTeam?.pitchers || []) {
    const player = boxTeam?.players?.[`ID${personId}`];
    if (toNumber(player?.stats?.pitching?.gamesStarted, 0) > 0) {
      return {
        id: Number(personId),
        fullName: lineupPlayerName(player) || player?.person?.fullName || `Pitcher ${personId}`
      };
    }
  }
  return null;
}

function baseKey(base) {
  return `${base?.start || ''}:${base?.end || ''}`;
}

function scoreKey(runner) {
  return `${runner?.details?.event || ''}:${runner?.movement?.start || ''}:score`;
}

function firstInningRunsChargedToPitcher(liveFeed, pitcherSide, starterId) {
  if (!starterId) return null;
  const battingSide = pitcherSide === 'home' ? 'away' : 'home';
  const halfInning = battingSide === 'away' ? 'top' : 'bottom';
  const plays = (liveFeed?.liveData?.plays?.allPlays || [])
    .filter((play) => toNumber(play?.about?.inning, 0) === 1)
    .filter((play) => String(play?.about?.halfInning || '').toLowerCase() === halfInning);
  if (!plays.length) return null;

  let chargedRuns = 0;
  const responsiblePitcherByBase = new Map();

  for (const play of plays) {
    const pitcherId = play?.matchup?.pitcher?.id || null;
    const batterId = play?.matchup?.batter?.id || null;
    const nextResponsible = new Map();
    const runners = Array.isArray(play.runners) ? play.runners : [];
    const scoredThisPlay = new Set();

    for (const runner of runners) {
      if (runner?.movement?.isOut) continue;
      const start = runner?.movement?.start || '';
      const end = runner?.movement?.end || '';
      const runnerId = runner?.details?.runner?.id || null;
      const existingResponsible = start ? responsiblePitcherByBase.get(start) : null;
      const responsiblePitcher = existingResponsible || (runnerId && runnerId === batterId ? pitcherId : null);

      if (end === 'score') {
        const key = scoreKey(runner);
        if (!scoredThisPlay.has(key) && responsiblePitcher === starterId) {
          chargedRuns += 1;
          scoredThisPlay.add(key);
        }
      } else if (end) {
        nextResponsible.set(end, responsiblePitcher || pitcherId || null);
      }
    }

    if (pitcherId === starterId && batterId) {
      const batterRunner = runners.find((runner) => runner?.details?.runner?.id === batterId);
      const end = batterRunner?.movement?.end || '';
      if (end && end !== 'score' && !batterRunner?.movement?.isOut) {
        nextResponsible.set(end, starterId);
      }
    }

    for (const runner of runners) {
      const key = baseKey(runner?.movement);
      if (key && runner?.movement?.start) responsiblePitcherByBase.delete(runner.movement.start);
    }
    for (const [base, responsiblePitcher] of nextResponsible.entries()) {
      responsiblePitcherByBase.set(base, responsiblePitcher);
    }
  }

  return chargedRuns;
}

// Record the real 1st-inning runs charged to an actual starting pitcher. The
// home starter pitches the TOP of the 1st, the away starter the BOTTOM.
function addPitcherFirstInningGame(pitcherProfiles, game, boxscore, liveFeed, pitcherSide) {
  const starter = actualStarterForSide(boxscore, pitcherSide);
  if (!starter?.id) return;
  const allowedRuns = firstInningRunsChargedToPitcher(liveFeed, pitcherSide, starter.id);
  if (allowedRuns === null) return;

  if (!pitcherProfiles.has(starter.id)) {
    pitcherProfiles.set(starter.id, { pitcherId: starter.id, name: starter.fullName, games: [] });
  }
  pitcherProfiles.get(starter.id).games.push({
    gamePk: game.gamePk,
    date: game.officialDate || game.gameDate,
    allowed: allowedRuns > 0,
    allowedRuns,
    source: 'play_by_play'
  });
}

function finalizePitcherFirstInningProfile(profile) {
  const games = [...profile.games].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const recentGames = games.slice(-10);
  const allowed = games.filter((g) => g.allowed).length;
  const recentAllowed = recentGames.filter((g) => g.allowed).length;
  // Per-half allowed-run rate against this starter in the 1st, season + recent
  // blended and smoothed toward the league per-half prior so thin samples don't
  // dominate.
  const seasonRate = smoothedRate(allowed, games.length, DEFAULTS.firstInningRunRate);
  const recentRate = smoothedRate(recentAllowed, recentGames.length, DEFAULTS.firstInningRunRate);
  return {
    ...profile,
    games,
    starts: games.length,
    allowed,
    allowedRateBlend: seasonRate * 0.65 + recentRate * 0.35
  };
}

function smoothedRate(count, total, prior, weight = 8) {
  return (count + prior * weight) / (Math.max(0, total) + weight);
}

function summarizeFirstInningGames(games) {
  const total = games.length;
  const scored = games.filter((game) => game.scored).length;
  const allowed = games.filter((game) => game.allowed).length;
  const anyRun = games.filter((game) => game.anyRun).length;

  return {
    games: total,
    scored,
    allowed,
    anyRun,
    scoredRate: smoothedRate(scored, total, DEFAULTS.firstInningRunRate),
    allowedRate: smoothedRate(allowed, total, DEFAULTS.firstInningRunRate),
    anyRunRate: smoothedRate(anyRun, total, DEFAULTS.gameFirstInningRunRate)
  };
}

function finalizeFirstInningProfile(profile) {
  const games = [...profile.games].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const recentGames = games.slice(-10);
  const season = summarizeFirstInningGames(games);
  const recent = summarizeFirstInningGames(recentGames);

  return {
    ...profile,
    games,
    season,
    recent,
    scoredBlend: season.scoredRate * 0.65 + recent.scoredRate * 0.35,
    allowedBlend: season.allowedRate * 0.65 + recent.allowedRate * 0.35,
    anyRunBlend: season.anyRunRate * 0.65 + recent.anyRunRate * 0.35
  };
}

function defaultFirstInningProfile(team) {
  return finalizeFirstInningProfile(emptyFirstInningProfile(team));
}

function pitcherFirstInningRisk(stats, pitcherFirstInningProfile = null) {
  const eraRisk = stats ? (statEra(stats) - DEFAULTS.era) / 18 : 0;
  const whipRisk = stats ? (statWhip(stats) - DEFAULTS.whip) / 6 : 0;
  const kbbRisk = stats ? (2.2 - kToBb(stats)) / 18 : 0;
  const seasonRisk = clamp(eraRisk + whipRisk + kbbRisk, -0.1, 0.1);

  if (!pitcherFirstInningProfile?.starts) return seasonRisk;

  // Actual 1st-inning allowed history is useful context, but it is noisy and has
  // small samples. Treat it as a bounded additive adjustment so a neutral/thin
  // profile does not make a bad season-risk pitcher look safer by existing.
  const sampleWeight = clamp(pitcherFirstInningProfile.starts / 12, 0, 1);
  const observedAdjustment =
    clamp(
      (pitcherFirstInningProfile.allowedRateBlend - DEFAULTS.firstInningRunRate) * 0.5,
      -0.08,
      0.08
    ) * sampleWeight;
  return clamp(seasonRisk + observedAdjustment, -0.12, 0.12);
}

function firstInningProfileLine(profile) {
  const team = profile.team.abbreviation || profile.team.name;
  return `${team} scored 1st ${profile.season.scored}/${profile.season.games}, allowed ${profile.season.allowed}/${profile.season.games}, recent any ${profile.recent.anyRun}/${profile.recent.games}`;
}

function pitcherFirstInningProfileLine(profile) {
  if (!profile?.starts) return null;
  const allowed = profile.allowed ?? profile.games.filter((game) => game.allowed).length;
  return `${profile.name} allowed 1st ${allowed}/${profile.starts}`;
}

function buildFirstInningProjection({
  away,
  home,
  awayProfile,
  homeProfile,
  awayPitcherStats,
  homePitcherStats,
  awayPitcherFirstInningProfile,
  homePitcherFirstInningProfile,
  headToHead,
  venue,
  weather,
  awayLineup,
  homeLineup
}) {
  const awayLeadoffObp = leadoffObp(awayLineup);
  const homeLeadoffObp = leadoffObp(homeLineup);
  const awayLeadoffAdj = Number.isFinite(awayLeadoffObp)
    ? clamp((awayLeadoffObp - 0.330) * 0.8, -0.04, 0.04)
    : 0;
  const homeLeadoffAdj = Number.isFinite(homeLeadoffObp)
    ? clamp((homeLeadoffObp - 0.330) * 0.8, -0.04, 0.04)
    : 0;
  const topRate = clamp(
    awayProfile.scoredBlend * 0.55 +
      homeProfile.allowedBlend * 0.45 +
      pitcherFirstInningRisk(homePitcherStats, homePitcherFirstInningProfile) +
      awayLeadoffAdj,
    0.08,
    0.62
  );
  const bottomRate = clamp(
    homeProfile.scoredBlend * 0.55 +
      awayProfile.allowedBlend * 0.45 +
      pitcherFirstInningRisk(awayPitcherStats, awayPitcherFirstInningProfile) +
      homeLeadoffAdj,
    0.08,
    0.62
  );
  // Two independent estimates of "a run scores in the 1st":
  //  (a) OR-combination of each half-inning's scoring rate, and
  //  (b) the teams' directly-observed any-run rate (anyRunBlend), which the old
  //      model computed but never used. Average them for a less biased center.
  const orProbability = 1 - (1 - topRate) * (1 - bottomRate);
  const directAnyRun =
    ((awayProfile.anyRunBlend ?? DEFAULTS.gameFirstInningRunRate) +
      (homeProfile.anyRunBlend ?? DEFAULTS.gameFirstInningRunRate)) /
    2;
  const modelProbability = orProbability * 0.5 + directAnyRun * 0.5;
  const h2hGames = headToHead?.firstInning?.games || 0;
  const h2hProbability = (headToHead?.firstInning?.probability || DEFAULTS.gameFirstInningRunRate * 100) / 100;
  const blendedProbability =
    h2hGames >= 3 ? modelProbability * 0.85 + h2hProbability * 0.15 : modelProbability;
  const venueRate = venueYrfiRate(venue?.name || venue);
  const venueAdjustment = clamp((venueRate - DEFAULTS.gameFirstInningRunRate) * 0.5, -0.08, 0.08);
  const weatherAdjustment = yrfiWeatherAdjustment(weather);
  const contextualProbability = clamp(blendedProbability + venueAdjustment + weatherAdjustment, 0.20, 0.80);
  // Per-game YRFI signal has historically shown ~zero correlation with outcomes
  // (the matchup features barely move the needle), so shrink hard toward the
  // league base rate. This keeps the probability honest instead of emitting
  // overconfident leans the data does not support.
  const baseRate = DEFAULTS.gameFirstInningRunRate;
  const shrunkProbability = contextualProbability * 0.4 + baseRate * 0.6;
  let probability = clamp(shrunkProbability * 100, 35, 70);
  // Calibrate at the source, mirroring moneyline/totals. The Python pipeline
  // trains a 'yrfi' isotonic map the live path never applied. Analysis of 192
  // graded YRFI outcomes found severe overconfidence at the high end (65-70%
  // bucket won only 47%). `probability` is P(YES, a run scores); calibrate the
  // favored side (YES vs NO) and derive YES back so the surfaced number reflects
  // observed frequency instead of the raw, overconfident projection.
  if (hasCalibrationMap('yrfi')) {
    const yesProb = probability;
    const noProb = 100 - probability;
    if (yesProb >= noProb) {
      probability = clamp(calibratePercent(yesProb, 'yrfi'), 35, 70);
    } else {
      probability = 100 - clamp(calibratePercent(noProb, 'yrfi'), 35, 70);
    }
  }
  // Break-even for a YRFI bet at typical -110/-120 juice is ~52-55%. Only lean
  // YES when the projection clears the base rate by a real margin, and NO only
  // when it falls well below it; otherwise there is no actionable edge.
  const lean = probability >= 58 ? 'YES' : probability <= 48 ? 'NO' : 'YES';
  // YRFI carried no per-game edge historically (corr ~ -0.02 with outcomes) and
  // the market already prices the >50% base rate, so it stays advisory-only by
  // default: the lean/probability are surfaced as context but `pick` is NO BET
  // so it is not graded as a bet. Re-enable with YRFI_ACTIVE=1 only if a future
  // feature set demonstrates a real, calibrated edge.
  const yrfiActive = String(process.env.YRFI_ACTIVE || '').trim() === '1';
  const pick = yrfiActive ? lean : 'NO BET';

  const reasons = [
    `Top 1: ${away.abbreviation || away.name} offense/allowed profile projects ${percent(topRate * 100)} run chance.`,
    `Bottom 1: ${home.abbreviation || home.name} offense/allowed profile projects ${percent(bottomRate * 100)} run chance.`
  ];

  const pitcherLines = [
    pitcherFirstInningProfileLine(homePitcherFirstInningProfile),
    pitcherFirstInningProfileLine(awayPitcherFirstInningProfile)
  ].filter(Boolean);
  if (pitcherLines.length) {
    reasons.push(`Starter 1st-inning history: ${pitcherLines.join(' | ')}.`);
  }
  if (h2hGames > 0) {
    reasons.push(`H2H first-inning run: ${headToHead.firstInning.runGames}/${h2hGames}.`);
  }
  const contextParts = [];
  contextParts.push(`venue YRFI ${percent(venueRate * 100)}`);
  if (Math.abs(weatherAdjustment) >= 0.005) {
    contextParts.push(`weather ${weatherAdjustment >= 0 ? '+' : ''}${percent(weatherAdjustment * 100)}`);
  }
  if (Number.isFinite(awayLeadoffObp) || Number.isFinite(homeLeadoffObp)) {
    contextParts.push(`leadoff OBP ${Number.isFinite(awayLeadoffObp) ? safeFixed(awayLeadoffObp, 3) : '-'} | ${Number.isFinite(homeLeadoffObp) ? safeFixed(homeLeadoffObp, 3) : '-'}`);
  }
  if (contextParts.length) {
    reasons.push(`YRFI context: ${contextParts.join(' | ')}.`);
  }
  if (!yrfiActive) {
    reasons.push('YRFI advisory-only: market historically unprofitable, not graded as a bet.');
  }

  // Confidence reflects how far the projection sits from the ~55% league base
  // rate (the shrunk scale rarely leaves the 45-65% band), not raw probability.
  const baseDistance = Math.abs(probability - DEFAULTS.gameFirstInningRunRate * 100);
  return {
    baselinePick: pick,
    baselineProbability: probability,
    baselineLean: lean,
    advisoryOnly: !yrfiActive,
    confidence: baseDistance >= 8 ? 'high' : baseDistance >= 4 ? 'medium' : 'low',
    topRate: topRate * 100,
    bottomRate: bottomRate * 100,
    h2h: {
      games: h2hGames,
      runGames: headToHead?.firstInning?.runGames || 0,
      probability: h2hProbability * 100
    },
    awayProfileLine: firstInningProfileLine(awayProfile),
    homeProfileLine: firstInningProfileLine(homeProfile),
    awayPitcherFirstInningLine: pitcherFirstInningProfileLine(awayPitcherFirstInningProfile),
    homePitcherFirstInningLine: pitcherFirstInningProfileLine(homePitcherFirstInningProfile),
    venueYrfiRate: venueRate,
    venueAdjustment,
    weatherAdjustment,
    awayLeadoffObp: Number.isFinite(awayLeadoffObp) ? awayLeadoffObp : null,
    homeLeadoffObp: Number.isFinite(homeLeadoffObp) ? homeLeadoffObp : null,
    reasons
  };
}

function matchupSplitLine(team, standing, opponentStarter, venueSplitType) {
  const hand = opponentStarter?.pitchHand?.code;
  if (!hand || !['L', 'R'].includes(hand)) {
    return `${team.abbreviation || team.name} vs starter hand: unavailable`;
  }

  const baseType = hand === 'L' ? 'left' : 'right';
  const venueType =
    hand === 'L'
      ? venueSplitType === 'home'
        ? 'leftHome'
        : 'leftAway'
      : venueSplitType === 'home'
        ? 'rightHome'
        : 'rightAway';
  const overall = splitRecord(standing, baseType);
  const venue = splitRecord(standing, venueType);
  const handLabel = hand === 'L' ? 'LHP' : 'RHP';

  return `${team.abbreviation || team.name} vs ${handLabel}: ${splitRecordText(overall)}, ${venueSplitType} ${splitRecordText(venue)}`;
}

async function fetchHeadToHead(game, season, dateYmd) {
  const awayTeamId = game.teams.away.team.id;
  const homeTeamId = game.teams.home.team.id;
  const params = new URLSearchParams({
    sportId: '1',
    season: String(season),
    gameTypes: 'R',
    teamId: String(awayTeamId),
    opponentId: String(homeTeamId),
    startDate: seasonStartDate(season),
    endDate: dateYmd,
    hydrate: 'linescore'
  });

  const data = await fetchJson(`${MLB_BASE_URL}/schedule?${params}`);
  const games = (data.dates || [])
    .flatMap((date) => date.games || [])
    .filter((item) => item.gamePk !== game.gamePk)
    .filter((item) => item.status?.abstractGameState === 'Final')
    .filter((item) => Number.isFinite(item.teams?.away?.score) && Number.isFinite(item.teams?.home?.score));

  let awayWins = 0;
  let homeWins = 0;
  let firstInningGames = 0;
  let firstInningRunGames = 0;

  for (const item of games) {
    const winnerId =
      item.teams.away.score > item.teams.home.score
        ? item.teams.away.team.id
        : item.teams.home.team.id;

    if (winnerId === awayTeamId) awayWins += 1;
    if (winnerId === homeTeamId) homeWins += 1;

    const first = item.linescore?.innings?.[0];
    if (first) {
      firstInningGames += 1;
      if (toNumber(first.away?.runs, 0) + toNumber(first.home?.runs, 0) > 0) {
        firstInningRunGames += 1;
      }
    }
  }

  const total = awayWins + homeWins;
  const awayProbability = ((awayWins + 1) / (total + 2)) * 100;
  const homeProbability = 100 - awayProbability;
  const firstInningProbability =
    ((firstInningRunGames + DEFAULTS.gameFirstInningRunRate * 4) / (firstInningGames + 4)) * 100;

  return {
    games: total,
    awayWins,
    homeWins,
    awayProbability,
    homeProbability,
    firstInning: {
      games: firstInningGames,
      runGames: firstInningRunGames,
      probability: firstInningProbability
    }
  };
}

function finalGameResult(game, dateYmd) {
  const awayScore = toNumber(game.teams?.away?.score, Number.NaN);
  const homeScore = toNumber(game.teams?.home?.score, Number.NaN);
  const awayTeam = game.teams.away.team;
  const homeTeam = game.teams.home.team;
  // A tie (equal finite scores) or non-finite scores has no winner. Emitting a
  // concrete home "winner" here would settle a staked bet as a win/loss instead
  // of a push and corrupt the ledger. Return null-id winner/loser so settleBet's
  // (winnerId == null → push) branch fires. Regular-season ties are rare but
  // suspended/shortened finals with equal scores do occur.
  const decided = Number.isFinite(awayScore) && Number.isFinite(homeScore) && awayScore !== homeScore;
  const winnerTeam = decided ? (awayScore > homeScore ? awayTeam : homeTeam) : null;
  const loserTeam = decided ? (awayScore > homeScore ? homeTeam : awayTeam) : null;
  const first = game.linescore?.innings?.[0];
  const firstInningAwayRuns = toNumber(first?.away?.runs, 0);
  const firstInningHomeRuns = toNumber(first?.home?.runs, 0);

  return {
    gamePk: game.gamePk,
    dateYmd,
    status: game.status?.detailedState || 'Final',
    away: {
      id: awayTeam.id,
      name: awayTeam.name,
      abbreviation: awayTeam.abbreviation,
      score: awayScore
    },
    home: {
      id: homeTeam.id,
      name: homeTeam.name,
      abbreviation: homeTeam.abbreviation,
      score: homeScore
    },
    winner: {
      id: winnerTeam?.id ?? null,
      name: winnerTeam?.name ?? null,
      abbreviation: winnerTeam?.abbreviation ?? null
    },
    loser: {
      id: loserTeam?.id ?? null,
      name: loserTeam?.name ?? null,
      abbreviation: loserTeam?.abbreviation ?? null
    },
    firstInning: {
      awayRuns: firstInningAwayRuns,
      homeRuns: firstInningHomeRuns,
      anyRun: first ? firstInningAwayRuns + firstInningHomeRuns > 0 : null
    }
  };
}

function starterEdge(homePitcherStats, awayPitcherStats) {
  if (!homePitcherStats && !awayPitcherStats) return 0;

  const homeEra = statEra(homePitcherStats);
  const awayEra = statEra(awayPitcherStats);
  const homeWhip = statWhip(homePitcherStats);
  const awayWhip = statWhip(awayPitcherStats);
  const homeKbb = kToBb(homePitcherStats);
  const awayKbb = kToBb(awayPitcherStats);
  const homeKMinusBb = pitchingKMinusBb(homePitcherStats);
  const awayKMinusBb = pitchingKMinusBb(awayPitcherStats);
  const homeHr9 = pitchingHr9(homePitcherStats);
  const awayHr9 = pitchingHr9(awayPitcherStats);

  return clamp(
    (awayEra - homeEra) / 2.4 +
      (awayWhip - homeWhip) / 0.6 +
      (homeKbb - awayKbb) / 4.0 +
      (homeKMinusBb - awayKMinusBb) / 0.16 +
      (awayHr9 - homeHr9) / 1.1,
    -1.6,
    1.6
  );
}

function createReasons({
  home,
  away,
  homeProfile,
  awayProfile,
  homePitcherStats,
  awayPitcherStats,
  homeStarter,
  awayStarter,
  probHome,
  homeLineup,
  awayLineup,
  modelBreakdown
}) {
  const winner = probHome >= 50 ? home : away;
  const loser = probHome >= 50 ? away : home;
  const winnerProfile = probHome >= 50 ? homeProfile : awayProfile;
  const loserProfile = probHome >= 50 ? awayProfile : homeProfile;
  const winnerPitcherStats = probHome >= 50 ? homePitcherStats : awayPitcherStats;
  const loserPitcherStats = probHome >= 50 ? awayPitcherStats : homePitcherStats;
  const winnerStarter = probHome >= 50 ? homeStarter : awayStarter;
  const loserStarter = probHome >= 50 ? awayStarter : homeStarter;

  const reasons = [];
  const winnerRpg = rpg(winnerProfile?.hitting);
  const loserRpg = rpg(loserProfile?.hitting);
  const winnerOps = statOps(winnerProfile?.hitting);
  const loserOps = statOps(loserProfile?.hitting);
  const winnerIso = statIso(winnerProfile?.hittingAdvanced);
  const loserIso = statIso(loserProfile?.hittingAdvanced);
  const winnerKRate = battingKRate(winnerProfile?.hittingAdvanced);
  const loserKRate = battingKRate(loserProfile?.hittingAdvanced);
  const winnerBbRate = battingBbRate(winnerProfile?.hittingAdvanced);
  const loserBbRate = battingBbRate(loserProfile?.hittingAdvanced);
  const winnerEra = statEra(winnerProfile?.pitching);
  const loserEra = statEra(loserProfile?.pitching);
  const winnerWhip = statWhip(winnerProfile?.pitching);
  const loserWhip = statWhip(loserProfile?.pitching);
  const winnerKMinusBb = pitchingKMinusBb(winnerProfile?.pitchingAdvanced);
  const loserKMinusBb = pitchingKMinusBb(loserProfile?.pitchingAdvanced);
  const winnerHr9 = pitchingHr9(winnerProfile?.pitchingAdvanced);
  const loserHr9 = pitchingHr9(loserProfile?.pitchingAdvanced);
  const winnerSpEra = statEra(winnerPitcherStats);
  const loserSpEra = statEra(loserPitcherStats);
  const winnerSpWhip = statWhip(winnerPitcherStats);
  const loserSpWhip = statWhip(loserPitcherStats);
  const winnerSpKbb = kToBb(winnerPitcherStats);
  const loserSpKbb = kToBb(loserPitcherStats);
  const lineupEdge = toNumber(modelBreakdown?.lineupEdge, 0);
  const bullpenEdge = toNumber(modelBreakdown?.bullpenEdge, 0);
  const recordContextEdge = toNumber(modelBreakdown?.recordContextEdge, 0);
  const matchupEdge = toNumber(modelBreakdown?.matchupEdge, 0);
  const winnerLineup = probHome >= 50 ? homeLineup : awayLineup;
  const loserLineup = probHome >= 50 ? awayLineup : homeLineup;

  if (
    winnerPitcherStats &&
    loserPitcherStats &&
    (winnerSpEra <= loserSpEra - 0.45 ||
      winnerSpWhip <= loserSpWhip - 0.12 ||
      winnerSpKbb >= loserSpKbb + 0.5)
  ) {
    reasons.push(
      `SP edge: ${winnerStarter?.fullName || winner.name} ERA ${safeFixed(winnerSpEra)}, WHIP ${safeFixed(winnerSpWhip)} vs ${loserStarter?.fullName || loser.name} ERA ${safeFixed(loserSpEra)}, WHIP ${safeFixed(loserSpWhip)}.`
    );
  }

  if (
    (winner.id === home.id && lineupEdge >= 0.035) ||
    (winner.id === away.id && lineupEdge <= -0.035)
  ) {
    const lineupStatus = winnerLineup?.confirmed
      ? `confirmed ${winnerLineup.count}/9`
      : winnerLineup?.count > 0
        ? `partial ${winnerLineup.count}/9`
        : 'lineup belum lengkap';
    const top = winnerLineup?.topFive?.slice(0, 3)?.length
      ? ` top ${winnerLineup.topFive.slice(0, 3).join(', ')}`
      : '';
    const loserStatus = loserLineup?.confirmed
      ? `vs ${loserLineup.count}/9 confirmed`
      : loserLineup?.count > 0
        ? `vs partial ${loserLineup.count}/9`
        : 'vs lineup lawan belum lengkap';
    reasons.push(`Lineup edge: ${winner.name} ${lineupStatus}${top}; ${loserStatus}.`);
  }

  if (
    winnerRpg >= loserRpg + 0.25 ||
    winnerOps >= loserOps + 0.025 ||
    winnerIso >= loserIso + 0.025 ||
    winnerBbRate >= loserBbRate + 0.02 ||
    winnerKRate <= loserKRate - 0.03
  ) {
    reasons.push(
      `Offense edge: ${winner.name} ${safeFixed(winnerRpg, 2)} R/G, OPS ${safeFixed(winnerOps, 3)}, ISO ${safeFixed(winnerIso, 3)} vs ${loser.name} ${safeFixed(loserRpg, 2)} R/G, OPS ${safeFixed(loserOps, 3)}, ISO ${safeFixed(loserIso, 3)}.`
    );
  }

  if (
    winnerEra <= loserEra - 0.25 ||
    winnerWhip <= loserWhip - 0.08 ||
    winnerKMinusBb >= loserKMinusBb + 0.025 ||
    winnerHr9 <= loserHr9 - 0.2
  ) {
    reasons.push(
      `Pitching team lebih kuat: ERA ${safeFixed(winnerEra)}, WHIP ${safeFixed(winnerWhip)}, K-BB ${ratePct(winnerKMinusBb)} vs ERA ${safeFixed(loserEra)}, WHIP ${safeFixed(loserWhip)}, K-BB ${ratePct(loserKMinusBb)}.`
    );
  }

  const winnerPct = leagueRecordPct(winner.record);
  const loserPct = leagueRecordPct(loser.record);
  if (winnerPct >= loserPct + 0.05) {
    reasons.push(`Form season: win% ${safeFixed(winnerPct, 3)} vs ${safeFixed(loserPct, 3)}.`);
  }

  if (winner.id === home.id) {
    reasons.push('Home field memberi edge kecil.');
  }

  if (modelBreakdown?.recordDominated) {
    reasons.push('Record/H2H dibatasi: matchup hari ini belum cukup kuat, jadi confidence harus konservatif.');
  } else if (Math.abs(matchupEdge) >= Math.abs(recordContextEdge) + 0.08) {
    reasons.push('Pick lebih didorong matchup hari ini daripada record/H2H series.');
  }

  if (
    (winner.id === home.id && bullpenEdge >= 0.045) ||
    (winner.id === away.id && bullpenEdge <= -0.045)
  ) {
    reasons.push(`Bullpen availability: bullpen lawan lebih lelah, memberi edge late-game ke ${winner.name}.`);
  }

  if (reasons.length === 0) {
    reasons.push('Edge tipis dari kombinasi record, offense, pitching, dan venue.');
  }

  return reasons.slice(0, 3);
}

function standingContext(team, standing, venueSplitType) {
  const lastTen = splitRecord(standing, 'lastTen');
  const venue = splitRecord(standing, venueSplitType);
  const xRecord = expectedRecord(standing);
  const streak = standing?.streak?.streakCode || '-';

  return [
    `${team.abbreviation || team.name} ${recordText(standing?.leagueRecord)}`,
    `L10 ${recordText(lastTen)}`,
    `${venueSplitType === 'home' ? 'home' : 'road'} ${recordText(venue)}`,
    `RD ${signed(standing?.runDifferential)}`,
    `xW-L ${recordText(xRecord)}`,
    streak
  ].join(', ');
}

function advancedContext(team, profile) {
  return [
    `${team.abbreviation || team.name}`,
    `ISO ${safeFixed(statIso(profile?.hittingAdvanced), 3)}`,
    `K ${ratePct(battingKRate(profile?.hittingAdvanced))}`,
    `BB ${ratePct(battingBbRate(profile?.hittingAdvanced))}`,
    `Pit K-BB ${ratePct(pitchingKMinusBb(profile?.pitchingAdvanced))}`,
    `HR9 ${safeFixed(pitchingHr9(profile?.pitchingAdvanced), 2)}`
  ].join(' ');
}

function injuryCountLabel(team, injuries) {
  const label = team.abbreviation || team.name;
  const count = injuries.length;
  return count > 0 ? `${label} IL ${count}` : `${label} IL clear`;
}

function injuryDetailLines(team, injuries) {
  const label = team.abbreviation || team.name;
  if (!injuries.length) return [`${label}: tidak ada pemain 40-man roster yang berstatus injured.`];

  return injuries.map((injury) => {
    const note = injury.note ? ` - ${injury.note}` : '';
    return `${label}: ${injury.name} (${injury.position}, ${injury.status})${note}`;
  });
}

function referenceEdgeLabel(away, home, homeProbability) {
  const homeProb = Math.round(homeProbability);
  const awayProb = 100 - homeProb;
  return homeProb >= awayProb
    ? `${home.abbreviation || home.name} ${homeProb}%`
    : `${away.abbreviation || away.name} ${awayProb}%`;
}

function buildModelReferenceLines({
  away,
  home,
  awayPythagoreanPct,
  homePythagoreanPct,
  homeSeasonLog5,
  homePythagoreanLog5,
  homeRecentLog5,
  homeReferenceBlend
}) {
  const awayPythPct = Math.round(awayPythagoreanPct * 100);
  const homePythPct = Math.round(homePythagoreanPct * 100);
  const direction =
    homeReferenceBlend >= 0.5
      ? `${home.name} (${percent(homeReferenceBlend * 100)})`
      : `${away.name} (${percent((1 - homeReferenceBlend) * 100)})`;

  return [
    `Arah edge ML: ${direction}`,
    `Pythagorean strength: ${away.abbreviation || away.name} ${awayPythPct}% vs ${home.abbreviation || home.name} ${homePythPct}%.`,
    `Log5 season: ${referenceEdgeLabel(away, home, homeSeasonLog5 * 100)}.`,
    `Log5 Pythagorean: ${referenceEdgeLabel(away, home, homePythagoreanLog5 * 100)}.`,
    `Recent form Log5: ${referenceEdgeLabel(away, home, homeRecentLog5 * 100)}.`
  ];
}

function offenseRunAdjustment(profile) {
  const hitting = profile?.hitting;
  const advanced = profile?.hittingAdvanced;
  const rpgAdj = (rpg(hitting) - DEFAULTS.rpg) * 0.45;
  const opsAdj = (statOps(hitting) - DEFAULTS.ops) * 2.0;
  const isoAdj = (statIso(advanced) - DEFAULTS.iso) * 1.3;
  const bbAdj = (battingBbRate(advanced) - DEFAULTS.bbRate) * 1.4;
  const kAdj = (DEFAULTS.kRate - battingKRate(advanced)) * 0.9;
  return clamp(rpgAdj + opsAdj + isoAdj + bbAdj + kAdj, -1.2, 1.2);
}

function pitcherRunAdjustment(stats) {
  if (!stats) return 0;

  const eraAdj = (statEra(stats) - DEFAULTS.era) * 0.15;
  const whipAdj = (statWhip(stats) - DEFAULTS.whip) * 0.75;
  const hrAdj = (pitchingHr9(stats) - DEFAULTS.hr9) * 0.22;
  const kbbAdj = (DEFAULTS.kMinusBb - pitchingKMinusBb(stats)) * 1.2;
  return clamp(eraAdj + whipAdj + hrAdj + kbbAdj, -1.2, 1.2);
}

function bullpenRunAdjustment(bullpen) {
  if (!bullpen) return 0;

  const fatigue = Math.max(0, toNumber(bullpen.fatigueScore, 0) - 0.8) * 0.2;
  const b2b = toNumber(bullpen.backToBackRelievers, 0) * 0.04;
  const highPitch = toNumber(bullpen.highPitchRelievers, 0) * 0.03;
  return clamp(fatigue + b2b + highPitch, 0, 0.85);
}

function injuryRunAdjustment(injuries) {
  if (!Array.isArray(injuries) || injuries.length === 0) return 0;

  const hitterInjuries = injuries.filter((injury) => injury.position !== 'P').length;
  const pitcherInjuries = injuries.length - hitterInjuries;
  return clamp(-(hitterInjuries * 0.08 + pitcherInjuries * 0.02), -0.7, 0);
}

function recentRunAdjustment(teamStanding, opponentStanding) {
  return clamp((runDiffPerGame(teamStanding) - runDiffPerGame(opponentStanding)) * 0.08, -0.35, 0.35);
}

function parseWeatherNumber(value) {
  const parsed = String(value || '').match(/-?\d+(\.\d+)?/);
  return parsed ? Number.parseFloat(parsed[0]) : null;
}

function weatherRunAdjustment(weather) {
  if (!weather) return 0;

  const temp = parseWeatherNumber(weather.temp || weather.temperature);
  const weatherText = JSON.stringify(weather).toLowerCase();
  const windText = String(weather.wind || weather.windDirection || '').toLowerCase();
  const windSpeed = parseWeatherNumber(windText) || 0;
  const tempAdj = temp === null ? 0 : clamp((temp - 70) * 0.015, -0.35, 0.35);
  const windAdj = windText.includes('out')
    ? clamp(windSpeed * 0.025, 0, 0.4)
    : windText.includes('in')
      ? -clamp(windSpeed * 0.025, 0, 0.4)
      : 0;
  const roofMultiplier =
    weatherText.includes('roof closed') || weatherText.includes('closed roof') || weatherText.includes('dome')
      ? 0.2
      : 1;
  return clamp((tempAdj + windAdj) * roofMultiplier, -0.55, 0.55);
}

function yrfiWeatherAdjustment(weather) {
  if (!weather) return 0;
  const weatherText = JSON.stringify(weather).toLowerCase();
  if (weatherText.includes('roof closed') || weatherText.includes('closed roof') || weatherText.includes('dome')) return 0;
  const temp = parseWeatherNumber(weather.temp || weather.temperature);
  const windText = String(weather.wind || weather.windDirection || '').toLowerCase();
  const windSpeed = parseWeatherNumber(windText) || 0;
  const humidity = parseWeatherNumber(weather.humidity) ?? 50;
  const tempAdj = temp === null ? 0 : clamp((temp - 70) * 0.006, -0.03, 0.03);
  const windAdj = windText.includes('out')
    ? clamp(windSpeed * 0.004, 0, 0.03)
    : windText.includes('in')
      ? -clamp(windSpeed * 0.004, 0, 0.03)
      : 0;
  const humidityAdj = clamp((humidity - 50) * 0.001, -0.01, 0.01);
  return clamp(tempAdj + windAdj + humidityAdj, -0.05, 0.05);
}

function venueYrfiRate(venueName) {
  return BALLPARK_YRFI_RATES.get(String(venueName || '').trim()) || DEFAULT_YRFI_RATE;
}

function leadoffObp(lineup) {
  return toNumber(lineup?.leadoffObp, Number.NaN);
}

function firstInningSignalLine(firstInning) {
  if (!firstInning) return '';
  const parts = [];
  if (Number.isFinite(Number(firstInning.venueYrfiRate))) {
    parts.push(`park YRFI ${percent(firstInning.venueYrfiRate * 100)}`);
  }
  if (Number.isFinite(Number(firstInning.weatherAdjustment)) && Math.abs(Number(firstInning.weatherAdjustment)) >= 0.005) {
    parts.push(`weather ${Number(firstInning.weatherAdjustment) >= 0 ? '+' : ''}${percent(Number(firstInning.weatherAdjustment) * 100)}`);
  }
  if (Number.isFinite(Number(firstInning.awayLeadoffObp)) || Number.isFinite(Number(firstInning.homeLeadoffObp))) {
    parts.push(`leadoff OBP ${Number.isFinite(Number(firstInning.awayLeadoffObp)) ? safeFixed(firstInning.awayLeadoffObp, 3) : '-'} | ${Number.isFinite(Number(firstInning.homeLeadoffObp)) ? safeFixed(firstInning.homeLeadoffObp, 3) : '-'}`);
  }
  return parts.join(' | ');
}

function parkFactorContext(homeTeam) {
  const baseline = PARK_FACTOR_BASELINES.get(homeTeam?.id) || {
    runFactor: 1,
    homeRunFactor: 1,
    label: homeTeam?.name || 'Neutral park'
  };
  const runAdjustment = clamp(
    (baseline.runFactor - 1) * 3.8 + (baseline.homeRunFactor - 1) * 0.9,
    -0.75,
    0.85
  );

  return {
    ...baseline,
    runAdjustment,
    runFactorPct: Math.round(baseline.runFactor * 100),
    homeRunFactorPct: Math.round(baseline.homeRunFactor * 100)
  };
}

function lineupRunAdjustment(lineup, injuries) {
  if (!lineup) return 0;

  const hitterInjuries = Array.isArray(injuries)
    ? injuries.filter((injury) => injury.position !== 'P').length
    : 0;

  if (lineup.confirmed) {
    return clamp(0.06 - hitterInjuries * 0.025, -0.2, 0.08);
  }

  if (lineup.count > 0) {
    return clamp(-0.04 - Math.max(0, 9 - lineup.count) * 0.025, -0.25, 0.02);
  }

  return 0;
}

function lineupWinEdge(homeLineup, awayLineup, homeInjuries, awayInjuries) {
  const homeQuality = toNumber(homeLineup?.qualityScore, 0);
  const awayQuality = toNumber(awayLineup?.qualityScore, 0);
  const homeAvailability = lineupRunAdjustment(homeLineup, homeInjuries);
  const awayAvailability = lineupRunAdjustment(awayLineup, awayInjuries);
  return clamp(homeQuality - awayQuality + (homeAvailability - awayAvailability) * 0.45, -0.18, 0.18);
}

// Both teams have publicly posted full nine-hitter lineups. Confirmed lineups
// remove a real source of uncertainty (replacement-level fill-ins) so the
// model's existing matchup edge should count slightly more — but only when
// directional info is already there. We expose this as a small multiplier,
// never as a free bump to either side's win probability.
export function bothLineupsConfirmed(lineups) {
  const away = lineups?.away;
  const home = lineups?.home;
  return Boolean(
    away?.confirmed && home?.confirmed && (away?.count || 0) >= 9 && (home?.count || 0) >= 9
  );
}

function bullpenAvailabilityEdge(homeBullpen, awayBullpen) {
  const homeFatigue = toNumber(homeBullpen?.fatigueScore, 0);
  const awayFatigue = toNumber(awayBullpen?.fatigueScore, 0);
  const homeB2b = toNumber(homeBullpen?.backToBackRelievers, 0);
  const awayB2b = toNumber(awayBullpen?.backToBackRelievers, 0);
  const homeHighPitch = toNumber(homeBullpen?.highPitchRelievers, 0);
  const awayHighPitch = toNumber(awayBullpen?.highPitchRelievers, 0);
  return clamp(
    (awayFatigue - homeFatigue) * 0.075 +
      (awayB2b - homeB2b) * 0.025 +
      (awayHighPitch - homeHighPitch) * 0.018,
    -0.18,
    0.18
  );
}

function edgeTeamLabel(edge, away, home) {
  if (edge > 0.015) return home.abbreviation || home.name;
  if (edge < -0.015) return away.abbreviation || away.name;
  return 'even';
}

function edgeComponentText(label, value, away, home) {
  const team = edgeTeamLabel(value, away, home);
  const magnitude = Math.abs(toNumber(value, 0)).toFixed(2);
  return `${label} ${team} ${magnitude}`;
}

function lineupStatusLine(team, lineup) {
  const label = team.abbreviation || team.name;
  if (!lineup) return `${label}: lineup belum tersedia`;
  if (lineup.confirmed) {
    const topNames = lineup.topFive?.slice(0, 3) || [];
    const top = topNames.length ? ` top: ${topNames.join(', ')}` : '';
    return `${label}: confirmed ${lineup.count}/9${top}`;
  }
  if (lineup.count > 0) return `${label}: partial ${lineup.count}/9`;
  return `${label}: lineup belum tersedia`;
}

function predictGame(
  game,
  teamStats,
  standings,
  pitcherStats,
  pitcherDetails,
  pitcherRecentStarts,
  bullpenProfiles,
  scheduleFatigueProfiles,
  headToHead,
  firstInningProfiles,
  injuryProfiles,
  lineupProfiles,
  modelMemory
) {
  const awayTeam = game.teams.away.team;
  const homeTeam = game.teams.home.team;
  const awayProfile = teamStats.get(awayTeam.id) || {};
  const homeProfile = teamStats.get(homeTeam.id) || {};
  const awayStanding = standings.get(awayTeam.id) || null;
  const homeStanding = standings.get(homeTeam.id) || null;
  const awayStarter = game.teams.away.probablePitcher
    ? { ...game.teams.away.probablePitcher, ...(pitcherDetails.get(game.teams.away.probablePitcher.id) || {}) }
    : null;
  const homeStarter = game.teams.home.probablePitcher
    ? { ...game.teams.home.probablePitcher, ...(pitcherDetails.get(game.teams.home.probablePitcher.id) || {}) }
    : null;
  const awayPitcherStats = awayStarter ? pitcherStats.get(awayStarter.id) : null;
  const homePitcherStats = homeStarter ? pitcherStats.get(homeStarter.id) : null;
  const awayOpenerSituation = detectOpenerSituation(game, 'away', awayStarter, awayPitcherStats);
  const homeOpenerSituation = detectOpenerSituation(game, 'home', homeStarter, homePitcherStats);
  const effectiveAwayPitcherStats = effectivePitcherStats(awayPitcherStats, awayOpenerSituation);
  const effectiveHomePitcherStats = effectivePitcherStats(homePitcherStats, homeOpenerSituation);
  const awayPitcherRecent = awayStarter ? pitcherRecentStarts.get(awayStarter.id) : null;
  const homePitcherRecent = homeStarter ? pitcherRecentStarts.get(homeStarter.id) : null;
  const awayBullpen = bullpenProfiles.get(awayTeam.id) || finalizeBullpenProfile({ teamId: awayTeam.id, games: 0, bullpenPitches: 0, bullpenOuts: 0, relieverAppearances: 0, relieverDates: new Map(), highPitchRelievers: 0 });
  const homeBullpen = bullpenProfiles.get(homeTeam.id) || finalizeBullpenProfile({ teamId: homeTeam.id, games: 0, bullpenPitches: 0, bullpenOuts: 0, relieverAppearances: 0, relieverDates: new Map(), highPitchRelievers: 0 });
  const awayScheduleFatigue = scheduleFatigueProfiles.get(awayTeam.id) || finalizeScheduleFatigueProfile(awayTeam.id, [], game.officialDate || String(game.gameDate).slice(0, 10));
  const homeScheduleFatigue = scheduleFatigueProfiles.get(homeTeam.id) || finalizeScheduleFatigueProfile(homeTeam.id, [], game.officialDate || String(game.gameDate).slice(0, 10));
  const gameDateYmd = game.officialDate || String(game.gameDate || '').slice(0, 10);
  const awayPitcherRest = pitcherRestProfile(awayStarter, awayPitcherRecent, gameDateYmd);
  const homePitcherRest = pitcherRestProfile(homeStarter, homePitcherRecent, gameDateYmd);
  const awayInjuries = injuryProfiles.get(awayTeam.id) || [];
  const homeInjuries = injuryProfiles.get(homeTeam.id) || [];
  const gameLineups = lineupProfiles || {};
  const awayLineup = gameLineups.away || null;
  const homeLineup = gameLineups.home || null;
  const awayFirstInningProfile =
    firstInningProfiles.get(awayTeam.id) || defaultFirstInningProfile(awayTeam);
  const homeFirstInningProfile =
    firstInningProfiles.get(homeTeam.id) || defaultFirstInningProfile(homeTeam);
  const awayPitcherFirstInningProfile = awayStarter && !awayOpenerSituation.isOpener
    ? firstInningProfiles.pitchers?.get(awayStarter.id) || null
    : null;
  const homePitcherFirstInningProfile = homeStarter && !homeOpenerSituation.isOpener
    ? firstInningProfiles.pitchers?.get(homeStarter.id) || null
    : null;

  const homeWinPct = leagueRecordPct(homeStanding?.leagueRecord || game.teams.home.leagueRecord);
  const awayWinPct = leagueRecordPct(awayStanding?.leagueRecord || game.teams.away.leagueRecord);
  const homeRpg = rpg(homeProfile.hitting);
  const awayRpg = rpg(awayProfile.hitting);
  const homeOps = statOps(homeProfile.hitting);
  const awayOps = statOps(awayProfile.hitting);
  const homeIso = statIso(homeProfile.hittingAdvanced);
  const awayIso = statIso(awayProfile.hittingAdvanced);
  const homeBatK = battingKRate(homeProfile.hittingAdvanced);
  const awayBatK = battingKRate(awayProfile.hittingAdvanced);
  const homeBatBb = battingBbRate(homeProfile.hittingAdvanced);
  const awayBatBb = battingBbRate(awayProfile.hittingAdvanced);
  const homeEra = statEra(homeProfile.pitching);
  const awayEra = statEra(awayProfile.pitching);
  const homeWhip = statWhip(homeProfile.pitching);
  const awayWhip = statWhip(awayProfile.pitching);
  const homeKMinusBb = pitchingKMinusBb(homeProfile.pitchingAdvanced);
  const awayKMinusBb = pitchingKMinusBb(awayProfile.pitchingAdvanced);
  const homeHr9 = pitchingHr9(homeProfile.pitchingAdvanced);
  const awayHr9 = pitchingHr9(awayProfile.pitchingAdvanced);
  const homeVenuePct = splitPct(homeStanding, 'home');
  const awayVenuePct = splitPct(awayStanding, 'away');
  const homeLastTenPct = splitPct(homeStanding, 'lastTen');
  const awayLastTenPct = splitPct(awayStanding, 'lastTen');
  const homeRunDiff = runDiffPerGame(homeStanding);
  const awayRunDiff = runDiffPerGame(awayStanding);
  const homePythagoreanPct = pythagoreanWinPct(homeStanding, homeProfile);
  const awayPythagoreanPct = pythagoreanWinPct(awayStanding, awayProfile);
  const homeSeasonLog5 = log5Probability(homeWinPct, awayWinPct);
  const homePythagoreanLog5 = log5Probability(homePythagoreanPct, awayPythagoreanPct);
  const homeRecentLog5 = log5Probability(homeLastTenPct, awayLastTenPct);
  const homeReferenceBlend =
    homeSeasonLog5 * 0.45 + homePythagoreanLog5 * 0.35 + homeRecentLog5 * 0.2;
  const homeMemoryBias = teamMemoryBias(modelMemory, homeTeam.id);
  const awayMemoryBias = teamMemoryBias(modelMemory, awayTeam.id);
  const matchupMemory = buildMatchupMemoryContext(modelMemory, awayTeam, homeTeam);

  const winPctEdge = homeWinPct - awayWinPct;
  const offenseEdge =
    (homeRpg - awayRpg) / 2.2 +
    (homeOps - awayOps) / 0.14 +
    (homeIso - awayIso) / 0.1 +
    (awayBatK - homeBatK) / 0.16 +
    (homeBatBb - awayBatBb) / 0.12;
  const preventionEdge =
    (awayEra - homeEra) / 1.8 +
    (awayWhip - homeWhip) / 0.55 +
    (homeKMinusBb - awayKMinusBb) / 0.16 +
    (awayHr9 - homeHr9) / 1.2;
  const spEdge = starterEdge(effectiveHomePitcherStats, effectiveAwayPitcherStats);
  const formEdge =
    (homeLastTenPct - awayLastTenPct) * 0.45 +
    (homeVenuePct - awayVenuePct) * 0.3 +
    (homeRunDiff - awayRunDiff) / 7;
  const pythagoreanEdge = homePythagoreanPct - awayPythagoreanPct;
  const log5Edge = homeReferenceBlend - 0.5;
  const h2hEdge = headToHead?.games > 0 ? (headToHead.homeProbability - 50) / 50 : 0;
  const memoryEdge = (homeMemoryBias - awayMemoryBias) * 0.12 + matchupMemory.edge * 0.25;
  const fatigueEdge = scheduleFatigueEdge(
    homeScheduleFatigue,
    awayScheduleFatigue,
    homePitcherRest,
    awayPitcherRest
  );
  const lineupEdge = lineupWinEdge(homeLineup, awayLineup, homeInjuries, awayInjuries);
  const bullpenEdge = bullpenAvailabilityEdge(homeBullpen, awayBullpen);

  // Platoon splits: team record vs opposing starter's handedness
  // Data already exists in standings splitRecords but was only displayed, not computed.
  const homeVsStarterHand = awayStarter?.pitchHand?.code === 'L'
    ? splitPct(homeStanding, 'left')
    : awayStarter?.pitchHand?.code === 'R'
      ? splitPct(homeStanding, 'right')
      : null;
  const awayVsStarterHand = homeStarter?.pitchHand?.code === 'L'
    ? splitPct(awayStanding, 'left')
    : homeStarter?.pitchHand?.code === 'R'
      ? splitPct(awayStanding, 'right')
      : null;
  const platoonEdge = (homeVsStarterHand != null && awayVsStarterHand != null)
    ? (homeVsStarterHand - awayVsStarterHand) * 0.6
    : 0;

  const offenseFatigueEdge =
    homeScheduleFatigue.offenseAdjustment - awayScheduleFatigue.offenseAdjustment;
  const evolutionControls = loadEvolutionControls();
  const offenseWeightMultiplier = moneylineWeightMultiplier(evolutionControls, 'offense');
  const starterWeightMultiplier = moneylineWeightMultiplier(evolutionControls, 'starting_pitcher');
  const bullpenWeightMultiplier = moneylineWeightMultiplier(evolutionControls, 'bullpen');
  const recentFormWeightMultiplier = moneylineWeightMultiplier(evolutionControls, 'recent_form');
  const homeAdvantageWeightMultiplier = moneylineWeightMultiplier(evolutionControls, 'home_advantage');

  // Situational weight adjustment
  const venueId = game.venue?.id || 0;
  const openerDetected = homeOpenerSituation.isOpener || awayOpenerSituation.isOpener;
  const sitWeights = situationalWeightAdjustment(venueId, openerDetected, gameDateYmd);

  const offenseComponent = clamp(offenseEdge + offenseFatigueEdge, -1.5, 1.5) * 0.3 * offenseWeightMultiplier * sitWeights.offense;
  const preventionComponent = clamp(preventionEdge, -1.35, 1.35) * 0.24;
  const starterComponent = clamp(spEdge, -1.35, 1.35) * 0.38 * starterWeightMultiplier * sitWeights.starting_pitcher;
  const bullpenComponent = bullpenEdge * 0.9 * bullpenWeightMultiplier * sitWeights.bullpen;
  const formComponent = clamp(formEdge, -0.3, 0.3) * 0.28 * recentFormWeightMultiplier * sitWeights.recent_form;
  const homeFieldComponent = 0.12 * homeAdvantageWeightMultiplier * sitWeights.home_advantage;

  // Weather edge: conditions that favor scoring (warm, wind out) slightly
  // increase variance which reduces the better team's edge. Conditions that
  // suppress scoring (cold, wind in) reduce variance and increase predictability.
  // Scale the existing weatherRunAdjustment down for moneyline impact.
  const weatherAdj = weatherRunAdjustment(game.weather);
  const weatherComponent = clamp(weatherAdj * -0.08, -0.06, 0.06);

  const matchupEdge =
    offenseComponent +
    preventionComponent +
    starterComponent +
    lineupEdge * (bothLineupsConfirmed({ away: awayLineup, home: homeLineup }) ? 0.95 : 0.85) +
    bullpenComponent +
    fatigueEdge * 0.7;
  // Record signal uses ONLY the Log5 blend. winPctEdge and pythagoreanEdge were
  // double-counted: homeReferenceBlend already folds in homeSeasonLog5 (season
  // win%) and homePythagoreanLog5 (pythag), so the linear winPctEdge/
  // pythagoreanEdge terms re-added the same information, over-weighting standings
  // vs today's matchup. Log5 is the correct matchup-probability transform of two
  // win rates; its weight is raised to carry the record signal the three
  // correlated terms previously split. Calibration absorbs the residual scale.
  const recordContextEdge =
    log5Edge * 0.34 +
    formComponent +
    h2hEdge * 0.025 +
    memoryEdge +
    platoonEdge;
  const recordDominated =
    Math.abs(recordContextEdge) > Math.abs(matchupEdge) * 1.25 && Math.abs(matchupEdge) < 0.18;

  // Lineup confirmation edge: when both teams post confirmed nine-hitter
  // lineups, the model's existing matchup edge (starter/offense/bullpen)
  // becomes more reliable because a key source of pre-game uncertainty
  // (replacement-level fill-ins, late scratches) is removed. We amplify the
  // existing directional edge by a small, capped amount toward the favored
  // side — never a free bump to either side, never overrides a near-pickem.
  const bothConfirmed = bothLineupsConfirmed({ away: awayLineup, home: homeLineup });
  const confirmationEdge = bothConfirmed
    ? clamp(Math.sign(matchupEdge) * Math.min(Math.abs(matchupEdge) * 0.08, 0.04), -0.04, 0.04)
    : 0;

  const edge = matchupEdge + (recordDominated ? recordContextEdge * 0.45 : recordContextEdge) + homeFieldComponent + weatherComponent + confirmationEdge;

  // Edge dampening: the model is systematically overconfident at higher edges.
  // Analysis of 773 moneyline outcomes + 59 staked bets:
  //   50-55% predicted → 56.8% actual (slightly underconfident ← sweet spot)
  //   55-60% predicted → 52.2% actual (overconfident by 5pp)
  //   65-70% predicted → 49.4% actual (overconfident by 18pp!)
  // AGGRESSIVE dampening: the model needs heavy compression at all levels.
  // Previous factors (0.82/0.70/0.58) were too mild — model_prob still hit
  // 59% for 27/32 bets. New factors compress harder, especially at high edge.
  const absEdge = Math.abs(edge);
  const dampeningFactor = absEdge < 0.25 ? 0.65
    : absEdge < 0.50 ? 0.50
    : 0.38;
  const dampenedEdge = edge * dampeningFactor;

  const rawHomeProbability = clamp(sigmoid(dampenedEdge) * 100, 35, 65);
  const rawAwayProbability = 100 - rawHomeProbability;
  // Calibrate at the source so every surface (cards, /picks, auto-alert, stored
  // picks, dashboard) shows the same honest, observed-frequency probability.
  // Moneyline uses low-sample shrinkage until the metadata says its isotonic map
  // has enough settled samples. Calibrate the favored side and derive the other
  // as its complement so the two always sum to 100. Keep the raw model probability
  // for conviction-based confidence/tiering.
  let homeProbability = rawHomeProbability;
  let awayProbability = rawAwayProbability;
  if (rawHomeProbability >= 50) {
    homeProbability = clamp(calibratePercent(rawHomeProbability, 'moneyline'), 30, 70);
    awayProbability = 100 - homeProbability;
  } else {
    awayProbability = clamp(calibratePercent(rawAwayProbability, 'moneyline'), 30, 70);
    homeProbability = 100 - awayProbability;
  }
  const modelBreakdown = {
    rawEdge: edge,
    dampenedEdge,
    dampeningFactor,
    matchupEdge,
    recordContextEdge,
    offenseEdge: offenseComponent,
    preventionEdge: preventionComponent,
    starterEdge: starterComponent,
    lineupEdge: lineupEdge * (bothConfirmed ? 0.95 : 0.85),
    confirmationEdge,
    bullpenEdge: bullpenComponent,
    fatigueEdge: fatigueEdge * 0.7,
    winPctEdge,
    pythagoreanEdge,
    log5Edge: log5Edge * 0.34,
    formEdge: formComponent,
    h2hEdge: h2hEdge * 0.025,
    memoryEdge,
    platoonEdge,
    homeFieldEdge: homeFieldComponent,
    weatherEdge: weatherComponent,
    recordDominated,
    rawHomeProbability,
    rawAwayProbability,
    pureHomeProbability: homeProbability,
    pureAwayProbability: awayProbability,
    activeWeightVersion: evolutionControls.activeWeightVersion,
    situationalWeights: sitWeights,
    predictionTier: determinePredictionTier(game.gameDate),
    sharpMoney: detectSharpMoneySignal(
      homeProbability >= awayProbability ? homeTeam.name : awayTeam.name,
      null,
      null
    )
  };

  const home = {
    id: homeTeam.id,
    name: homeTeam.name,
    abbreviation: homeTeam.abbreviation,
    record: homeStanding?.leagueRecord || game.teams.home.leagueRecord,
    starter: homeStarter,
    starterLine: homeOpenerSituation.isOpener
      ? 'Bulk pitcher TBD'
      : pitcherLabel(homeStarter, homePitcherStats),
    starterEra: homePitcherStats ? statEra(homePitcherStats) : null,
    openerSituation: homeOpenerSituation,
    winProbability: homeProbability,
    winProbabilityRaw: rawHomeProbability,
    pureModelProbability: homeProbability,
    marketInformedProbability: null
  };
  const away = {
    id: awayTeam.id,
    name: awayTeam.name,
    abbreviation: awayTeam.abbreviation,
    record: awayStanding?.leagueRecord || game.teams.away.leagueRecord,
    starter: awayStarter,
    starterLine: awayOpenerSituation.isOpener
      ? 'Bulk pitcher TBD'
      : pitcherLabel(awayStarter, awayPitcherStats),
    starterEra: awayPitcherStats ? statEra(awayPitcherStats) : null,
    openerSituation: awayOpenerSituation,
    winProbability: awayProbability,
    winProbabilityRaw: rawAwayProbability,
    pureModelProbability: awayProbability,
    marketInformedProbability: null
  };

  const reasons = createReasons({
    home,
    away,
    homeProfile,
    awayProfile,
    homePitcherStats: effectiveHomePitcherStats,
    awayPitcherStats: effectiveAwayPitcherStats,
    homeStarter,
    awayStarter,
    probHome: homeProbability,
    homeLineup,
    awayLineup,
    modelBreakdown
  });
  const modelReferenceLines = buildModelReferenceLines({
    away,
    home,
    awayPythagoreanPct,
    homePythagoreanPct,
    homeSeasonLog5,
    homePythagoreanLog5,
    homeRecentLog5,
    homeReferenceBlend
  });
  const firstInning = buildFirstInningProjection({
    away,
    home,
    awayProfile: awayFirstInningProfile,
    homeProfile: homeFirstInningProfile,
    awayPitcherStats: effectiveAwayPitcherStats,
    homePitcherStats: effectiveHomePitcherStats,
    awayPitcherFirstInningProfile,
    homePitcherFirstInningProfile,
    headToHead,
    venue: game.venue,
    weather: game.weather,
    awayLineup,
    homeLineup
  });
  const awayPitcherRecentLine = awayOpenerSituation.isOpener
    ? 'Bulk pitcher TBD'
    : awayPitcherRecent?.line || 'recent starts unavailable';
  const homePitcherRecentLine = homeOpenerSituation.isOpener
    ? 'Bulk pitcher TBD'
    : homePitcherRecent?.line || 'recent starts unavailable';

  return {
    gamePk: game.gamePk,
    status: game.status?.detailedState || 'Scheduled',
    start: formatGameTime(game.gameDate, MLB_TIMEZONE),
    startTime: game.gameDate || null,
    venue: game.venue?.name || 'TBD',
    // Surface the raw weather payload and computed park-factor context so the
    // dashboard quality report can honestly reflect which inputs were present
    // (previously it read weather_detail/park_detail, fields that never existed).
    weather: game.weather || null,
    parkFactor: parkFactorContext(homeTeam),
    away,
    home,
    contextLine: `${standingContext(away, awayStanding, 'away')} | ${standingContext(home, homeStanding, 'home')}`,
    advancedLine: `${advancedContext(away, awayProfile)} | ${advancedContext(home, homeProfile)}`,
    matchupSplitLine: `${matchupSplitLine(away, awayStanding, homeStarter, 'away')} | ${matchupSplitLine(home, homeStanding, awayStarter, 'home')}`,
    pitcherRecentLine: `${away.abbreviation || away.name} SP ${awayPitcherRecentLine} | ${home.abbreviation || home.name} SP ${homePitcherRecentLine}`,
    bullpenLine: `${away.abbreviation || away.name} bullpen ${awayBullpen.line} | ${home.abbreviation || home.name} bullpen ${homeBullpen.line}`,
    fatigueLines: fatigueFlagLines(away, home, awayScheduleFatigue, homeScheduleFatigue, awayPitcherRest, homePitcherRest),
    injuryLine: `${injuryCountLabel(away, awayInjuries)} | ${injuryCountLabel(home, homeInjuries)}`,
    injuryDetailLines: [
      ...injuryDetailLines(away, awayInjuries),
      ...injuryDetailLines(home, homeInjuries)
    ],
    lineupLine: `${lineupStatusLine(away, awayLineup)} | ${lineupStatusLine(home, homeLineup)}`,
    lineups: {
      away: awayLineup,
      home: homeLineup
    },
    injuries: {
      away: awayInjuries,
      home: homeInjuries
    },
    modelReferenceLine: modelReferenceLines.join(' | '),
    modelReferenceLines,
    modelBreakdownLine: [
      edgeComponentText('matchup', modelBreakdown.matchupEdge, away, home),
      edgeComponentText('record/H2H', modelBreakdown.recordContextEdge, away, home),
      edgeComponentText('SP', modelBreakdown.starterEdge, away, home),
      edgeComponentText('lineup', modelBreakdown.lineupEdge, away, home),
      edgeComponentText('bullpen', modelBreakdown.bullpenEdge, away, home),
      bothConfirmed && Math.abs(confirmationEdge) >= 0.005
        ? edgeComponentText('lineup✓', confirmationEdge, away, home)
        : null
    ].filter(Boolean).join(' | '),
    modelBreakdown,
    modelReference: {
      awayPythagoreanPct: Math.round(awayPythagoreanPct * 100),
      homePythagoreanPct: Math.round(homePythagoreanPct * 100),
      homeSeasonLog5: Math.round(homeSeasonLog5 * 100),
      homePythagoreanLog5: Math.round(homePythagoreanLog5 * 100),
      homeRecentLog5: Math.round(homeRecentLog5 * 100),
      homeReferenceBlend: Math.round(homeReferenceBlend * 100)
    },
    pitcherRecent: {
      away: awayPitcherRecent,
      home: homePitcherRecent
    },
    bullpen: {
      away: awayBullpen,
      home: homeBullpen
    },
    scheduleFatigue: {
      away: awayScheduleFatigue,
      home: homeScheduleFatigue,
      pitcherRest: {
        away: awayPitcherRest,
        home: homePitcherRest
      },
      edge: fatigueEdge
    },
    memoryAdjustment: {
      away: awayMemoryBias,
      home: homeMemoryBias,
      matchup: matchupMemory.edge,
      note: matchupMemory.note
    },
    matchupMemory,
    headToHead,
    firstInning,
    winner: homeProbability >= awayProbability ? home : away,
    reasons
  };
}

export const __mlbTestInternals = {
  actualStarterForSide,
  addPitcherFirstInningGame,
  buildFirstInningProjection,
  firstInningHistoryEndDate,
  firstInningRunsChargedToPitcher,
  pitcherFirstInningRisk
};

export async function getMlbPredictions(dateYmd = dateInTimezone('Asia/Jakarta'), modelMemory = {}) {
  const season = seasonFromDate(dateYmd);
  const games = await fetchSchedule(dateYmd);
  if (games.length === 0) return [];

  const teamIds = [
    ...new Set(games.flatMap((game) => [game.teams.away.team.id, game.teams.home.team.id]))
  ];

  // Each fetch falls back to an empty Map so one transient API failure degrades
  // that single signal (the model has DEFAULTS for missing data) instead of
  // throwing out of getMlbPredictions and zeroing the entire slate.
  const warnFetch = (label) => (error) => {
    console.warn(`getMlbPredictions: ${label} fetch failed, using empty data:`, error.message);
    return new Map();
  };
  const [teamStats, standings, firstInningProfiles, bullpenProfiles, scheduleFatigueProfiles, injuryProfiles] = await Promise.all([
    fetchTeamStats(season).catch(warnFetch('teamStats')),
    fetchStandings(season, dateYmd).catch(warnFetch('standings')),
    fetchFirstInningProfiles(season, dateYmd).catch(warnFetch('firstInningProfiles')),
    fetchBullpenProfiles(teamIds, dateYmd).catch(warnFetch('bullpenProfiles')),
    fetchScheduleFatigueProfiles(teamIds, dateYmd).catch(warnFetch('scheduleFatigueProfiles')),
    fetchInjuryProfiles(teamIds, dateYmd, season).catch(warnFetch('injuryProfiles'))
  ]);
  const probablePitcherIds = [
    ...new Set(
      games
        .flatMap((game) => [
          game.teams.away.probablePitcher?.id,
          game.teams.home.probablePitcher?.id
        ])
        .filter(Boolean)
    )
  ];

  const pitcherStats = new Map();
  const pitcherDetails = new Map();
  const pitcherRecentStarts = new Map();
  await Promise.all(
    probablePitcherIds.map(async (personId) => {
      try {
        pitcherDetails.set(personId, await fetchPerson(personId));
      } catch {
        pitcherDetails.set(personId, null);
      }

      try {
        pitcherStats.set(personId, await fetchPitcherStats(personId, season));
      } catch {
        pitcherStats.set(personId, null);
      }

      try {
        pitcherRecentStarts.set(personId, await fetchPitcherRecentStarts(personId, season));
      } catch {
        pitcherRecentStarts.set(personId, null);
      }
    })
  );

  const headToHeadStats = new Map();
  await Promise.all(
    games.map(async (game) => {
      try {
        headToHeadStats.set(game.gamePk, await fetchHeadToHead(game, season, dateYmd));
      } catch {
        headToHeadStats.set(game.gamePk, {
          games: 0,
          awayWins: 0,
          homeWins: 0,
          awayProbability: 50,
          homeProbability: 50,
          firstInning: {
            games: 0,
            runGames: 0,
            probability: DEFAULTS.gameFirstInningRunRate * 100
          }
        });
      }
    })
  );

  const lineupProfiles = new Map();
  await Promise.all(
    games.map(async (game) => {
      try {
        lineupProfiles.set(game.gamePk, await fetchGameLineupProfile(game.gamePk));
      } catch {
        lineupProfiles.set(game.gamePk, { away: null, home: null });
      }
    })
  );

  return games.map((game) =>
    predictGame(
      game,
      teamStats,
      standings,
      pitcherStats,
      pitcherDetails,
      pitcherRecentStarts,
      bullpenProfiles,
      scheduleFatigueProfiles,
      headToHeadStats.get(game.gamePk),
      firstInningProfiles,
      injuryProfiles,
      lineupProfiles.get(game.gamePk),
      modelMemory
    )
  );
}

export async function getMlbScheduleChoices(dateYmd = dateInTimezone('Asia/Jakarta')) {
  const games = await fetchSchedule(dateYmd);

  return games.map((game) => ({
    gamePk: game.gamePk,
    status: game.status?.detailedState || 'Scheduled',
    abstractGameState: game.status?.abstractGameState || '',
    start: formatGameTime(game.gameDate, MLB_TIMEZONE),
    startTime: game.gameDate || null,
    venue: game.venue?.name || 'TBD',
    away: {
      id: game.teams.away.team.id,
      name: game.teams.away.team.name,
      abbreviation: game.teams.away.team.abbreviation
    },
    home: {
      id: game.teams.home.team.id,
      name: game.teams.home.team.name,
      abbreviation: game.teams.home.team.abbreviation
    },
    probablePitchers: {
      away: game.teams.away.probablePitcher?.fullName || 'TBD',
      home: game.teams.home.probablePitcher?.fullName || 'TBD'
    }
  }));
}

export async function getFinalGameResults(dateYmd = dateInTimezone('Asia/Jakarta')) {
  const games = await fetchSchedule(dateYmd);

  return games
    .filter((game) => game.status?.abstractGameState === 'Final')
    .filter((game) =>
      Number.isFinite(toNumber(game.teams?.away?.score, Number.NaN)) &&
      Number.isFinite(toNumber(game.teams?.home?.score, Number.NaN))
    )
    .map((game) => finalGameResult(game, dateYmd));
}

export function formatPredictions(
  dateYmd,
  predictions,
  { maxGames = 8, teamFilter = '', includeAdvanced = true } = {}
) {
  const normalizedFilter = teamFilter.toLowerCase();
  const filtered = normalizedFilter
    ? predictions.filter((item) =>
        [item.away.name, item.home.name, item.away.abbreviation, item.home.abbreviation]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(normalizedFilter))
      )
    : predictions;

  if (filtered.length === 0) {
    return normalizedFilter
      ? [uiTitle('⚾', 'MLB Pre-game Alert'), uiKV('📅', 'Tanggal', dateYmd), '', uiBullet('⚠️', `Tidak ada game MLB untuk filter "${teamFilter}".`)].join('\n')
      : [uiTitle('⚾', 'MLB Pre-game Alert'), uiKV('📅', 'Tanggal', dateYmd), '', uiBullet('⚠️', 'Tidak ada game MLB pada tanggal ini.')].join('\n');
  }

  const shown = filtered.slice(0, maxGames);
  const lines = [[uiTitle('⚾', 'MLB Pre-game Alert'), uiKV('📅', 'Tanggal', dateYmd)].join('\n'), GAME_SEPARATOR];

  if (!includeAdvanced) {
    for (const item of shown) {
      lines.push(compactPredictionBlock(item));
      lines.push(SECTION_SEPARATOR);
    }

    if (filtered.length > shown.length) {
      lines.push(uiBullet('➕', `${filtered.length - shown.length} game lain | pakai /deep untuk semua statistik detail.`));
    }

    lines.push(uiBullet('⚠️', 'Probabilitas adalah estimasi model, bukan kepastian.'));
    return lines.join('\n\n');
  }

  for (const item of shown) {
    const displayProb = displayedProbabilities(item);
    const pick = agentPick(item);
    const agentActive = Boolean(item.agentAnalysis);
    const openerLines = openerAlertLines(item);
    const contextLines = [
      ...splitInfoLine(item.contextLine),
      ...(item.matchupMemory?.games > 0 ? [uiKV('•', 'Memory matchup', item.matchupMemory.note)] : [])
    ];
    const splitLines = splitInfoLine(item.matchupSplitLine);
    const bullpenLines = splitInfoLine(item.bullpenLine);
    const fatigueLines = item.fatigueLines?.length
      ? item.fatigueLines.map((line) => uiBullet('•', line))
      : [];
    const pitcherRecentLines = splitInfoLine(item.pitcherRecentLine);
    const advancedLines = splitInfoLine(item.advancedLine);
    const modelReferenceLines = item.modelReferenceLines?.length
      ? item.modelReferenceLines.map((line) => uiBullet('•', line))
      : splitInfoLine(item.modelReferenceLine);
    const injuryLines = item.injuryDetailLines?.length
      ? item.injuryDetailLines.map((line) => uiBullet('•', line))
      : splitInfoLine(item.injuryLine);
    const firstInningReasonLines = item.firstInning.agent?.reasons?.length
      ? item.firstInning.agent.reasons.map((reason) => uiBullet('•', reason))
      : item.firstInning.reasons.map((reason) => uiBullet('•', reason));
    const h2hSummary =
      item.headToHead?.games > 0
        ? `${item.away.abbreviation || item.away.name} ${item.headToHead.awayWins}-${item.headToHead.homeWins} ${item.home.abbreviation || item.home.name}`
        : 'Belum ada final H2H musim ini';
    lines.push(
      [
        uiKV('🏟️', 'Matchup', `${item.away.name} @ ${item.home.name}`),
        uiKV('🕒', 'Waktu', item.start),
        uiKV('📍', 'Stadium', item.venue),
        '',
        SECTION_SEPARATOR,
        uiSection('📊', 'Probabilitas'),
        agentActive
          ? uiKV('🤖', 'Agent', `${displayedWinProbText(item.away, displayProb.away)} | ${displayedWinProbText(item.home, displayProb.home)}`)
          : uiKV('📊', 'Model', `${winProbText(item.away)} | ${winProbText(item.home)}`),
        agentActive ? uiKV('📐', 'Baseline', `${winProbText(item.away)} | ${winProbText(item.home)}`) : null,
        uiKV('🤝', 'H2H', h2hSummary),
        uiKV('🎯', 'H2H Prob', `${h2hProbText(item.away, item.headToHead?.awayProbability ?? 50)} | ${h2hProbText(item.home, item.headToHead?.homeProbability ?? 50)}`),
        item.modelBreakdownLine ? uiKV('🧮', 'Model source', item.modelBreakdownLine) : null,
        '',
        SECTION_SEPARATOR,
        uiKV('✅', `Pick ${agentActive ? 'Agent' : 'Model'}`, `${pick.name}${agentActive ? ` | ${item.agentAnalysis.confidence}` : ''}`),
        ...bettingSafetyLines(item, pick),
        ...moneylineDecisionLines(item),
        ...openerLines,
        ...lateUpdateLines(item),
        uiKV('🔥', 'SP', `${item.away.starterLine} vs ${item.home.starterLine}`),
        '',
        SECTION_SEPARATOR,
        uiSection('📌', 'Context'),
        ...contextLines,
        '',
        uiSection('⚾', 'Splits'),
        ...splitLines,
        '',
        uiSection('🧤', 'Bullpen'),
        ...bullpenLines,
        ...fatigueLines,
        '',
        uiSection('🏥', 'Injury Report'),
        ...injuryLines,
        '',
        ...(playerImpactLines(item).length
          ? [uiSection('🧩', 'Player Impact'), ...playerImpactLines(item), '']
          : []),
        uiSection('📈', 'SP Recent'),
        ...pitcherRecentLines,
        includeAdvanced ? '' : null,
        includeAdvanced ? uiSection('🔎', 'Advanced') : null,
        ...(includeAdvanced ? advancedLines : []),
        includeAdvanced ? '' : null,
        includeAdvanced ? uiSection('🧠', 'ML Reference') : null,
        ...(includeAdvanced ? modelReferenceLines : []),
        '',
        SECTION_SEPARATOR,
        agentActive ? uiSection('💡', 'Analisa Agent') : uiSection('💡', 'Alasan'),
        agentActive
          ? item.agentAnalysis.reasons.map((reason) => uiBullet('•', reason)).join('\n')
          : item.reasons.join(' '),
        agentActive ? uiKV('⚠️', 'Risk', item.agentAnalysis.risk) : null,
        agentActive ? uiKV('🧠', 'Memory', item.agentAnalysis.memoryNote) : null,
        '',
        SECTION_SEPARATOR,
        uiSection('🏁', 'First Inning'),
        uiKV('🏁', 'Run in 1st', firstInningPickText(item.firstInning)),
        uiKV('📐', 'Baseline', `${item.firstInning.baselinePick} | ${percent(item.firstInning.baselineProbability)}`),
        uiKV('📊', 'Top/Bottom 1', `${percent(item.firstInning.topRate)} | ${percent(item.firstInning.bottomRate)}`),
        firstInningSignalLine(item.firstInning) ? uiKV('🌤️', 'YRFI signals', firstInningSignalLine(item.firstInning)) : null,
        '',
        ...splitInfoLine(`${item.firstInning.awayProfileLine} | ${item.firstInning.homeProfileLine}`),
        '',
        ...firstInningReasonLines,
      ]
        .filter((line) => line !== null)
        .join('\n')
    );
    lines.push(GAME_SEPARATOR);
  }

  if (filtered.length > shown.length) {
    lines.push(uiBullet('➕', `${filtered.length - shown.length} game lain | pakai /game TEAM untuk cek spesifik.`));
  }

  lines.push(uiBullet('⚠️', 'Probabilitas adalah estimasi model, bukan kepastian.'));
  return lines.join('\n\n');
}
