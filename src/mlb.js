import {
  clamp,
  dateInTimezone,
  formatGameTime,
  isFiniteNumber,
  percent,
  safeFixed,
  sigmoid,
  toNumber
} from './utils.js';
import { UI_LINE, UI_THIN_LINE, uiBullet, uiKV, uiSection, uiTitle } from './telegramFormat.js';
import { getEvolutionRule, loadEvolutionControls, moneylineWeightMultiplier } from './evolutionControls.js';
import {
  calibratePercent,
  getCalibrationArtifact,
  hasCalibrationMap
} from './calibration.js';
import { loadConfig } from './config.js';
import {
  evaluateMoneyline,
  listRetiredRulesForProfile,
  resolveRuleProfile
} from './rule_engine.js';
import { computeTravelFatigueContext } from './mlb_stadiums.js';
import { fetchLiveStatcastBundle, sliceGameStatcast } from './statcast_collector.js';
import {
  ageMinutes as temporalAgeMinutes,
  assertPregameEligible,
  checkDataFreshness,
  filterSplitsBeforeDate
} from './temporal_contract.js';
import {
  predictGameMoneylineCore,
  buildCoreInputsSnapshot,
  PREDICTION_CORE_MODEL_VERSION,
  starterSeasonEdge as coreStarterSeasonEdge,
  starterRecentEdge as coreStarterRecentEdge,
  starterEdge as coreStarterEdge,
  lineupWinEdge as coreLineupWinEdge,
  bullpenAvailabilityEdge as coreBullpenAvailabilityEdge,
  shrinkPitcherStats,
  guardFavoredCalibrationPercent
} from './core/prediction_core.js';
import {
  CONTROL_FEATURE_SCHEMA_VERSION,
  HEURISTIC_V1_MODEL_ID
} from './core/model_ids.js';
import {
  CONTROL_FEATURE_ROLES,
  CONTROL_FEATURE_ROLE_VERSION
} from './core/feature_roles.js';
import { marketAnchoredProbabilities, powerDevigProbabilities } from './market_residual.js';
import { attachPickConfidence, buildPickConfidence } from './confidence_signals.js';

const MLB_BASE_URL = 'https://statsapi.mlb.com/api/v1';
const _mlbConfig = loadConfig();
const MLB_TIMEZONE = _mlbConfig.timezone;
const GAME_SEPARATOR = UI_LINE;
const SECTION_SEPARATOR = UI_THIN_LINE;
// Defaults mirror config.minimumMoneylineEdge (percent scale). Live path reads config.
const DEFAULT_MONEYLINE_VALUE_EDGE_THRESHOLD = 5.0;
// Soft secondary gates (thin matchup / incomplete lineup) still use 4.0 unless
// rules JSON params override — edge floor itself is the configurable hard gate.
const STRONG_VALUE_EDGE_THRESHOLD = 4.0;
// Calibrated win-probability floor for a graded VALUE bet. Deep analysis of
// 1105 moneyline outcomes (2026 run) showed the model is OVERCONFIDENT at high probs:
//   50-55% predicted → ~56% actual (underconfident ← BEST bucket)
//   55-60% predicted → ~53% actual (overconfident)
//   65-70% predicted → ~51% actual (overconfident)
// Floor stays at 52% so VALUE can land in the better-calibrated band.
// Historical VALUE WR still lags (~49%) — selection gates + real-form signals
// must carry the lift, not a higher conviction floor.
const MIN_VALUE_PROBABILITY = 50.0;
// Team quality gate: team must have >= this season win% to qualify for VALUE.
// Picks on teams with .520+ WR: 70.2% historical accuracy.
// Picks on sub-.500 teams: 35.2% accuracy. Market prices them correctly.
const MIN_TEAM_QUALITY_PCT = 0.520;
// Away underdog limit: block VALUE bets on away teams at plus-money odds
// beyond this threshold. Away underdogs are the model's worst leak:
// AWAY+VALUE = 44.9% WR. This kills the away longshot trap.
const MAX_AWAY_UNDERDOG_ODDS = 115;
// Rolling team form window (MLB StatsAPI byDateRange). Season stats lag true
// current strength; 21 calendar days ≈ 18-19 games and is leakage-safe when
// endDate is predictionDate-1.
const ROLLING_FORM_DAYS = 21;
// Bayesian market blend weight. Market de-vig implied is the strongest single
// pre-game predictor; pure model alone plateaus ~55%. Raise from 12% → 22% so
// displayed pick/winner incorporates real market information without letting
// the book fully overwrite model edge (VALUE still grades pure model).
const MARKET_BLEND_WEIGHT = 0.22;
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
  hr9: 1.1
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

function americanToContinuousCents(value) {
  const odds = toNumber(value, Number.NaN);
  if (!Number.isFinite(odds) || odds === 0) return null;
  if (odds >= 100) return odds - 100;
  if (odds <= -100) return -(Math.abs(odds) - 100);
  return odds;
}

// --- Sharp Money Detection ---
export function detectSharpMoneySignal(modelPick, openingOdds, closingOdds) {
  if (!openingOdds || !closingOdds) return { direction: 'neutral', magnitude: 0, steam: false, risk: 0 };
  const opening = toNumber(openingOdds[modelPick], 0);
  const closing = toNumber(closingOdds[modelPick], 0);
  if (!opening || !closing) return { direction: 'neutral', magnitude: 0, steam: false, risk: 0 };

  const openCents = americanToContinuousCents(opening);
  const closeCents = americanToContinuousCents(closing);
  if (openCents === null || closeCents === null) {
    return { direction: 'neutral', magnitude: 0, steam: false, risk: 0 };
  }

  // Continuous cents around ±100 prevents +105 -> -110 pick'em crossings from
  // inflating into a fake -215 cent move (true move is -15 cents).
  const movement = closeCents - openCents;
  const magnitude = Math.round(Math.abs(movement) * 10) / 10;
  const direction = magnitude < 3 ? 'neutral' : movement < 0 ? 'toward_model' : 'against_model';
  const steam = magnitude >= 20;

  let risk = 0;
  if (direction === 'against_model') risk += Math.min(magnitude * 0.015, 0.30);
  if (steam && direction === 'against_model') risk += 0.20;
  if (direction === 'toward_model') risk -= Math.min(magnitude * 0.008, 0.15);

  return { direction, magnitude, steam, risk: clamp(risk, 0, 1) };
}

// --- Prediction Tier ---
function determinePredictionTier(gameStartTime, now = new Date()) {
  if (!gameStartTime) return { tier: 'standard', label: 'Standard', confidenceCap: 85 };
  const current = now instanceof Date ? now : new Date(now);
  const start = new Date(gameStartTime);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(current.getTime())) {
    return { tier: 'standard', label: 'Standard', confidenceCap: 85 };
  }
  const hoursToGame = (start - current) / 3600000;
  // Already started / in-play: do not treat as final pregame tier.
  if (hoursToGame < 0) {
    return { tier: 'in_play', label: 'In Play', confidenceCap: 0, reject: true };
  }
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

function shiftYmd(dateYmd, dayDelta) {
  const date = new Date(`${dateYmd}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateYmd;
  date.setUTCDate(date.getUTCDate() + dayDelta);
  return date.toISOString().slice(0, 10);
}

function aggregateDateRange(season, predictionDateYmd) {
  const predictionDate = String(predictionDateYmd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(predictionDate)) return null;

  const parsed = new Date(`${predictionDate}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== predictionDate) {
    return null;
  }

  const startDate = seasonStartDate(season);
  const endDate = shiftYmd(predictionDate, -1);
  if (endDate < startDate) return null;
  return { startDate, endDate };
}

function rollingFormWindow(dateYmd, days = ROLLING_FORM_DAYS) {
  const endDate = shiftYmd(dateYmd, -1);
  const startDate = shiftYmd(endDate, -(Math.max(1, days) - 1));
  return { startDate, endDate };
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
    away: item.away.winProbability,
    home: item.home.winProbability
  };
}

function agentPick(item) {
  return item.winner;
}

function displayedWinProbText(team, value) {
  return `${team.abbreviation || team.name} ${percent(value)}`;
}

function h2hProbText(team, probability) {
  return `${team.abbreviation || team.name} ${percent(probability)}`;
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
  if (!Number.isFinite(odds) || Math.abs(odds) < 100) return null;
  const probabilityValue = odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
  return probabilityValue * 100;
}

// Two-sided de-vig for a SAME-BOOK paired market only. Independently shopped
// best-home and best-away from different books can produce a synthetic pair
// with negative overround; that must not be treated as a fair market.
function devigMoneylinePercent(awayOdds, homeOdds, options = {}) {
  const awayImplied = americanImpliedProbabilityPercent(awayOdds);
  const homeImplied = americanImpliedProbabilityPercent(homeOdds);
  if (awayImplied === null || homeImplied === null) return null;
  const total = awayImplied + homeImplied;
  if (!Number.isFinite(total) || total <= 0) return null;
  const overround = total - 100;
  const sameBook = options.sameBook !== false;
  // Cross-book synthetic pairs: allow only if overround is non-negative and
  // caller explicitly marks sameBook=false as executable-only (no fair claim).
  if (!sameBook) {
    return {
      away: null,
      home: null,
      overround: round1(overround),
      sameBook: false,
      synthetic: true,
      usableAsFair: false
    };
  }
  if (overround < -0.05) {
    // Negative overround on an alleged same-book pair is not a coherent market.
    return {
      away: null,
      home: null,
      overround: round1(overround),
      sameBook: true,
      synthetic: false,
      usableAsFair: false
    };
  }
  const power = powerDevigProbabilities(awayImplied / 100, homeImplied / 100);
  const fairAway = power ? power.probA * 100 : (awayImplied / total) * 100;
  const fairHome = power ? power.probB * 100 : (homeImplied / total) * 100;
  return {
    away: fairAway,
    home: fairHome,
    overround: round1(overround),
    method: power ? power.method : 'proportional',
    exponent: power?.exponent ?? null,
    sameBook: true,
    synthetic: false,
    usableAsFair: true
  };
}

function moneylineBooksAreSame(currentOdds) {
  if (!currentOdds) return false;
  const homeSide = currentOdds.homeMoneylineBook || null;
  const awaySide = currentOdds.awayMoneylineBook || null;
  // Explicit side books: only same-book when both present and equal.
  if (homeSide && awaySide) {
    return String(homeSide).toLowerCase() === String(awaySide).toLowerCase();
  }
  // Conflicting partial provenance (one side shopped, other unknown) → not same-book.
  if (homeSide || awaySide) {
    // Single shared moneylineBook may still represent a paired book if no conflict.
    // If only one side book is known and matches moneylineBook, treat as same-book;
    // if it differs from moneylineBook, refuse fair de-vig.
    const generic = currentOdds.moneylineBook || null;
    if (!generic) return false;
    const known = homeSide || awaySide;
    return String(known).toLowerCase() === String(generic).toLowerCase();
  }
  // Legacy payload: only moneylineBook set (tests + older snapshots) → same-book pair.
  return Boolean(currentOdds.moneylineBook);
}

function round1(value) {
  const n = toNumber(value, 0);
  // Compensate IEEE-754 representation jitter (e.g. 8.749999999999991 -> 8.8) and normalize -0.
  const rounded = Math.round((n + (n >= 0 ? 1e-12 : -1e-12)) * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

// American odds → net profit multiple per 1 unit staked (b in the Kelly formula).
// -150 → 0.667 (risk 1 to win 0.667); +130 → 1.30. Rejects invalid odds in (-100, 100).
function americanProfitMultiple(value) {
  const odds = Number(value);
  if (!Number.isFinite(odds) || Math.abs(odds) < 100) return null;
  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
}

// Raw unrounded net executable Expected Value (%) on offered American odds.
function rawExpectedValuePercent(modelProbabilityPercent, odds) {
  const b = americanProfitMultiple(odds);
  if (b === null) return null;
  const p = toNumber(modelProbabilityPercent, Number.NaN) / 100;
  if (!Number.isFinite(p) || !(p > 0) || p >= 1) return null;
  return (p * (1 + b) - 1) * 100;
}

// Net executable Expected Value (%) on the actual offered American odds:
//   EV% = (p * decimalOdds - 1) * 100
// Unlike probability-point edge (p - p_fair), executable EV accounts for
// vig and payout slope consistently across heavy favorites and underdogs.
export function expectedValuePercent(modelProbabilityPercent, odds) {
  const raw = rawExpectedValuePercent(modelProbabilityPercent, odds);
  return raw === null ? null : round1(raw);
}

// Uncertainty shrinkage multiplier for Kelly sizing in [0.5, 1.0].
// Penalizes missing/fallback features, unconfirmed lineups, and confirmed
// lineups that contradict the macro matchup (confirmationSignal separated from
// mean probability shift in Phase 3.3).
export function kellyUncertaintyMultiplier(item) {
  if (!item || typeof item !== 'object') return 1.0;
  const fallbackCount = Math.max(0, toNumber(item.featureFallbacks?.count, 0));
  const fallbackScale = 1 - Math.min(fallbackCount, 4) * 0.08; // up to -32%
  let lineupScale = 1.0;
  if (item.lineups) {
    const away = item.lineups.away;
    const home = item.lineups.home;
    const bothConfirmed = Boolean(
      away?.confirmed && home?.confirmed && toNumber(away?.count, 0) >= 9 && toNumber(home?.count, 0) >= 9
    );
    if (!bothConfirmed) {
      lineupScale = 0.85;
    } else if (item.modelBreakdown?.lineupOpposesMatchup === true) {
      lineupScale = 0.92;
    }
  }
  return clamp(Math.round(fallbackScale * lineupScale * 1000) / 1000, 0.5, 1.0);
}

function configuredMaxSingleBetPercent() {
  const configured = toNumber(loadConfig().maxSingleBetPercent, 2.5);
  return configured > 0 ? configured : 2.5;
}

function moneylineValueEvThreshold() {
  const configured = toNumber(loadConfig().minimumMoneylineEv, 0.02);
  return configured <= 1 ? configured * 100 : configured;
}

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
  let modelProbability = pureModelProbabilityForSide(item, side);

  // Fair de-vig only when both sides share the same bookmaker, OR when
  // attachCurrentOdds also captured a coherent same-book consensus no-vig pair.
  // Best executable side price may still come from line shopping.
  const sameBook = moneylineBooksAreSame(item.currentOdds);
  const devig = devigMoneylinePercent(
    item.currentOdds?.awayMoneyline,
    item.currentOdds?.homeMoneyline,
    { sameBook }
  );
  const sameBookConsensus = item.currentOdds?.sameBookFair;
  const consensusSideFair =
    sameBookConsensus &&
    isFiniteNumber(sameBookConsensus[side]) &&
    Number(sameBookConsensus[side]) > 0
      ? Number(sameBookConsensus[side])
      : null;
  const fairFromDevig =
    devig?.usableAsFair && devig[side] != null
      ? side === 'away'
        ? devig.away
        : devig.home
      : consensusSideFair;
  const fairSource =
    devig?.usableAsFair && devig[side] != null
      ? 'same_book_devig'
      : consensusSideFair != null
        ? 'same_book_consensus_devig'
        : 'raw_implied_executable';
  const fairProbability = fairFromDevig != null ? fairFromDevig : impliedProbability;

  // Market-anchored residual: when explicitly enabled, grading probability
  // borrows a small amount of no-vig market signal. The model's own pick and
  // displayed win probabilities stay untouched; this only changes VALUE
  // probability/edge math so sizing/edge are less miscalibrated.
  const anchored = marketAnchoredProbabilities({
    modelHomeProbability: pureModelProbabilityForSide(item, 'home'),
    modelAwayProbability: pureModelProbabilityForSide(item, 'away'),
    homeMoneyline: item.currentOdds?.homeMoneyline,
    awayMoneyline: item.currentOdds?.awayMoneyline
  });
  const gradingProbability = anchored ? (side === 'away' ? anchored.away : anchored.home) : modelProbability;
  const edge = gradingProbability - fairProbability;
  const rawEvPct = rawExpectedValuePercent(gradingProbability, odds);
  const expectedValuePct = rawEvPct === null ? null : round1(rawEvPct);

  // Disagreement flag (model away vs market home). Sizing boost neutralized from
  // 1.5x -> 1.0x in Fase 2: opposing a sharp market carries higher epistemic
  // uncertainty and should not amplify Kelly stakes.
  const modelHomeProb = pureModelProbabilityForSide(item, 'home');
  const modelAwayProb = 100 - modelHomeProb;
  const sideFair = toNumber(fairProbability, 50);
  const marketHomeProb = side === 'home' ? sideFair : 100 - sideFair;
  const marketAwayProb = 100 - marketHomeProb;
  const isDisagreement = modelAwayProb > modelHomeProb && marketHomeProb > marketAwayProb;
  const disagreementBoost = 1.0;

  const sideBook =
    side === 'away'
      ? item.currentOdds?.awayMoneylineBook || item.currentOdds?.moneylineBook
      : item.currentOdds?.homeMoneylineBook || item.currentOdds?.moneylineBook;

  // Multi-factor confidence (SP/form/H2H/injury/lineup) & estimation uncertainty
  // shrinkage adjust Quarter-Kelly stake, bounded by maxSingleBetPercent.
  const factorConfidence = buildPickConfidence(item, side);
  const confidenceMultiplier = factorConfidence?.stakeMultiplier ?? 1.0;
  const uncertaintyMultiplier = kellyUncertaintyMultiplier(item);
  const maxSingleBet = configuredMaxSingleBetPercent();

  const hasPositiveEv = rawEvPct !== null && rawEvPct > 0;
  const baseKelly = edge > 0 && hasPositiveEv ? quarterKellyPercent(gradingProbability, odds) : null;
  const rawAdjustedKelly =
    baseKelly !== null
      ? round1(baseKelly * disagreementBoost * confidenceMultiplier * uncertaintyMultiplier)
      : null;
  const kellyStakePercent =
    rawAdjustedKelly !== null && rawAdjustedKelly > 0
      ? Math.min(maxSingleBet, rawAdjustedKelly)
      : null;

  return {
    side,
    teamId: team?.id,
    teamName: team?.name,
    teamAbbreviation: team?.abbreviation,
    odds,
    book: sideBook || 'market',
    modelProbability: round1(modelProbability),
    gradingProbability: round1(gradingProbability),
    marketResidualWeight: anchored ? anchored.weight : 0,
    impliedProbability: round1(impliedProbability),
    fairProbability: round1(fairProbability),
    fairSource,
    devigMethod: devig?.usableAsFair ? (devig.method || 'power') : (consensusSideFair != null ? 'sharp_weighted_power' : 'raw_implied'),
    sameBookDevig: Boolean(fairFromDevig != null),
    overround: devig ? round1(devig.overround) : null,
    edge: round1(edge),
    expectedValuePct,
    disagreementBoost,
    isDisagreement: isDisagreement && side === 'away',
    confidenceLevel: factorConfidence?.level ?? null,
    confidenceScore: factorConfidence?.score ?? null,
    confidenceSummary: factorConfidence?.summary ?? null,
    confidenceMultiplier,
    uncertaintyMultiplier,
    maxSingleBetPercent: maxSingleBet,
    // Uncertainty-adjusted Quarter-Kelly stake (% of bankroll), capped per bet.
    // null when there is no positive executable-EV stake.
    kellyStakePercent
  };
}

function moneylineValueEdgeThreshold() {
  const configured = toNumber(loadConfig().minimumMoneylineEdge, 0.05);
  return configured <= 1 ? configured * 100 : configured;
}

function moneylineOddsMaxAgeMinutes() {
  const configured = toNumber(loadConfig().moneylineOddsMaxAgeMinutes, 10);
  return configured > 0 ? configured : 10;
}

function moneylineOddsAgeMinutes(item, now = Date.now()) {
  const timestamp =
    item?.currentOdds?.oddsFetchedAt ||
    item?.currentOdds?.fetchedAt ||
    item?.currentOdds?.updatedAt;
  // Future timestamps must NOT collapse to age 0 (looks fresh). temporalAgeMinutes
  // returns null for future/invalid; callers treat null as unavailable.
  return temporalAgeMinutes(timestamp, now);
}

function moneylineOddsFreshnessReason(item, now = Date.now()) {
  const timestamp =
    item?.currentOdds?.oddsFetchedAt ||
    item?.currentOdds?.fetchedAt ||
    item?.currentOdds?.updatedAt;
  const maxAgeMinutes = moneylineOddsMaxAgeMinutes();
  const status = checkDataFreshness(timestamp, maxAgeMinutes, { now });
  if (status === 'missing') return 'odds moneyline timestamp tidak tersedia';
  if (status === 'invalid_future') return 'odds moneyline timestamp di masa depan (invalid)';
  if (status === 'stale') {
    const age = moneylineOddsAgeMinutes(item, now);
    return `odds moneyline stale ${Number(age).toFixed(0)}m > ${maxAgeMinutes.toFixed(0)}m`;
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
  const configuredProfile = loadConfig().ruleProfile;
  const activeProfile = resolveRuleProfile({ ruleProfile: configuredProfile });
  const disagreementRetired = listRetiredRulesForProfile(activeProfile).includes('js.disagreement_away');
  const ctx = {
    item,
    option,
    evolutionControls,
    ruleProfile: activeProfile,
    edgeThreshold: moneylineValueEdgeThreshold(),
    evThreshold: moneylineValueEvThreshold(),
    oddsFreshnessReason: moneylineOddsFreshnessReason(item),
    modelFavoredSide: pureModelProbabilityForSide(item, 'home') >= pureModelProbabilityForSide(item, 'away') ? 'home' : 'away',
    pickedTeamWinPct: leagueRecordPct(pickedTeamRecord),
    getEvolutionRule,
    // Disagreement bypass: when model picks away but market favors home, this is
    // the validated asymmetric edge (scripts/model_edge_validation.py). Disabled
    // automatically when js.disagreement_away is retired by the active rule profile.
    disagreementAwayBypass: (() => {
      if (disagreementRetired) return false;
      if (option.side !== 'away') return false;
      const modelHomeProb = pureModelProbabilityForSide(item, 'home');
      const modelAwayProb = 100 - modelHomeProb;
      const sideFair = toNumber(option.fairProbability ?? option.impliedProbability, 50);
      const marketHomeProb = 100 - sideFair;
      const marketAwayProb = sideFair;
      return modelAwayProb > modelHomeProb && marketHomeProb > marketAwayProb;
    })()
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
    .sort((left, right) => {
      const leftEv = left.expectedValuePct ?? -Infinity;
      const rightEv = right.expectedValuePct ?? -Infinity;
      if (rightEv !== leftEv) return rightEv - leftEv;
      return right.edge - left.edge;
    });
  const best = options[0] || null;
  const reasons = valueSafetyReasons(item, best, evolutionControls);
  const auditAdjustments = reasons.filter((reason) => String(reason).toLowerCase().includes('audit guardrail'));
  const memoryNotes = auditMemoryNotes(item, best, evolutionControls);

  item.valuePick = best;
  item.moneylineValueOptions = options;
  for (const option of options) {
    const team = option.side === 'away' ? item.away : item.home;
    if (team) team.valueModelProbability = option.gradingProbability;
  }
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
        gradingProbability: best.gradingProbability ?? best.modelProbability,
        marketResidualWeight: best.marketResidualWeight ?? 0,
        impliedProbability: best.impliedProbability,
        edge: best.edge,
        expectedValuePct: best.expectedValuePct,
        kellyStakePercent: best.kellyStakePercent,
        disagreementBoost: best.disagreementBoost ?? 1,
        isDisagreement: best.isDisagreement ?? false,
        confidenceLevel: best.confidenceLevel ?? null,
        confidenceScore: best.confidenceScore ?? null,
        confidenceSummary: best.confidenceSummary ?? null,
        confidenceMultiplier: best.confidenceMultiplier ?? 1,
        uncertaintyMultiplier: best.uncertaintyMultiplier ?? 1,
        maxSingleBetPercent: best.maxSingleBetPercent ?? configuredMaxSingleBetPercent(),
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

  // Multi-factor pick confidence for display (SP/form/H2H/injury/lineup).
  attachPickConfidence(item);

  return item;
}

/**
 * Enforce a daily slate exposure cap across all qualifying VALUE bets on the
 * same date, taking into account bets already committed in `bet_ledger` for
 * that date (`options.committedLedgerBets`).
 *
 * - Already-committed ledger bets keep their immutable committed stake and
 *   deduct from that date's remaining daily budget.
 * - Uncommitted (new) VALUE bets share `remainingBudget = max(0, cap - committed)`
 *   proportionally via largest-remainder 0.1% tick allocation so total exposure
 *   (committed + new) never exceeds `maxDailyExposurePercent`.
 * - If `remainingBudget < 0.1%`, new uncommitted VALUE bets are downgraded to
 *   NO BET so `storage.recordBet()` cannot breach the daily cap.
 *
 * Strictly idempotent & composable with CLV gate throttling: tracks
 * `inputClvMultiplier` so any CLV throttle update refreshes the baseline stake.
 */
export function applyDailySlateExposureCap(predictions = [], options = {}) {
  if (!Array.isArray(predictions) || predictions.length === 0) return predictions;
  const configuredCap = toNumber(
    options.maxDailyExposurePercent ?? loadConfig().maxDailyExposurePercent,
    10.0
  );
  if (!(configuredCap > 0)) return predictions;
  const capTicks = Math.floor(configuredCap * 10 + 1e-9);
  const maxDailyExposurePercent = capTicks / 10;

  // Index already-committed real moneyline bets by date_ymd -> Map<game_pk, units_staked>.
  const committedByDate = new Map();
  const committedRows = Array.isArray(options.committedLedgerBets) ? options.committedLedgerBets : [];
  for (const row of committedRows) {
    if (!row) continue;
    const market = String(row.market || 'moneyline').toLowerCase();
    if (market !== 'moneyline') continue;
    const status = String(row.status || '').toLowerCase();
    if (status === 'void' || status === 'cancelled' || status === 'canceled') continue;
    const dateKey = String(row.date_ymd || '').trim();
    const gamePk = String(row.game_pk || '').trim();
    const staked = toNumber(row.units_staked, Number.NaN);
    if (!dateKey || !gamePk || !Number.isFinite(staked) || !(staked > 0)) continue;
    if (!committedByDate.has(dateKey)) committedByDate.set(dateKey, new Map());
    const dateMap = committedByDate.get(dateKey);
    if (!dateMap.has(gamePk)) dateMap.set(gamePk, staked);
  }

  // Group qualifying VALUE bets by slate date so multi-day arrays stay isolated.
  const byDate = new Map();
  for (const item of predictions) {
    if (item?.betDecision?.status !== 'VALUE') continue;
    const priorCap = item.betDecision?.slateExposureCap;
    const currentClvMult = isFiniteNumber(item.betDecision?.clvGate?.stakeMultiplier)
      ? Number(item.betDecision.clvGate.stakeMultiplier)
      : 1.0;
    const reusePriorBase =
      priorCap &&
      isFiniteNumber(priorCap.originalStakePercent) &&
      (priorCap.inputClvMultiplier == null ||
        Math.abs(Number(priorCap.inputClvMultiplier) - currentClvMult) < 1e-9);

    const baseStake = reusePriorBase
      ? Number(priorCap.originalStakePercent)
      : isFiniteNumber(item.valuePick?.kellyStakePercent)
        ? Number(item.valuePick.kellyStakePercent)
        : isFiniteNumber(item.betDecision?.kellyStakePercent)
          ? Number(item.betDecision.kellyStakePercent)
          : null;
    if (baseStake == null || !(baseStake > 0)) continue;
    const dateKey = String(item.dateYmd || item.officialDate || '__slate__');
    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push({ item, baseStake, currentClvMult });
  }

  for (const [dateKey, entries] of byDate.entries()) {
    const committedMap = committedByDate.get(dateKey) || new Map();
    const committedTotal = [...committedMap.values()].reduce((sum, s) => sum + s, 0);
    const committedRounded = round1(committedTotal);

    const uncommitted = [];
    for (const entry of entries) {
      const gamePk = String(entry.item?.gamePk || '').trim();
      if (gamePk && committedMap.has(gamePk)) {
        const lockedStake = round1(committedMap.get(gamePk));
        if (entry.item.valuePick) {
          entry.item.valuePick = { ...entry.item.valuePick, kellyStakePercent: lockedStake };
        }
        entry.item.betDecision = {
          ...entry.item.betDecision,
          kellyStakePercent: lockedStake,
          slateExposureCap: {
            applied: false,
            alreadyCommitted: true,
            maxDailyExposurePercent,
            committedStakePercent: committedRounded,
            remainingBudgetPercent: round1(Math.max(0, maxDailyExposurePercent - committedTotal)),
            scaleFactor: 1.0,
            originalStakePercent: lockedStake,
            adjustedStakePercent: lockedStake,
            inputClvMultiplier: entry.currentClvMult,
            slateBetCount: entries.length
          }
        };
      } else {
        uncommitted.push(entry);
      }
    }

    if (uncommitted.length === 0) continue;

    const remainingTicks = Math.max(0, capTicks - Math.round(committedTotal * 10));
    const remainingBudget = remainingTicks / 10;
    const totalNew = uncommitted.reduce((sum, entry) => sum + entry.baseStake, 0);
    const totalNewRounded = round1(totalNew);

    // Budget completely exhausted by earlier committed ledger bets -> block new bets.
    if (remainingTicks < 1) {
      const reason = `daily slate exposure cap ${maxDailyExposurePercent.toFixed(1)}% sudah penuh (committed ${committedRounded.toFixed(1)}%)`;
      for (const { item, baseStake, currentClvMult } of uncommitted) {
        const reasons = Array.isArray(item.betDecision.reasons) ? [...item.betDecision.reasons] : [];
        if (!reasons.includes(reason)) reasons.unshift(reason);
        if (item.valuePick) {
          item.valuePick = { ...item.valuePick, kellyStakePercent: 0 };
        }
        item.betDecision = {
          ...item.betDecision,
          status: 'NO BET',
          reason,
          reasons,
          kellyStakePercent: 0,
          slateExposureCap: {
            applied: true,
            exhausted: true,
            maxDailyExposurePercent,
            committedStakePercent: committedRounded,
            remainingBudgetPercent: 0,
            totalUncappedStakePercent: totalNewRounded,
            totalAdjustedStakePercent: 0,
            scaleFactor: 0,
            originalStakePercent: baseStake,
            adjustedStakePercent: 0,
            inputClvMultiplier: currentClvMult,
            slateBetCount: uncommitted.length
          }
        };
      }
      continue;
    }

    if (totalNew <= remainingBudget + 1e-9) {
      // Fits inside remaining daily budget: restore any previously capped stakes cleanly.
      for (const { item, baseStake, currentClvMult } of uncommitted) {
        if (item.betDecision?.slateExposureCap?.applied) {
          if (item.valuePick) {
            item.valuePick = { ...item.valuePick, kellyStakePercent: baseStake };
          }
          item.betDecision = {
            ...item.betDecision,
            kellyStakePercent: baseStake,
            slateExposureCap: {
              applied: false,
              maxDailyExposurePercent,
              committedStakePercent: committedRounded,
              remainingBudgetPercent: remainingBudget,
              totalUncappedStakePercent: totalNewRounded,
              totalAdjustedStakePercent: totalNewRounded,
              scaleFactor: 1.0,
              originalStakePercent: baseStake,
              adjustedStakePercent: baseStake,
              inputClvMultiplier: currentClvMult,
              slateBetCount: uncommitted.length
            }
          };
        }
      }
      continue;
    }

    const scale = remainingBudget / totalNew;
    const allocated = uncommitted.map((entry, idx) => {
      const exactTicks = entry.baseStake * scale * 10;
      const floorTicks = Math.floor(exactTicks + 1e-9);
      return {
        ...entry,
        idx,
        ticks: floorTicks,
        remainder: exactTicks - floorTicks
      };
    });

    // Enforce >= 0.1% per bet when remaining budget allows at least 0.1% per bet.
    if (remainingTicks >= allocated.length) {
      for (const a of allocated) {
        if (a.ticks < 1) a.ticks = 1;
      }
    }

    let usedTicks = allocated.reduce((sum, a) => sum + a.ticks, 0);
    // If enforcing 0.1% floor pushed usedTicks above remainingTicks, trim from largest stakes.
    while (usedTicks > remainingTicks) {
      const donor = allocated
        .filter((a) => a.ticks > 1)
        .sort((x, y) => y.ticks - x.ticks || x.remainder - y.remainder)[0];
      if (!donor) break;
      donor.ticks -= 1;
      usedTicks -= 1;
    }

    // Distribute remaining ticks via largest remainder so total === remainingBudget exactly.
    let leftoverTicks = remainingTicks - usedTicks;
    if (leftoverTicks > 0) {
      const byRemainder = [...allocated].sort(
        (x, y) => y.remainder - x.remainder || y.baseStake - x.baseStake || x.idx - y.idx
      );
      for (let i = 0; i < leftoverTicks && i < byRemainder.length; i += 1) {
        byRemainder[i].ticks += 1;
      }
    }

    const totalAdjusted = allocated.reduce((sum, a) => sum + a.ticks, 0) / 10;
    const scaleRounded = Math.round(scale * 1000) / 1000;

    for (const a of allocated) {
      const adjustedStake = a.ticks / 10;
      if (a.item.valuePick) {
        a.item.valuePick = { ...a.item.valuePick, kellyStakePercent: adjustedStake };
      }
      if (a.ticks < 1) {
        const reason = `daily slate exposure cap ${maxDailyExposurePercent.toFixed(1)}% tersisa ${remainingBudget.toFixed(1)}% (tidak cukup untuk stake minimum 0.1%)`;
        const reasons = Array.isArray(a.item.betDecision.reasons)
          ? [...a.item.betDecision.reasons]
          : [];
        if (!reasons.includes(reason)) reasons.unshift(reason);
        a.item.betDecision = {
          ...a.item.betDecision,
          status: 'NO BET',
          reason,
          reasons,
          kellyStakePercent: 0,
          slateExposureCap: {
            applied: true,
            exhausted: true,
            maxDailyExposurePercent,
            committedStakePercent: committedRounded,
            remainingBudgetPercent: remainingBudget,
            totalUncappedStakePercent: totalNewRounded,
            totalAdjustedStakePercent: totalAdjusted,
            scaleFactor: scaleRounded,
            originalStakePercent: a.baseStake,
            adjustedStakePercent: 0,
            inputClvMultiplier: a.currentClvMult,
            slateBetCount: uncommitted.length
          }
        };
        continue;
      }
      a.item.betDecision = {
        ...a.item.betDecision,
        kellyStakePercent: adjustedStake,
        slateExposureCap: {
          applied: true,
          exhausted: false,
          maxDailyExposurePercent,
          committedStakePercent: committedRounded,
          remainingBudgetPercent: remainingBudget,
          totalUncappedStakePercent: totalNewRounded,
          totalAdjustedStakePercent: totalAdjusted,
          scaleFactor: scaleRounded,
          originalStakePercent: a.baseStake,
          adjustedStakePercent: adjustedStake,
          inputClvMultiplier: a.currentClvMult,
          slateBetCount: uncommitted.length
        }
      };
    }
  }

  return predictions;
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
    const factorLevel = decision.confidenceLevel || item?.pickConfidence?.level || item?.valueConfidence?.level;
    const factorSummary = decision.confidenceSummary || item?.valueConfidence?.summary || item?.pickConfidence?.summary;
    const factorLine = factorLevel
      ? ` | factors ${factorLevel}${factorSummary ? ` — ${factorSummary}` : ''}`
      : '';
    return [
      uiKV('💰', 'Pick', `${decision.teamName} ${formatMoneylineOdds(decision.odds)} | ${decision.book}`),
      uiKV('🎚️', 'Confidence', `${confidenceText(toNumber(decision.modelProbability, 0))} | edge ${decision.edge >= 0 ? '+' : ''}${toNumber(decision.edge, 0).toFixed(1)}%${factorLine}`)
    ];
  }

  // News veto: show why VALUE was blocked (never a probability change).
  if (decision.status === 'NO BET' && decision.newsVeto) {
    const newsReasons = (decision.reasons || []).filter((r) => String(r).startsWith('news:'));
    if (newsReasons.length) {
      return [
        uiKV('🛑', 'NO BET', newsReasons[0]),
        ...(newsReasons.slice(1, 3).map((r) => uiBullet('•', r)))
      ];
    }
  }

  // Below the floor or no odds: show the MODEL's favored side as an advisory
  // lean with multi-factor confidence — never dressed up as a recommended bet.
  const model = modelPickSide(item);
  const factorLevel = decision.confidenceLevel || item?.pickConfidence?.level;
  const factorSummary = decision.confidenceSummary || item?.pickConfidence?.summary;
  const factorLine = factorLevel
    ? ` | factors ${factorLevel}${factorSummary ? ` — ${factorSummary}` : ''}`
    : '';
  const oddsContext = item.valuePick && Number.isFinite(Number(item.valuePick.odds))
    ? ` | best price ${formatMoneylineOdds(item.valuePick.odds)} ${item.valuePick.book}`
    : '';
  const lines = [
    uiKV('🎚️', 'Confidence', `${model.team?.name || 'lean'} ${confidenceText(model.percent)} (advisory)${factorLine}${oddsContext}`)
  ];
  // Surface news risk even when not hard-vetoing (informational).
  const riskFlags = item?.newsContext?.newsRisk?.flags || [];
  if (riskFlags.length) {
    lines.push(uiKV('📰', 'News risk', riskFlags.map((f) => f.flag).slice(0, 4).join(', ')));
  }
  return lines;
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

const NON_PITCHER_OPENER_RE = /\b(home|season|series|road|spring|exhibition|day)\s+opener\b/i;

function detectOpenerSituation(game, side, pitcher, stats) {
  const teamEntry = game?.teams?.[side] || {};
  const noteText = [
    ...collectOpenerNoteText(teamEntry),
    ...collectOpenerNoteText(pitcher)
  ]
    .filter((line) => !NON_PITCHER_OPENER_RE.test(line))
    .join(' ');
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

function teamStatBlockKind(block) {
  const group = String(block?.group?.displayName || '').trim().toLowerCase();
  if (group !== 'hitting' && group !== 'pitching') return null;

  const type = String(block?.type?.displayName || '').replace(/[^a-z]/gi, '').toLowerCase();
  if (!type) return null;

  const isSupportedPeriod = type.includes('season') || type.includes('daterange');
  if (!isSupportedPeriod) return null;

  return {
    group,
    advanced: type.includes('advanced'),
    type
  };
}

function getTeamStatMap(statsData) {
  const teams = new Map();

  for (const block of statsData?.stats || []) {
    const kind = teamStatBlockKind(block);
    if (!kind || !Array.isArray(block?.splits)) continue;

    for (const split of block.splits) {
      const teamId = split?.team?.id;
      if (!teamId || !split?.stat || typeof split.stat !== 'object') continue;

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
      profile.team = split.team || profile.team;
      if (kind.group === 'hitting') {
        profile[kind.advanced ? 'hittingAdvanced' : 'hitting'] = split.stat;
      } else {
        profile[kind.advanced ? 'pitchingAdvanced' : 'pitching'] = split.stat;
      }
    }
  }

  return teams;
}

function mergeTeamStatMaps(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [teamId, profile] of map || []) {
      const existing = merged.get(teamId) || {
        team: profile?.team || null,
        hitting: null,
        hittingAdvanced: null,
        pitching: null,
        pitchingAdvanced: null
      };
      merged.set(teamId, {
        team: profile?.team || existing.team,
        hitting: profile?.hitting || existing.hitting,
        hittingAdvanced: profile?.hittingAdvanced || existing.hittingAdvanced,
        pitching: profile?.pitching || existing.pitching,
        pitchingAdvanced: profile?.pitchingAdvanced || existing.pitchingAdvanced
      });
    }
  }
  return merged;
}

function getRollingTeamStatMap(statsData) {
  const teams = new Map();

  for (const block of statsData.stats || []) {
    const group = block.group?.displayName?.toLowerCase();
    const type = String(block.type?.displayName || '').toLowerCase();
    if (!group || !type.includes('daterange')) continue;

    for (const split of block.splits || []) {
      const teamId = split.team?.id;
      if (!teamId) continue;

      if (!teams.has(teamId)) {
        teams.set(teamId, {
          team: split.team,
          hitting: null,
          pitching: null,
          games: 0
        });
      }

      const profile = teams.get(teamId);
      if (group === 'hitting') {
        profile.hitting = split.stat;
        profile.games = Math.max(profile.games, toNumber(split.stat?.gamesPlayed, 0));
      }
      if (group === 'pitching') {
        profile.pitching = split.stat;
        profile.games = Math.max(profile.games, toNumber(split.stat?.gamesPlayed, 0));
      }
    }
  }

  return teams;
}

// Season vs last-21d offense/prevention blend. Rolling form is the real-data
// signal season averages miss (hot/cold stretches, post-trade lineups). Require
// enough games so a 3-game noise spike cannot dominate.
function blendedTeamOffenseEdge(seasonHome, seasonAway, rollingHome, rollingAway) {
  const seasonEdge =
    (rpg(seasonHome?.hitting) - rpg(seasonAway?.hitting)) / 2.2 +
    (statOps(seasonHome?.hitting) - statOps(seasonAway?.hitting)) / 0.14 +
    (statIso(seasonHome?.hittingAdvanced) - statIso(seasonAway?.hittingAdvanced)) / 0.1 +
    (battingKRate(seasonAway?.hittingAdvanced) - battingKRate(seasonHome?.hittingAdvanced)) / 0.16 +
    (battingBbRate(seasonHome?.hittingAdvanced) - battingBbRate(seasonAway?.hittingAdvanced)) / 0.12;

  const homeGames = toNumber(rollingHome?.games, 0);
  const awayGames = toNumber(rollingAway?.games, 0);
  if (homeGames < 8 || awayGames < 8 || !rollingHome?.hitting || !rollingAway?.hitting) {
    return { edge: seasonEdge, rollingWeight: 0, rollingEdge: 0 };
  }

  const rollingEdge =
    (rpg(rollingHome.hitting) - rpg(rollingAway.hitting)) / 2.2 +
    (statOps(rollingHome.hitting) - statOps(rollingAway.hitting)) / 0.14;
  const sample = Math.min(homeGames, awayGames);
  const rollingWeight = clamp((sample - 7) / 12, 0, 0.45);
  return {
    edge: seasonEdge * (1 - rollingWeight) + rollingEdge * rollingWeight,
    rollingWeight,
    rollingEdge
  };
}

function blendedTeamPreventionEdge(seasonHome, seasonAway, rollingHome, rollingAway) {
  const seasonEdge =
    (statEra(seasonAway?.pitching) - statEra(seasonHome?.pitching)) / 1.8 +
    (statWhip(seasonAway?.pitching) - statWhip(seasonHome?.pitching)) / 0.55 +
    (pitchingKMinusBb(seasonHome?.pitchingAdvanced) - pitchingKMinusBb(seasonAway?.pitchingAdvanced)) / 0.16 +
    (pitchingHr9(seasonAway?.pitchingAdvanced) - pitchingHr9(seasonHome?.pitchingAdvanced)) / 1.2;

  const homeGames = toNumber(rollingHome?.games, 0);
  const awayGames = toNumber(rollingAway?.games, 0);
  if (homeGames < 8 || awayGames < 8 || !rollingHome?.pitching || !rollingAway?.pitching) {
    return { edge: seasonEdge, rollingWeight: 0, rollingEdge: 0 };
  }

  const homePitch = rollingHome.pitching;
  const awayPitch = rollingAway.pitching;
  const rollingEdge =
    (statEra(awayPitch) - statEra(homePitch)) / 1.8 +
    (statWhip(awayPitch) - statWhip(homePitch)) / 0.55 +
    (toNumber(awayPitch.homeRunsPer9, DEFAULTS.hr9) - toNumber(homePitch.homeRunsPer9, DEFAULTS.hr9)) / 1.2 +
    (toNumber(homePitch.strikeoutWalkRatio, 2.2) - toNumber(awayPitch.strikeoutWalkRatio, 2.2)) / 4.0;
  const sample = Math.min(homeGames, awayGames);
  const rollingWeight = clamp((sample - 7) / 12, 0, 0.4);
  return {
    edge: seasonEdge * (1 - rollingWeight) + rollingEdge * rollingWeight,
    rollingWeight,
    rollingEdge
  };
}

function rollingFormLine(team, rollingProfile) {
  const label = team.abbreviation || team.name;
  if (!rollingProfile?.hitting && !rollingProfile?.pitching) {
    return `${label} L21: data belum cukup`;
  }
  const games = toNumber(rollingProfile.games, 0);
  const hit = rollingProfile.hitting;
  const pit = rollingProfile.pitching;
  const parts = [`${label} L${games || 21}`];
  if (hit) parts.push(`${safeFixed(rpg(hit), 2)} R/G OPS ${safeFixed(statOps(hit), 3)}`);
  if (pit) parts.push(`staff ERA ${safeFixed(statEra(pit))} WHIP ${safeFixed(statWhip(pit))}`);
  return parts.join(' ');
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

async function fetchScheduleFatigueProfiles(teamIds, dateYmd, todaysGames = []) {
  const todayByTeam = new Map();
  for (const game of todaysGames || []) {
    const homeTeamId = game?.teams?.home?.team?.id ?? null;
    const awayTeamId = game?.teams?.away?.team?.id ?? null;
    const info = {
      homeTeamId,
      venueId: game?.venue?.id ?? null,
      gameDate: game?.gameDate || null
    };
    if (homeTeamId != null && !todayByTeam.has(homeTeamId)) todayByTeam.set(homeTeamId, info);
    if (awayTeamId != null && !todayByTeam.has(awayTeamId)) todayByTeam.set(awayTeamId, info);
  }

  const profiles = new Map(
    teamIds.map((teamId) => [
      teamId,
      finalizeScheduleFatigueProfile(teamId, [], dateYmd, todayByTeam.get(teamId) || null)
    ])
  );
  const games = await fetchRecentTeamGames(teamIds, dateYmd, 10);

  for (const teamId of teamIds) {
    const teamGames = games
      .filter((game) => game.teams.away.team.id === teamId || game.teams.home.team.id === teamId)
      .map((game) => ({
        date: game.officialDate || String(game.gameDate || '').slice(0, 10),
        side: game.teams.away.team.id === teamId ? 'away' : 'home',
        homeTeamId: game.teams?.home?.team?.id ?? null,
        venueId: game.venue?.id ?? null,
        gameDate: game.gameDate || null
      }))
      .filter((game) => game.date);
    profiles.set(
      teamId,
      finalizeScheduleFatigueProfile(teamId, teamGames, dateYmd, todayByTeam.get(teamId) || null)
    );
  }

  return profiles;
}

function finalizeScheduleFatigueProfile(teamId, games, dateYmd, todayGameInfo = null) {
  const sorted = [...games].sort((left, right) => {
    const byDate = String(right.date).localeCompare(String(left.date));
    if (byDate !== 0) return byDate;
    return String(right.gameDate || '').localeCompare(String(left.gameDate || ''));
  });
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

  const travel = computeTravelFatigueContext(sorted, todayGameInfo, dateYmd);

  let fatiguePoints = 0;
  if (sorted.length >= 9) fatiguePoints += 2;
  else if (sorted.length >= 7) fatiguePoints += 1;
  if (doubleheaderLast3Days) fatiguePoints += 1;
  if (roadStreak >= 7) fatiguePoints += 2;
  else if (roadStreak >= 4) fatiguePoints += 1;
  if (restDays === 0) fatiguePoints += 1;
  const fatigueLevel = fatiguePoints >= 3 ? 'high' : fatiguePoints >= 1 ? 'medium' : 'low';

  const travelSuffix =
    travel.travelMiles != null && travel.travelMiles > 0
      ? `, travel ${Math.round(travel.travelMiles)}mi (TZ ${travel.timezoneShiftHours >= 0 ? '+' : ''}${travel.timezoneShiftHours}h${travel.dayAfterNight ? ', day-after-night' : ''})`
      : '';

  return {
    teamId,
    restDays,
    roadStreak,
    recentGameCount: sorted.length,
    doubleheaderLast3Days,
    fatigueLevel,
    travelMiles: travel.travelMiles,
    legTravelMiles: travel.legTravelMiles,
    timezoneShiftHours: travel.timezoneShiftHours,
    travelDirection: travel.travelDirection,
    dayAfterNight: travel.dayAfterNight,
    travelFatigueScore: travel.travelFatigueScore,
    offenseAdjustment: doubleheaderLast3Days ? -0.05 : 0,
    teamAdjustment: roadStreak >= 7 ? -0.03 : 0,
    line: `${sorted.length}G last 10d, rest ${restDays}d, road streak ${roadStreak}, fatigue ${fatigueLevel}${doubleheaderLast3Days ? ', doubleheader flag' : ''}${travelSuffix}`
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
  const multiplier =
    restDays === null
      ? 1
      : restDays <= 3
        ? 0.85
        : restDays === 4
          ? 1
          : restDays <= 7
            ? 1.02
            : restDays <= 9
              ? 1
              : 0.93;
  const label =
    restDays === null
      ? 'SP rest unavailable'
      : restDays <= 3
        ? `${pitcher.fullName} short rest ${restDays}d`
        : restDays === 4
          ? `${pitcher.fullName} normal rest ${restDays}d`
          : restDays <= 7
            ? `${pitcher.fullName} extra rest ${restDays}d`
            : restDays <= 9
              ? `${pitcher.fullName} extended rest ${restDays}d`
              : `${pitcher.fullName} long layoff ${restDays}d`;

  return {
    pitcher: pitcher.fullName,
    restDays,
    multiplier,
    flag: label
  };
}

function scheduleFatigueEdge(homeFatigue, awayFatigue, homeRest, awayRest) {
  const restPenalty = (rest) => (1 - toNumber(rest?.multiplier, 1)) * 0.25;
  const homePenalty =
    Math.abs(toNumber(homeFatigue.offenseAdjustment, 0)) +
    Math.abs(toNumber(homeFatigue.teamAdjustment, 0)) +
    restPenalty(homeRest);
  const awayPenalty =
    Math.abs(toNumber(awayFatigue.offenseAdjustment, 0)) +
    Math.abs(toNumber(awayFatigue.teamAdjustment, 0)) +
    restPenalty(awayRest);
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

function blendHitterSeasonStats(currentStats, priorStats) {
  const cur = currentStats || {};
  const prior = priorStats || null;
  const curPa = Math.max(
    firstStatNumber(cur, ['plateAppearances', 'pa'], 0),
    firstStatNumber(cur, ['atBats', 'ab'], 0)
  );
  const priorPa = prior
    ? Math.max(
        firstStatNumber(prior, ['plateAppearances', 'pa'], 0),
        firstStatNumber(prior, ['atBats', 'ab'], 0)
      )
    : 0;

  const hasCurDirect =
    curPa > 0 || cur.ops !== undefined || cur.onBasePercentage !== undefined || cur.obp !== undefined;
  if (!hasCurDirect && priorPa <= 0 && !prior?.ops) {
    return null;
  }

  // Prior-season talent baseline (shrunk slightly toward league average so a 40-PA
  // September cup-of-coffee doesn't masquerade as a 600-PA superstar).
  const priorTrust = priorPa > 0 ? clamp(priorPa / (priorPa + 140), 0, 0.85) : prior?.ops !== undefined ? 0.65 : 0;
  const priorOps = priorTrust * firstStatNumber(prior, ['ops'], DEFAULTS.ops) + (1 - priorTrust) * DEFAULTS.ops;
  const priorObp = priorTrust * firstStatNumber(prior, ['obp', 'onBasePercentage'], 0.32) + (1 - priorTrust) * 0.32;
  const priorSlg = priorTrust * firstStatNumber(prior, ['slg', 'sluggingPercentage'], 0.4) + (1 - priorTrust) * 0.4;
  const priorHrRate =
    priorPa > 0
      ? priorTrust * (firstStatNumber(prior, ['homeRuns', 'hr'], 0) / priorPa) + (1 - priorTrust) * 0.033
      : 0.033;

  // Current-season weight: when a batter has full-season stats (or synthetic test
  // fixture with ops set and PA >= 25), trust current stats; when PA < 110 (early
  // April, rookie call-up, or freshly traded batter), blend smoothly with prior.
  if (priorTrust === 0 && (curPa >= 25 || cur.ops !== undefined || cur.onBasePercentage !== undefined)) {
    const sample = Math.max(curPa, 25);
    const shrink = curPa > 0 ? clamp(curPa / (curPa + 45), 0.45, 1) : 0.85;
    const rawOps = firstStatNumber(cur, ['ops'], DEFAULTS.ops);
    const rawObp = firstStatNumber(cur, ['obp', 'onBasePercentage'], 0.32);
    const rawSlg = firstStatNumber(cur, ['slg', 'sluggingPercentage'], 0.4);
    const rawHrRate = firstStatNumber(cur, ['homeRuns', 'hr'], 0) / sample;
    return {
      ops: shrink * rawOps + (1 - shrink) * DEFAULTS.ops,
      obp: shrink * rawObp + (1 - shrink) * 0.32,
      slg: shrink * rawSlg + (1 - shrink) * 0.4,
      powerPerPa: shrink * rawHrRate + (1 - shrink) * 0.033,
      effectivePa: sample
    };
  }

  if (curPa < 5 && priorTrust > 0) {
    return {
      ops: priorOps,
      obp: priorObp,
      slg: priorSlg,
      powerPerPa: priorHrRate,
      effectivePa: Math.max(30, Math.round(priorPa * priorTrust))
    };
  }

  if (curPa < 25 && priorTrust === 0) {
    return null;
  }

  const PRIOR_PA = 110;
  const wCur = clamp(curPa / (curPa + PRIOR_PA), 0, 1);
  const curOps = firstStatNumber(cur, ['ops'], priorOps);
  const curObp = firstStatNumber(cur, ['obp', 'onBasePercentage'], priorObp);
  const curSlg = firstStatNumber(cur, ['slg', 'sluggingPercentage'], priorSlg);
  const curHrRate = curPa > 0 ? firstStatNumber(cur, ['homeRuns', 'hr'], 0) / curPa : priorHrRate;

  return {
    ops: wCur * curOps + (1 - wCur) * priorOps,
    obp: wCur * curObp + (1 - wCur) * priorObp,
    slg: wCur * curSlg + (1 - wCur) * priorSlg,
    powerPerPa: wCur * curHrRate + (1 - wCur) * priorHrRate,
    effectivePa: curPa + Math.round(priorPa * priorTrust * (1 - wCur))
  };
}

function hitterLineupScore(player, slot, fallbackLookup = null) {
  const boxStats = hitterBattingStats(player);
  const curStats = fallbackLookup?.current || boxStats;
  const priorStats = fallbackLookup?.prior || player?.priorSeasonStats || null;
  const blended = blendHitterSeasonStats(curStats, priorStats);
  if (!blended) return { value: 0, known: false, ops: null, obp: null, slg: null };

  const { ops, obp, slg, powerPerPa } = blended;
  const slotWeight = slot <= 2 ? 1.2 : slot <= 4 ? 1.12 : slot === 5 ? 1.04 : slot <= 7 ? 0.92 : 0.78;
  const score =
    ((ops - DEFAULTS.ops) / 0.22) * 0.078 +
    ((obp - 0.32) / 0.08) * 0.036 +
    ((slg - 0.4) / 0.14) * 0.036 +
    ((powerPerPa - 0.034) / 0.035) * 0.02;

  return {
    value: clamp(score * slotWeight, -0.16, 0.18),
    known: true,
    ops,
    obp,
    slg
  };
}

function estimateWobaFromSlash(obp, slg, fallbackOps = DEFAULTS.ops) {
  if (isFiniteNumber(obp) && isFiniteNumber(slg)) {
    // Linear wOBA proxy: 0.62 * OBP + 0.30 * SLG (league avg .320/.400 -> .318).
    return 0.62 * Number(obp) + 0.3 * Number(slg);
  }
  // Fallback from OPS alone when OBP/SLG aren't both populated.
  return 0.442 * toNumber(fallbackOps, DEFAULTS.ops);
}

function batterHandPlatoonDeltaOps(player, oppPitchHand) {
  const opp = String(oppPitchHand || '').toUpperCase();
  if (opp !== 'L' && opp !== 'R') return 0;
  const batSide = String(player?.person?.batSide?.code || player?.batSide?.code || '').toUpperCase();
  if (!batSide || batSide === 'S') return 0; // switch-hitter neutral prior
  return batSide !== opp ? 0.022 : -0.022;
}

function extractLineupProfile(boxTeam, options = {}) {
  const {
    hitterLookups = null,
    platoonSplits = null,
    rosterContext = null,
    oppPitchHand = null
  } = options;
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

  const getLookup = (player) => {
    const id = player?.person?.id;
    if (!id || !hitterLookups) return null;
    return hitterLookups instanceof Map ? hitterLookups.get(id) : hitterLookups[id] || null;
  };
  const getPlatoon = (player) => {
    const id = player?.person?.id;
    if (!id || !platoonSplits) return null;
    return platoonSplits instanceof Map ? platoonSplits.get(id) : platoonSplits[id] || null;
  };

  const hitterScores = orderedHitters.map((hitter, index) =>
    hitterLineupScore(hitter, index + 1, getLookup(hitter))
  );
  const leadoffScore = hitterScores[0];
  const leadoffRawStats = hitterBattingStats(orderedHitters[0]);
  const leadoffObpValue =
    leadoffScore?.known && Number.isFinite(leadoffScore.obp)
      ? leadoffScore.obp
      : orderedHitters[0]
        ? firstStatNumber(leadoffRawStats, ['obp', 'onBasePercentage'], Number.NaN)
        : Number.NaN;

  const knownStatCount = hitterScores.filter((score) => score.known).length;
  const weightedScore =
    knownStatCount >= 4
      ? hitterScores.reduce((sum, score) => sum + score.value, 0) / Math.max(1, orderedHitters.length)
      : 0;

  // Top-of-order (slots 1-4) blended OPS.
  const topFourKnown = hitterScores.slice(0, 4).filter((s) => s.known && Number.isFinite(s.ops));
  const topOrderOps =
    topFourKnown.length >= 3
      ? Math.round((topFourKnown.reduce((sum, s) => sum + s.ops, 0) / topFourKnown.length) * 1000) / 1000
      : null;

  // Slot-weighted per-hitter handedness platoon OPS, wOBA, and pure DELTA
  // (split minus each hitter's own overall baseline — eliminates triple-counting
  // overall hitter talent into platoonEdge). Require genuine platoon evidence
  // (observed splits or known batter handedness vs oppPitchHand); never fabricate
  // platoon splits from overall OPS alone!
  let platoonWeightedSum = 0;
  let platoonWobaWeightedSum = 0;
  let platoonOpsDeltaSum = 0;
  let platoonWobaDeltaSum = 0;
  let platoonWeightTotal = 0;
  let observedSplitCount = 0;
  let knownHandCount = 0;
  let totalSlotWeight = 0;
  orderedHitters.forEach((hitter, index) => {
    const slotW = index < 4 ? 1.15 : index < 7 ? 0.95 : 0.8;
    totalSlotWeight += slotW;
    const split = getPlatoon(hitter);
    const scoreObj = hitterScores[index];
    const baseOps = scoreObj?.ops ?? DEFAULTS.ops;
    const baseWoba = estimateWobaFromSlash(scoreObj?.obp, scoreObj?.slg, baseOps);
    const batSideCode = String(hitter?.person?.batSide?.code || hitter?.batSide?.code || '').toUpperCase();
    const hasKnownHand = Boolean(
      oppPitchHand &&
        (String(oppPitchHand).toUpperCase() === 'L' || String(oppPitchHand).toUpperCase() === 'R') &&
        (batSideCode === 'L' || batSideCode === 'R' || batSideCode === 'S')
    );
    const handDeltaOps = batterHandPlatoonDeltaOps(hitter, oppPitchHand);
    const priorOps = baseOps + handDeltaOps;
    const priorWoba = baseWoba + handDeltaOps * 0.44;

    if (split && isFiniteNumber(split.ops)) {
      const ab = Math.max(0, toNumber(split.atBats, 0));
      const wSplit = clamp(ab / (ab + 55), 0, 0.85);
      const shrunkSplitOps = wSplit * Number(split.ops) + (1 - wSplit) * priorOps;
      const splitWoba = estimateWobaFromSlash(split.obp, split.slg, split.ops);
      const shrunkSplitWoba = wSplit * splitWoba + (1 - wSplit) * priorWoba;
      platoonWeightedSum += shrunkSplitOps * slotW;
      platoonWobaWeightedSum += shrunkSplitWoba * slotW;
      platoonOpsDeltaSum += (shrunkSplitOps - baseOps) * slotW;
      platoonWobaDeltaSum += (shrunkSplitWoba - baseWoba) * slotW;
      platoonWeightTotal += slotW;
      observedSplitCount += 1;
    } else if (hasKnownHand) {
      // Bayesian handedness prior ONLY when batter's actual batSide (L/R/S) is known.
      platoonWeightedSum += priorOps * slotW;
      platoonWobaWeightedSum += priorWoba * slotW;
      platoonOpsDeltaSum += handDeltaOps * slotW;
      platoonWobaDeltaSum += handDeltaOps * 0.44 * slotW;
      platoonWeightTotal += slotW;
      knownHandCount += 1;
    }
  });
  const hasRealPlatoonEvidence = observedSplitCount + knownHandCount >= 4 && platoonWeightTotal >= 4;
  const platoonOps = hasRealPlatoonEvidence
    ? Math.round((platoonWeightedSum / platoonWeightTotal) * 1000) / 1000
    : null;
  const platoonWoba = hasRealPlatoonEvidence
    ? Math.round((platoonWobaWeightedSum / platoonWeightTotal) * 1000) / 1000
    : null;
  const platoonOpsDelta = hasRealPlatoonEvidence
    ? Math.round((platoonOpsDeltaSum / platoonWeightTotal) * 1000) / 1000
    : null;
  const platoonWobaDelta = hasRealPlatoonEvidence
    ? Math.round((platoonWobaDeltaSum / platoonWeightTotal) * 1000) / 1000
    : null;
  const platoonCoverage =
    hasRealPlatoonEvidence && totalSlotWeight > 0
      ? Math.round(
          clamp(
            (observedSplitCount / Math.max(1, orderedHitters.length)) * 0.6 +
              (platoonWeightTotal / totalSlotWeight) * 0.4,
            0,
            1
          ) * 1000
        ) / 1000
      : 0;

  // Track newly traded/signed players who are actually starting in today's 1-9 lineup!
  const acqIds = new Set(
    (rosterContext?.recentAcquisitions || []).map((a) => String(a.id)).filter(Boolean)
  );
  const newStarters = orderedHitters
    .filter((h) => h?.person?.id && acqIds.has(String(h.person.id)))
    .map(lineupPlayerName)
    .filter(Boolean);

  return {
    confirmed: orderedHitters.length >= 9,
    count: orderedHitters.length,
    topFive,
    leadoffObp: Number.isFinite(leadoffObpValue) ? Math.round(leadoffObpValue * 1000) / 1000 : null,
    topOrderOps,
    platoonOps,
    platoonWoba,
    platoonOpsDelta,
    platoonWobaDelta,
    platoonCoverage,
    acquisitionsInLineup: newStarters.length,
    newAdditionsNames: newStarters.slice(0, 3),
    rosterTurnover: rosterContext ? toNumber(rosterContext.turnoverScore, 0) : 0,
    knownStatCount,
    qualityScore: clamp(weightedScore, -0.14, 0.14)
  };
}

function lineupTemporalEligibility(game, predictionTimestampUtc) {
  return assertPregameEligible({
    asOf: predictionTimestampUtc,
    firstPitch: game?.gameDate || null
  });
}

async function fetchHitterSeasonStats(personId, season, asOfDateYmd = null) {
  if (!personId) return null;
  const params = new URLSearchParams({
    group: 'hitting',
    season: String(season),
    gameType: 'R'
  });
  if (asOfDateYmd) {
    const range = aggregateDateRange(season, asOfDateYmd);
    if (!range) return null;
    params.set('stats', 'byDateRange');
    params.set('startDate', range.startDate);
    params.set('endDate', range.endDate);
  } else {
    params.set('stats', 'season');
  }
  const data = await fetchJson(`${MLB_BASE_URL}/people/${personId}/stats?${params}`);
  const splits = data.stats?.[0]?.splits || [];
  if (splits.length === 0) return null;
  if (splits.length === 1) return splits[0]?.stat || null;
  // Mid-season traded player may return multiple team splits or a combined total
  // split (no `team` field). Prefer the combined split, else aggregate PA-weighted.
  const combined = splits.find((s) => !s.team);
  if (combined?.stat) return combined.stat;
  let totalPa = 0;
  let totalAb = 0;
  let totalHr = 0;
  let totalWeight = 0;
  let weightedObp = 0;
  let weightedSlg = 0;
  for (const s of splits) {
    const st = s?.stat || {};
    const pa = toNumber(st.plateAppearances ?? st.atBats, 0);
    totalPa += toNumber(st.plateAppearances, 0);
    totalAb += toNumber(st.atBats, 0);
    totalHr += toNumber(st.homeRuns, 0);
    if (pa > 0) {
      totalWeight += pa;
      weightedObp += toNumber(st.obp ?? st.onBasePercentage, 0.32) * pa;
      weightedSlg += toNumber(st.slg ?? st.sluggingPercentage, 0.4) * pa;
    }
  }
  const obp = totalWeight > 0 ? weightedObp / totalWeight : 0.32;
  const slg = totalWeight > 0 ? weightedSlg / totalWeight : 0.4;
  return {
    plateAppearances: totalPa,
    atBats: totalAb,
    homeRuns: totalHr,
    obp,
    slg,
    ops: obp + slg
  };
}

async function fetchHitterPlatoonSplit(personId, splitCode, season) {
  if (!personId || !splitCode) return null;
  const params = new URLSearchParams({
    stats: 'statSplits',
    sitCodes: 'vl,vr',
    group: 'hitting',
    season: String(season),
    gameType: 'R'
  });
  const data = await fetchJson(`${MLB_BASE_URL}/people/${personId}/stats?${params}`);
  const splits = data?.stats?.[0]?.splits || [];
  const matching = splits.filter((s) => s?.split?.code === splitCode && s?.stat);
  if (matching.length === 0) return null;
  const combined = matching.find((s) => !s.team) || matching[0];
  return {
    ops: toNumber(combined.stat?.ops, Number.NaN),
    atBats: toNumber(combined.stat?.atBats, 0),
    obp: toNumber(combined.stat?.obp, Number.NaN),
    slg: toNumber(combined.stat?.slg, Number.NaN)
  };
}

function orderedLineupBatterEntries(boxTeam) {
  const players = Object.values(boxTeam?.players || {});
  const hitters = players
    .filter((p) => p?.battingOrder)
    .sort((a, b) => Number.parseInt(a.battingOrder, 10) - Number.parseInt(b.battingOrder, 10));
  const seen = new Set();
  const out = [];
  for (const h of hitters) {
    const slot = battingOrderSlot(h);
    if (slot >= 1 && slot <= 9 && !seen.has(slot)) {
      seen.add(slot);
      out.push(h);
    }
  }
  return out;
}

async function enrichLineupHittersForSide(boxTeam, oppPitchHand, context = {}) {
  const { season, dateYmd, hitterCache, platoonCache } = context;
  const hitters = orderedLineupBatterEntries(boxTeam);
  const hitterLookups = new Map();
  const platoonSplits = new Map();
  if (!season || hitters.length === 0) {
    return { hitterLookups, platoonSplits };
  }

  const splitCode = oppPitchHand === 'L' ? 'vl' : oppPitchHand === 'R' ? 'vr' : null;
  // Only fetch pre-day career/prior splits when dateYmd is not a strict historical
  // replay of full-season `statSplits` (note: season-1 is strictly prior to `season`
  // and 100% leakage-free on every date!).
  await Promise.all(
    hitters.map(async (player) => {
      const id = player?.person?.id;
      if (!id) return;
      const boxStats = hitterBattingStats(player);
      const boxPa = Math.max(
        firstStatNumber(boxStats, ['plateAppearances', 'pa'], 0),
        firstStatNumber(boxStats, ['atBats', 'ab'], 0)
      );

      // Fetch full current-season (all teams, handles mid-season trades!) + prior
      // season (`season - 1`, handles Opening Day / April / offseason trades!)
      // whenever boxscore PA < 90.
      if (boxPa < 90) {
        const cacheKey = `${id}:${season}:${dateYmd || 'live'}`;
        let cached = hitterCache?.get(cacheKey);
        if (cached === undefined) {
          const [curAllTeams, priorSeason] = await Promise.all([
            fetchHitterSeasonStats(id, season, dateYmd).catch(() => null),
            fetchHitterSeasonStats(id, season - 1, null).catch(() => null)
          ]);
          cached = { current: curAllTeams || boxStats, prior: priorSeason };
          hitterCache?.set(cacheKey, cached);
        }
        hitterLookups.set(id, cached);
      }

      // Per-hitter handedness platoon split from `season - 1` (strictly leakage-safe
      // pre-season baseline) blended with current season when today >= live/asOf safe.
      if (splitCode) {
        const pKey = `${id}:${splitCode}:${season - 1}`;
        let split = platoonCache?.get(pKey);
        if (split === undefined) {
          split = await fetchHitterPlatoonSplit(id, splitCode, season - 1).catch(() => null);
          platoonCache?.set(pKey, split);
        }
        if (split && Number.isFinite(split.ops)) {
          platoonSplits.set(id, split);
        }
      }
    })
  );

  return { hitterLookups, platoonSplits };
}

async function fetchGameLineupProfile(
  game,
  requestedAtUtc = new Date().toISOString(),
  context = {}
) {
  const requestedTemporal = lineupTemporalEligibility(game, requestedAtUtc);
  if (!requestedTemporal.ok) {
    return {
      away: null,
      home: null,
      requestedAtUtc,
      fetchedAtUtc: null,
      temporal: requestedTemporal
    };
  }

  const boxscore = await fetchBoxscore(game.gamePk);
  const fetchedAtUtc = new Date().toISOString();
  const temporal = lineupTemporalEligibility(game, fetchedAtUtc);
  if (!temporal.ok) {
    return {
      away: null,
      home: null,
      requestedAtUtc,
      fetchedAtUtc,
      temporal
    };
  }

  const awayTeamId = game?.teams?.away?.team?.id;
  const homeTeamId = game?.teams?.home?.team?.id;
  const awayStarterId = game?.teams?.away?.probablePitcher?.id;
  const homeStarterId = game?.teams?.home?.probablePitcher?.id;
  const awayStarterHand =
    game?.teams?.away?.probablePitcher?.pitchHand?.code ||
    context.pitcherDetails?.get?.(awayStarterId)?.pitchHand?.code ||
    null;
  const homeStarterHand =
    game?.teams?.home?.probablePitcher?.pitchHand?.code ||
    context.pitcherDetails?.get?.(homeStarterId)?.pitchHand?.code ||
    null;

  const [awayEnriched, homeEnriched] = await Promise.all([
    enrichLineupHittersForSide(boxscore.teams?.away, homeStarterHand, context),
    enrichLineupHittersForSide(boxscore.teams?.home, awayStarterHand, context)
  ]);

  return {
    away: extractLineupProfile(boxscore.teams?.away, {
      hitterLookups: awayEnriched.hitterLookups,
      platoonSplits: awayEnriched.platoonSplits,
      rosterContext: context.rosterProfiles?.get?.(awayTeamId) || null,
      oppPitchHand: homeStarterHand
    }),
    home: extractLineupProfile(boxscore.teams?.home, {
      hitterLookups: homeEnriched.hitterLookups,
      platoonSplits: homeEnriched.platoonSplits,
      rosterContext: context.rosterProfiles?.get?.(homeTeamId) || null,
      oppPitchHand: awayStarterHand
    }),
    requestedAtUtc,
    fetchedAtUtc,
    temporal
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
        relieverUsage: new Map(),
        highPitchRelievers: 0,
        qualityOuts14d: 0,
        qualityEarnedRuns14d: 0,
        qualityHits14d: 0,
        qualityWalks14d: 0,
        qualityStrikeouts14d: 0,
        qualityHomeRuns14d: 0
      }
    ])
  );
  // Look back 14 days so bullpen run-prevention quality (ERA/WHIP/K-BB/HR9) and
  // high-leverage role identification have real sample, while strictly isolating
  // 3-day workload for fatigue & reliever availability metrics!
  const games = await fetchRecentTeamGames(teamIds, dateYmd, 14);

  const MAX_CONCURRENT = 6;
  const queue = [...games];
  async function runNext() {
    while (queue.length) {
      const game = queue.shift();
      const gameDate = String(game.officialDate || game.gameDate || '').slice(0, 10);
      const dayDiff = gameDate ? ymdDiff(dateYmd, gameDate) : null;
      const isLast3Days = dayDiff !== null && dayDiff >= 1 && dayDiff <= 3;
      let boxscore;
      try {
        boxscore = await fetchBoxscore(game.gamePk);
      } catch {
        continue;
      }

      const homeRuns = toNumber(
        boxscore.teams?.home?.teamStats?.batting?.runs ?? game.teams?.home?.score,
        null
      );
      const awayRuns = toNumber(
        boxscore.teams?.away?.teamStats?.batting?.runs ?? game.teams?.away?.score,
        null
      );
      const isCloseGame =
        homeRuns !== null && awayRuns !== null && Math.abs(homeRuns - awayRuns) <= 3;

      for (const side of ['away', 'home']) {
        const team = game.teams[side].team;
        const profile = profiles.get(team.id);
        if (!profile) continue;

        if (isLast3Days) profile.games += 1;
        const boxTeam = boxscore.teams?.[side];
        const pitcherOrder = Array.isArray(boxTeam?.pitchers) ? boxTeam.pitchers : [];
        for (let idx = 0; idx < pitcherOrder.length; idx += 1) {
          const personId = pitcherOrder[idx];
          const player = boxTeam.players?.[`ID${personId}`];
          const stats = player?.stats?.pitching || {};
          const seasonPitch = player?.seasonStats?.pitching || {};
          if (toNumber(stats.gamesStarted, 0) > 0) continue;

          const outs = Math.round(parseInnings(stats.inningsPitched) * 3);
          profile.qualityOuts14d += outs;
          profile.qualityEarnedRuns14d += toNumber(stats.earnedRuns, 0);
          profile.qualityHits14d += toNumber(stats.hits, 0);
          profile.qualityWalks14d += toNumber(stats.baseOnBalls, 0);
          profile.qualityStrikeouts14d += toNumber(stats.strikeOuts, 0);
          profile.qualityHomeRuns14d += toNumber(stats.homeRuns, 0);

          const key = String(personId);
          if (!profile.relieverUsage.has(key)) {
            profile.relieverUsage.set(key, {
              dates3d: new Set(),
              pitches3d: 0,
              pitchesYesterday: 0,
              pitchedYesterday: false,
              pitchedTwoDaysAgo: false,
              maxSinglePitches: 0,
              highLeverage: false,
              closerRole: false
            });
          }
          const usage = profile.relieverUsage.get(key);
          const isCloser =
            toNumber(stats.saves, 0) > 0 ||
            toNumber(stats.blownSaves, 0) > 0 ||
            toNumber(seasonPitch.saves, 0) >= 3;
          const isLateInningArm = idx >= Math.max(1, pitcherOrder.length - 2);
          const isHighLeverage =
            isCloser ||
            toNumber(stats.holds, 0) > 0 ||
            toNumber(stats.saveOpportunities, 0) > 0 ||
            toNumber(seasonPitch.holds, 0) >= 4 ||
            (isLateInningArm && isCloseGame);
          if (isCloser) usage.closerRole = true;
          if (isHighLeverage) usage.highLeverage = true;

          if (isLast3Days) {
            const pitches = toNumber(stats.numberOfPitches, 0);
            profile.bullpenPitches += pitches;
            profile.bullpenOuts += outs;
            profile.relieverAppearances += 1;
            if (pitches >= 25) profile.highPitchRelievers += 1;

            if (!profile.relieverDates.has(key)) profile.relieverDates.set(key, new Set());
            profile.relieverDates.get(key).add(gameDate || game.gameDate);

            usage.dates3d.add(gameDate || game.gameDate);
            usage.pitches3d += pitches;
            if (pitches > usage.maxSinglePitches) usage.maxSinglePitches = pitches;
            if (dayDiff === 1) {
              usage.pitchedYesterday = true;
              usage.pitchesYesterday += pitches;
            } else if (dayDiff === 2) {
              usage.pitchedTwoDaysAgo = true;
            }
          }
        }
      }
    }
  }
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, Math.max(1, games.length)) }, () => runNext());
  await Promise.all(workers);

  for (const [teamId, profile] of profiles.entries()) {
    profiles.set(teamId, finalizeBullpenProfile(profile));
  }

  return profiles;
}

function summarizeBullpenLeverage(relieverUsage) {
  if (!relieverUsage) {
    return {
      highLeverageRelieversTracked: null,
      highLeverageUnavailable: null,
      highLeverageTaxed: null,
      closerUnavailable: null,
      leverageFatigueScore: null
    };
  }
  const entries =
    relieverUsage instanceof Map
      ? [...relieverUsage.values()]
      : Array.isArray(relieverUsage)
        ? relieverUsage
        : Object.values(relieverUsage);

  let tracked = 0;
  let unavailable = 0;
  let taxed = 0;
  let closerUnavailable = false;

  for (const u of entries) {
    if (!u || typeof u !== 'object') continue;
    const isHL = Boolean(u.highLeverage || u.closerRole);
    if (!isHL) continue;
    tracked += 1;
    const daysCount =
      u.dates3d instanceof Set
        ? u.dates3d.size
        : Array.isArray(u.dates3d)
          ? u.dates3d.length
          : toNumber(u.daysPitched3d, 0);
    const pitches3d = toNumber(u.pitches3d, 0);
    const pitchesYesterday = toNumber(u.pitchesYesterday, 0);
    const pitchedYesterday = Boolean(u.pitchedYesterday);
    const pitchedTwoDaysAgo = Boolean(u.pitchedTwoDaysAgo);

    const isUnavailable =
      daysCount >= 3 ||
      pitchesYesterday >= 35 ||
      (pitchedYesterday && pitchedTwoDaysAgo) ||
      (daysCount >= 2 && pitches3d >= 35);
    const isTaxed =
      isUnavailable || daysCount >= 2 || pitchesYesterday >= 25 || pitches3d >= 40;

    if (isUnavailable) {
      unavailable += 1;
      if (u.closerRole) closerUnavailable = true;
    }
    if (isTaxed) {
      taxed += 1;
    }
  }

  const taxedOnly = Math.max(0, taxed - unavailable);
  const leverageFatigueScore =
    Math.round((unavailable * 0.55 + taxedOnly * 0.25 + (closerUnavailable ? 0.25 : 0)) * 1000) /
    1000;

  return {
    highLeverageRelieversTracked: tracked,
    highLeverageUnavailable: unavailable,
    highLeverageTaxed: taxed,
    closerUnavailable,
    leverageFatigueScore
  };
}

function finalizeBullpenProfile(profile) {
  const backToBackRelievers = [...(profile.relieverDates?.values?.() || [])].filter((dates) => dates.size >= 2).length;
  const innings = toNumber(profile.bullpenOuts, 0) / 3;
  const leverage = summarizeBullpenLeverage(profile.relieverUsage || null);
  const leverageBonus =
    leverage.leverageFatigueScore !== null ? leverage.leverageFatigueScore * 0.25 : 0;
  const fatigueScore =
    toNumber(profile.bullpenPitches, 0) / 120 +
    backToBackRelievers * 0.2 +
    toNumber(profile.highPitchRelievers, 0) * 0.12 +
    Math.max(0, toNumber(profile.games, 0) - 2) * 0.15 +
    leverageBonus;
  const level = fatigueScore >= 1.7 ? 'high' : fatigueScore >= 0.9 ? 'medium' : 'low';

  // Bayesian-shrunk 14-day bullpen run-prevention quality (prior = 12 IP).
  const qIp = toNumber(profile.qualityOuts14d, 0) / 3;
  let reliefEra = null;
  let reliefWhip = null;
  let reliefKbb = null;
  let reliefHr9 = null;
  if (qIp >= 2) {
    const PRIOR_IP = 12;
    const w = clamp(qIp / (qIp + PRIOR_IP), 0, 1);
    const rawEra = (toNumber(profile.qualityEarnedRuns14d, 0) * 9) / qIp;
    const rawWhip =
      (toNumber(profile.qualityHits14d, 0) + toNumber(profile.qualityWalks14d, 0)) / qIp;
    const rawKbb =
      toNumber(profile.qualityStrikeouts14d, 0) / Math.max(1, toNumber(profile.qualityWalks14d, 0));
    const rawHr9 = (toNumber(profile.qualityHomeRuns14d, 0) * 9) / qIp;
    reliefEra = Math.round((w * rawEra + (1 - w) * 4.05) * 100) / 100;
    reliefWhip = Math.round((w * rawWhip + (1 - w) * 1.28) * 100) / 100;
    reliefKbb = Math.round((w * rawKbb + (1 - w) * 2.35) * 100) / 100;
    reliefHr9 = Math.round((w * rawHr9 + (1 - w) * 1.05) * 100) / 100;
  }

  const qualityText =
    reliefEra !== null ? `, 14d RP ERA ${safeFixed(reliefEra)} WHIP ${safeFixed(reliefWhip)}` : '';
  const leverageText =
    leverage.highLeverageUnavailable > 0 || leverage.closerUnavailable
      ? `, HL unavail ${leverage.highLeverageUnavailable}${leverage.closerUnavailable ? ' (closer)' : ''}`
      : '';

  return {
    teamId: profile.teamId,
    games: toNumber(profile.games, 0),
    bullpenPitches: toNumber(profile.bullpenPitches, 0),
    bullpenInnings: innings,
    reliefInnings14d: Math.round(qIp * 10) / 10,
    reliefEra,
    reliefWhip,
    reliefKbb,
    reliefHr9,
    relieverAppearances: toNumber(profile.relieverAppearances, 0),
    backToBackRelievers,
    highPitchRelievers: toNumber(profile.highPitchRelievers, 0),
    highLeverageRelieversTracked: leverage.highLeverageRelieversTracked,
    highLeverageUnavailable: leverage.highLeverageUnavailable,
    highLeverageTaxed: leverage.highLeverageTaxed,
    closerUnavailable: leverage.closerUnavailable,
    leverageFatigueScore: leverage.leverageFatigueScore,
    fatigueScore,
    level,
    line: `${toNumber(profile.games, 0)}G last 3d, ${Math.round(toNumber(profile.bullpenPitches, 0))} pitches, ${safeFixed(innings, 1)} IP, B2B relievers ${backToBackRelievers}, fatigue ${level}${leverageText}${qualityText}`
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

function offseasonTransactionStartDate(season) {
  // Include full winter offseason (Nov 1 of prior year) so offseason trades,
  // free-agent signings, waiver claims, rotation additions, and 60-day IL
  // placements are all captured on Opening Day of the new season!
  return `${season - 1}-11-01`;
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

function classifyRosterTransaction(transaction, teamId) {
  const desc = String(transaction?.description || '');
  const typeDesc = String(transaction?.typeDesc || transaction?.typeCode || '').toLowerCase();
  const toTeamId = transaction?.toTeam?.id;
  const fromTeamId = transaction?.fromTeam?.id;

  if (/traded/i.test(desc) || typeDesc.includes('trade') || typeDesc === 'tr') {
    if (toTeamId && Number(toTeamId) === Number(teamId)) return 'trade_in';
    if (fromTeamId && Number(fromTeamId) === Number(teamId)) return 'trade_out';
    return 'trade';
  }
  if (/signed as a free agent|signed free agent/i.test(desc) || typeDesc.includes('free agent')) {
    return 'signing';
  }
  if (/claimed .* off waivers/i.test(desc) || typeDesc.includes('claim')) {
    return toTeamId && Number(toTeamId) === Number(teamId) ? 'claim_in' : 'claim_out';
  }
  if (/designated .* for assignment|released/i.test(desc)) {
    return 'departure';
  }
  return null;
}

function parseRosterAndTransactions(rosterData, transactionData, teamId, dateYmd = null) {
  const rosterItems = Array.isArray(rosterData?.roster) ? rosterData.roster : [];
  const activePlayerIds = new Set();
  const rosterPositionById = new Map();

  for (const item of rosterItems) {
    const id = item?.person?.id;
    if (!id) continue;
    rosterPositionById.set(id, item.position?.abbreviation || item.position?.name || '-');
    if (!/injured/i.test(item.status?.description || '')) {
      activePlayerIds.add(id);
    }
  }

  const latestInjuryTransactions = new Map();
  const acquisitionsByPerson = new Map();
  const departuresByPerson = new Map();

  for (const transaction of transactionData?.transactions || []) {
    const txDate = String(transaction?.date || transaction?.effectiveDate || '').slice(0, 10);
    // Strict temporal guard: ignore any transaction dated after prediction day.
    if (dateYmd && txDate && txDate > dateYmd) continue;

    const personId = transaction?.person?.id;
    const personName = transaction?.person?.fullName || 'Unknown player';
    const description = transaction?.description || '';
    if (!personId) continue;

    if (/injured list|injury|injured/i.test(description)) {
      latestInjuryTransactions.set(personId, {
        date: txDate,
        description,
        note: injuryNoteFromTransaction(description)
      });
    }

    const kind = classifyRosterTransaction(transaction, teamId);
    if (!kind) continue;

    if (
      (kind === 'trade_in' || kind === 'signing' || kind === 'claim_in' || kind === 'trade') &&
      activePlayerIds.has(personId)
    ) {
      acquisitionsByPerson.set(personId, {
        id: personId,
        name: personName,
        position: rosterPositionById.get(personId) || '-',
        type: kind === 'signing' ? 'signing' : kind.startsWith('claim') ? 'claim' : 'trade',
        date: txDate,
        description: compactText(description, 140)
      });
      departuresByPerson.delete(personId);
    } else if (
      (kind === 'trade_out' || kind === 'departure' || kind === 'claim_out') &&
      !activePlayerIds.has(personId)
    ) {
      departuresByPerson.set(personId, {
        id: personId,
        name: personName,
        type: kind,
        date: txDate
      });
    }
  }

  const injuries = rosterItems
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

  const recentAcquisitions = [...acquisitionsByPerson.values()].sort((a, b) =>
    String(b.date).localeCompare(String(a.date))
  );
  const recentDepartures = [...departuresByPerson.values()].sort((a, b) =>
    String(b.date).localeCompare(String(a.date))
  );
  const turnoverScore =
    Math.round(
      clamp((recentAcquisitions.length * 1.15 + recentDepartures.length * 0.75) / 14, 0, 1) * 1000
    ) / 1000;

  return {
    injuries,
    rosterContext: {
      teamId,
      activeCount: activePlayerIds.size,
      activePlayerIds: [...activePlayerIds],
      recentAcquisitions: recentAcquisitions.slice(0, 15),
      recentDepartures: recentDepartures.slice(0, 15),
      acquisitionsCount: recentAcquisitions.length,
      departuresCount: recentDepartures.length,
      turnoverScore
    }
  };
}

async function fetchTeamRosterAndInjuries(teamId, dateYmd, season) {
  const rosterParams = new URLSearchParams({
    rosterType: '40Man',
    date: dateYmd
  });
  const transactionParams = new URLSearchParams({
    teamId: String(teamId),
    startDate: offseasonTransactionStartDate(season),
    endDate: dateYmd
  });

  const [rosterData, transactionData] = await Promise.all([
    fetchJson(`${MLB_BASE_URL}/teams/${teamId}/roster?${rosterParams}`),
    fetchJson(`${MLB_BASE_URL}/transactions?${transactionParams}`)
  ]);

  return parseRosterAndTransactions(rosterData, transactionData, teamId, dateYmd);
}

async function fetchRosterAndInjuryProfiles(teamIds, dateYmd, season) {
  const injuries = new Map();
  const rosters = new Map();

  await Promise.all(
    teamIds.map(async (teamId) => {
      try {
        const parsed = await fetchTeamRosterAndInjuries(teamId, dateYmd, season);
        injuries.set(teamId, parsed.injuries);
        rosters.set(teamId, parsed.rosterContext);
      } catch {
        injuries.set(teamId, []);
        rosters.set(teamId, {
          teamId,
          activeCount: 0,
          activePlayerIds: [],
          recentAcquisitions: [],
          recentDepartures: [],
          acquisitionsCount: 0,
          departuresCount: 0,
          turnoverScore: 0
        });
      }
    })
  );

  return { injuries, rosters };
}

/**
 * Early-season / post-offseason team stat continuity:
 * When current-season games played < 35 (March/April of a new season), blend
 * current stats with prior-season (`season - 1`) stats AND regress toward
 * league-average DEFAULTS in proportion to roster turnover (`turnoverScore`).
 * High trade/free-agent turnover shrinks stale last-year team averages toward
 * neutral so today's actual Probable Starter + Starting Lineup carry the edge!
 */
function blendTeamStatsWithPrior(currentMap, priorMap, rosterProfiles = new Map(), teamIds = []) {
  const allIds = new Set([
    ...teamIds,
    ...(currentMap instanceof Map ? currentMap.keys() : []),
    ...(priorMap instanceof Map ? priorMap.keys() : [])
  ]);
  const blended = new Map();
  const FULL_SAMPLE_GAMES = 35;

  for (const teamId of allIds) {
    const cur = currentMap?.get?.(teamId) || null;
    const prior = priorMap?.get?.(teamId) || null;
    const curGames = toNumber(cur?.hitting?.gamesPlayed ?? cur?.pitching?.gamesPlayed, 0);

    if (cur && curGames >= FULL_SAMPLE_GAMES) {
      blended.set(teamId, cur);
      continue;
    }
    if (!cur && !prior) continue;

    const turnover = toNumber(rosterProfiles?.get?.(teamId)?.turnoverScore, 0);
    const wCur = clamp(curGames / FULL_SAMPLE_GAMES, 0, 1);
    const wPrior = prior ? (1 - wCur) * 0.65 * (1 - turnover * 0.55) : 0;
    const wLeague = Math.max(0, 1 - wCur - wPrior);

    const blendNum = (curVal, priorVal, defVal) => {
      const c = Number.isFinite(curVal) && curGames > 0 ? curVal : defVal;
      const p = Number.isFinite(priorVal) && prior ? priorVal : defVal;
      return wCur * c + wPrior * p + wLeague * defVal;
    };

    const effectiveGames = Math.max(1, curGames || 1);
    const blendedRpg = blendNum(
      cur?.hitting ? rpg(cur.hitting) : Number.NaN,
      prior?.hitting ? rpg(prior.hitting) : Number.NaN,
      DEFAULTS.rpg
    );
    const blendedOps = blendNum(
      cur?.hitting ? statOps(cur.hitting) : Number.NaN,
      prior?.hitting ? statOps(prior.hitting) : Number.NaN,
      DEFAULTS.ops
    );
    const blendedIso = blendNum(
      cur?.hittingAdvanced ? statIso(cur.hittingAdvanced) : Number.NaN,
      prior?.hittingAdvanced ? statIso(prior.hittingAdvanced) : Number.NaN,
      DEFAULTS.iso
    );
    const blendedKRate = blendNum(
      cur?.hittingAdvanced ? battingKRate(cur.hittingAdvanced) : Number.NaN,
      prior?.hittingAdvanced ? battingKRate(prior.hittingAdvanced) : Number.NaN,
      DEFAULTS.kRate
    );
    const blendedBbRate = blendNum(
      cur?.hittingAdvanced ? battingBbRate(cur.hittingAdvanced) : Number.NaN,
      prior?.hittingAdvanced ? battingBbRate(prior.hittingAdvanced) : Number.NaN,
      DEFAULTS.bbRate
    );
    const blendedEra = blendNum(
      cur?.pitching ? statEra(cur.pitching) : Number.NaN,
      prior?.pitching ? statEra(prior.pitching) : Number.NaN,
      DEFAULTS.era
    );
    const blendedWhip = blendNum(
      cur?.pitching ? statWhip(cur.pitching) : Number.NaN,
      prior?.pitching ? statWhip(prior.pitching) : Number.NaN,
      DEFAULTS.whip
    );
    const blendedKMinusBb = blendNum(
      cur?.pitchingAdvanced ? pitchingKMinusBb(cur.pitchingAdvanced) : Number.NaN,
      prior?.pitchingAdvanced ? pitchingKMinusBb(prior.pitchingAdvanced) : Number.NaN,
      DEFAULTS.kMinusBb
    );
    const blendedHr9 = blendNum(
      cur?.pitchingAdvanced ? pitchingHr9(cur.pitchingAdvanced) : Number.NaN,
      prior?.pitchingAdvanced ? pitchingHr9(prior.pitchingAdvanced) : Number.NaN,
      DEFAULTS.hr9
    );

    blended.set(teamId, {
      team: cur?.team || prior?.team || { id: teamId },
      hitting: {
        ...(cur?.hitting || {}),
        gamesPlayed: effectiveGames,
        runs: blendedRpg * effectiveGames,
        ops: blendedOps.toFixed(3)
      },
      hittingAdvanced: {
        ...(cur?.hittingAdvanced || {}),
        iso: blendedIso,
        strikeoutsPerPlateAppearance: blendedKRate,
        walksPerPlateAppearance: blendedBbRate
      },
      pitching: {
        ...(cur?.pitching || {}),
        gamesPlayed: effectiveGames,
        era: blendedEra.toFixed(2),
        whip: blendedWhip.toFixed(2),
        runs: blendedEra * effectiveGames
      },
      pitchingAdvanced: {
        ...(cur?.pitchingAdvanced || {}),
        strikeoutsMinusWalksPercentage: blendedKMinusBb,
        homeRunsPer9: blendedHr9
      },
      blendedWithPriorSeason: wPrior > 0
    });
  }

  return blended;
}

function blendStandingsWithPrior(currentMap, priorMap, rosterProfiles = new Map(), teamIds = []) {
  const allIds = new Set([
    ...teamIds,
    ...(currentMap instanceof Map ? currentMap.keys() : []),
    ...(priorMap instanceof Map ? priorMap.keys() : [])
  ]);
  const blended = new Map();
  const FULL_STANDINGS_GAMES = 30;

  for (const teamId of allIds) {
    const cur = currentMap?.get?.(teamId) || null;
    const prior = priorMap?.get?.(teamId) || null;
    const curGames = toNumber(cur?.gamesPlayed, 0);
    if (cur && curGames >= FULL_STANDINGS_GAMES) {
      blended.set(teamId, cur);
      continue;
    }
    if (!cur && !prior) continue;

    const turnover = toNumber(rosterProfiles?.get?.(teamId)?.turnoverScore, 0);
    const wCur = clamp(curGames / FULL_STANDINGS_GAMES, 0, 1);
    const wPrior = prior ? (1 - wCur) * 0.62 * (1 - turnover * 0.55) : 0;
    const wLeague = Math.max(0, 1 - wCur - wPrior);

    const curPct = cur && curGames > 0 ? leagueRecordPct(cur.leagueRecord) : DEFAULTS.winPct;
    const priorPct = prior ? leagueRecordPct(prior.leagueRecord) : DEFAULTS.winPct;
    const shrunkPct = clamp(wCur * curPct + wPrior * priorPct + wLeague * DEFAULTS.winPct, 0.3, 0.7);

    const curRdPerG = cur && curGames > 0 ? runDiffPerGame(cur) : 0;
    const priorRdPerG = prior ? runDiffPerGame(prior) : 0;
    const shrunkRdPerG = wCur * curRdPerG + wPrior * priorRdPerG;
    const effectiveGames = Math.max(1, curGames || 1);

    blended.set(teamId, {
      ...(prior || {}),
      ...(cur || {}),
      team: cur?.team || prior?.team || { id: teamId },
      gamesPlayed: curGames,
      runDifferential: Math.round(shrunkRdPerG * effectiveGames * 10) / 10,
      leagueRecord: {
        wins: cur?.leagueRecord?.wins ?? 0,
        losses: cur?.leagueRecord?.losses ?? 0,
        pct: shrunkPct.toFixed(3)
      },
      blendedWithPriorSeason: wPrior > 0
    });
  }

  return blended;
}

async function fetchTeamStats(season, asOfDateYmd = null) {
  // Season-to-date aggregates end strictly before prediction day. Basic and
  // advanced requests stay separate because StatsAPI does not consistently
  // return both families from one comma-separated date-range request.
  const range = asOfDateYmd ? aggregateDateRange(season, asOfDateYmd) : null;
  if (asOfDateYmd && !range) return new Map();

  const request = async (statsType) => {
    const params = new URLSearchParams({
      season: String(season),
      stats: statsType,
      group: 'hitting,pitching',
      sportIds: '1',
      gameType: 'R'
    });
    if (range) {
      params.set('startDate', range.startDate);
      params.set('endDate', range.endDate);
    }
    return getTeamStatMap(await fetchJson(`${MLB_BASE_URL}/teams/stats?${params}`));
  };

  if (!range) {
    const [basic, advanced] = await Promise.all([
      request('season'),
      request('seasonAdvanced')
    ]);
    return mergeTeamStatMaps(basic, advanced);
  }

  const basic = await request('byDateRange');
  // Advanced date-range support varies by StatsAPI deployment. Keep basic
  // season-to-date data when unsupported; never claim advanced defaults observed.
  const advanced = await request('byDateRangeAdvanced').catch(() => new Map());
  return mergeTeamStatMaps(basic, advanced);
}

async function fetchRollingTeamStats(season, dateYmd, days = ROLLING_FORM_DAYS) {
  const { startDate, endDate } = rollingFormWindow(dateYmd, days);
  // Guard: if window starts before season open, clamp so API returns real splits.
  const seasonOpen = seasonStartDate(season);
  const safeStart = startDate < seasonOpen ? seasonOpen : startDate;
  if (safeStart > endDate) return new Map();

  const params = new URLSearchParams({
    season: String(season),
    stats: 'byDateRange',
    group: 'hitting,pitching',
    sportIds: '1',
    gameType: 'R',
    startDate: safeStart,
    endDate
  });

  return getRollingTeamStatMap(await fetchJson(`${MLB_BASE_URL}/teams/stats?${params}`));
}

async function fetchStandings(season, dateYmd = null) {
  if (dateYmd) {
    const range = aggregateDateRange(season, dateYmd);
    if (!range) return new Map();

    const params = new URLSearchParams({
      leagueId: '103,104',
      season: String(season),
      standingsTypes: 'regularSeason',
      date: range.endDate
    });

    return getStandingMap(await fetchJson(`${MLB_BASE_URL}/standings?${params}`));
  }

  const params = new URLSearchParams({
    leagueId: '103,104',
    season: String(season),
    standingsTypes: 'regularSeason'
  });
  return getStandingMap(await fetchJson(`${MLB_BASE_URL}/standings?${params}`));
}

function combinePitcherStatSplits(splits) {
  if (!Array.isArray(splits) || splits.length === 0) return null;
  if (splits.length === 1) return splits[0]?.stat || null;
  const combined = splits.find((s) => !s.team);
  if (combined?.stat) return combined.stat;

  // Aggregate across multi-team splits so mid-season traded pitchers carry their
  // complete season workload instead of only their first or second club's split!
  let outs = 0;
  let er = 0;
  let hits = 0;
  let bb = 0;
  let so = 0;
  let hr = 0;
  let gs = 0;
  let gp = 0;
  let weightedKMinusBb = 0;
  let kMinusBbWeight = 0;
  for (const s of splits) {
    const st = s?.stat || {};
    const ip = parseInnings(st.inningsPitched);
    outs += Math.round(ip * 3);
    er += toNumber(st.earnedRuns, 0);
    hits += toNumber(st.hits, 0);
    bb += toNumber(st.baseOnBalls, 0);
    so += toNumber(st.strikeOuts, 0);
    hr += toNumber(st.homeRuns, 0);
    gs += toNumber(st.gamesStarted, 0);
    gp += toNumber(st.gamesPitched ?? st.appearances, 0);
    if (ip > 0) {
      kMinusBbWeight += ip;
      weightedKMinusBb += toNumber(st.strikeoutsMinusWalksPercentage, DEFAULTS.kMinusBb) * ip;
    }
  }
  const ip = outs / 3;
  const whole = Math.floor(outs / 3);
  const rem = outs % 3;
  return {
    inningsPitched: `${whole}.${rem}`,
    era: ip > 0 ? ((er * 9) / ip).toFixed(2) : DEFAULTS.era.toFixed(2),
    whip: ip > 0 ? ((hits + bb) / ip).toFixed(2) : DEFAULTS.whip.toFixed(2),
    earnedRuns: er,
    hits,
    baseOnBalls: bb,
    strikeOuts: so,
    homeRuns: hr,
    gamesStarted: gs,
    gamesPitched: gp,
    homeRunsPer9: ip > 0 ? (hr * 9) / ip : DEFAULTS.hr9,
    strikeoutsMinusWalksPercentage: kMinusBbWeight > 0 ? weightedKMinusBb / kMinusBbWeight : DEFAULTS.kMinusBb
  };
}

async function fetchPitcherStats(personId, season, asOfDateYmd = null) {
  if (!personId) return null;

  const params = new URLSearchParams({
    group: 'pitching',
    season: String(season),
    gameType: 'R'
  });
  // Season-to-date ends strictly before prediction day. Full-season without an
  // as-of is used for completed prior seasons (`season - 1`, strictly historical).
  if (asOfDateYmd) {
    const range = aggregateDateRange(season, asOfDateYmd);
    if (!range) return null;
    params.set('stats', 'byDateRange');
    params.set('startDate', range.startDate);
    params.set('endDate', range.endDate);
  } else {
    params.set('stats', 'season');
  }

  const data = await fetchJson(`${MLB_BASE_URL}/people/${personId}/stats?${params}`);
  return combinePitcherStatSplits(data.stats?.[0]?.splits || []);
}

async function fetchPitcherStatsWithPrior(personId, season, asOfDateYmd = null) {
  if (!personId) return null;
  const current = await fetchPitcherStats(personId, season, asOfDateYmd).catch(() => null);
  const currentIp = current ? parseInnings(current.inningsPitched) : 0;
  // When current-season sample is < 45 IP (Opening Day, April, call-up, or IL return),
  // attach prior-season (`season - 1`) stats across all teams so Bayesian IP shrinkage
  // in prediction_core.js preserves true pitcher talent immediately after offseason trades!
  if (currentIp >= 45) return current;

  const priorSeason = await fetchPitcherStats(personId, season - 1, null).catch(() => null);
  if (!current && !priorSeason) return null;
  return {
    ...(current || { inningsPitched: '0.0' }),
    priorSeason
  };
}

async function fetchPerson(personId) {
  if (!personId) return null;
  const data = await fetchJson(`${MLB_BASE_URL}/people/${personId}`);
  return data.people?.[0] || null;
}

async function fetchPitcherRecentStarts(personId, season, limit = 5, asOfDateYmd = null) {
  if (!personId) return null;

  const params = new URLSearchParams({
    stats: 'gameLog',
    group: 'pitching',
    season: String(season),
    gameType: 'R'
  });
  const data = await fetchJson(`${MLB_BASE_URL}/people/${personId}/stats?${params}`);
  // Strict as-of: only starts before the prediction date.
  const started = (data.stats?.[0]?.splits || []).filter(
    (split) => toNumber(split.stat?.gamesStarted, 0) > 0
  );
  let eligible = asOfDateYmd
    ? filterSplitsBeforeDate(started, asOfDateYmd)
    : [];

  // Early-season supplement (March/April): if a starter has < 3 starts so far in
  // the new season, pull remaining starts from late `season - 1` regular season
  // (strictly < asOfDateYmd) so traded/returning starters aren't missing recent form!
  const month = asOfDateYmd ? Number.parseInt(String(asOfDateYmd).slice(5, 7), 10) : 6;
  if (asOfDateYmd && eligible.length < 3 && month <= 4) {
    try {
      const priorParams = new URLSearchParams({
        stats: 'gameLog',
        group: 'pitching',
        season: String(season - 1),
        gameType: 'R'
      });
      const priorData = await fetchJson(`${MLB_BASE_URL}/people/${personId}/stats?${priorParams}`);
      const priorStarted = filterSplitsBeforeDate(
        (priorData.stats?.[0]?.splits || []).filter(
          (split) => toNumber(split.stat?.gamesStarted, 0) > 0
        ),
        asOfDateYmd
      );
      eligible = [...priorStarted.slice(-(limit - eligible.length)), ...eligible];
    } catch {
      // Keep current-season starts if prior gameLog unavailable.
    }
  }

  const starts = eligible.slice(-limit);
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

function summarizeHeadToHeadGames(game, games, predictionDateYmd) {
  const awayTeamId = game.teams.away.team.id;
  const homeTeamId = game.teams.home.team.id;
  const cutoff = String(predictionDateYmd || '').slice(0, 10);
  const eligible = (games || [])
    .filter((item) => String(item?.gamePk) !== String(game.gamePk))
    .filter((item) => {
      const officialDate = String(item?.officialDate || item?.gameDate || '').slice(0, 10);
      return officialDate && cutoff && officialDate < cutoff;
    })
    .filter((item) => item.status?.abstractGameState === 'Final')
    .filter((item) => Number.isFinite(item.teams?.away?.score) && Number.isFinite(item.teams?.home?.score));

  let awayWins = 0;
  let homeWins = 0;

  for (const item of eligible) {
    const winnerId =
      item.teams.away.score > item.teams.home.score
        ? item.teams.away.team.id
        : item.teams.home.team.id;

    if (winnerId === awayTeamId) awayWins += 1;
    if (winnerId === homeTeamId) homeWins += 1;
  }

  const total = awayWins + homeWins;
  const awayProbability = ((awayWins + 1) / (total + 2)) * 100;
  return {
    games: total,
    awayWins,
    homeWins,
    awayProbability,
    homeProbability: 100 - awayProbability
  };
}

async function fetchHeadToHead(game, season, dateYmd) {
  const range = aggregateDateRange(season, dateYmd);
  if (!range) return summarizeHeadToHeadGames(game, [], dateYmd);

  const awayTeamId = game.teams.away.team.id;
  const homeTeamId = game.teams.home.team.id;
  const params = new URLSearchParams({
    sportId: '1',
    season: String(season),
    gameTypes: 'R',
    teamId: String(awayTeamId),
    opponentId: String(homeTeamId),
    startDate: range.startDate,
    endDate: range.endDate,
    hydrate: 'linescore'
  });

  const data = await fetchJson(`${MLB_BASE_URL}/schedule?${params}`);
  return summarizeHeadToHeadGames(
    game,
    (data.dates || []).flatMap((date) => date.games || []),
    dateYmd
  );
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
    }
  };
}

function starterSeasonEdge(homePitcherStats, awayPitcherStats) {
  return coreStarterSeasonEdge(homePitcherStats, awayPitcherStats);
}

function starterRecentEdge(homeRecent, awayRecent) {
  return coreStarterRecentEdge(homeRecent, awayRecent);
}

function starterEdge(homePitcherStats, awayPitcherStats, homeRecent = null, awayRecent = null) {
  return coreStarterEdge(homePitcherStats, awayPitcherStats, homeRecent, awayRecent);
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
  homePitcherRecent = null,
  awayPitcherRecent = null,
  homeRolling = null,
  awayRolling = null,
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
  const winnerRecent = probHome >= 50 ? homePitcherRecent : awayPitcherRecent;
  const loserRecent = probHome >= 50 ? awayPitcherRecent : homePitcherRecent;
  const winnerRolling = probHome >= 50 ? homeRolling : awayRolling;
  const loserRolling = probHome >= 50 ? awayRolling : homeRolling;

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
  const starterRecentEdgeValue = toNumber(modelBreakdown?.starterRecentEdge, 0);
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
      `SP season: ${winnerStarter?.fullName || winner.name} ERA ${safeFixed(winnerSpEra)}, WHIP ${safeFixed(winnerSpWhip)} vs ${loserStarter?.fullName || loser.name} ERA ${safeFixed(loserSpEra)}, WHIP ${safeFixed(loserSpWhip)}.`
    );
  }

  if (
    winnerRecent?.games >= 2 &&
    loserRecent?.games >= 2 &&
    (
      Math.abs(starterRecentEdgeValue) >= 0.08 ||
      toNumber(winnerRecent.era, 99) <= toNumber(loserRecent.era, 99) - 0.6 ||
      toNumber(winnerRecent.whip, 99) <= toNumber(loserRecent.whip, 99) - 0.15
    )
  ) {
    reasons.push(
      `SP recent (last ${winnerRecent.games}/${loserRecent.games}): ${winnerStarter?.fullName || winner.name} ERA ${safeFixed(winnerRecent.era)}, WHIP ${safeFixed(winnerRecent.whip)} vs ${loserStarter?.fullName || loser.name} ERA ${safeFixed(loserRecent.era)}, WHIP ${safeFixed(loserRecent.whip)}.`
    );
  }

  if (
    winnerRolling?.hitting &&
    loserRolling?.hitting &&
    toNumber(winnerRolling.games, 0) >= 8 &&
    toNumber(loserRolling.games, 0) >= 8
  ) {
    const wRpg = rpg(winnerRolling.hitting);
    const lRpg = rpg(loserRolling.hitting);
    const wOps = statOps(winnerRolling.hitting);
    const lOps = statOps(loserRolling.hitting);
    if (wRpg >= lRpg + 0.35 || wOps >= lOps + 0.04) {
      reasons.push(
        `L21 form: ${winner.name} ${safeFixed(wRpg, 2)} R/G, OPS ${safeFixed(wOps, 3)} (n=${winnerRolling.games}) vs ${loser.name} ${safeFixed(lRpg, 2)} R/G, OPS ${safeFixed(lOps, 3)} (n=${loserRolling.games}).`
      );
    }
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
  const windAdj = /\bout\b/i.test(windText)
    ? clamp(windSpeed * 0.025, 0, 0.4)
    : /\bin\b/i.test(windText)
      ? -clamp(windSpeed * 0.025, 0, 0.4)
      : 0;
  const roofMultiplier =
    weatherText.includes('roof closed') || weatherText.includes('closed roof') || weatherText.includes('dome')
      ? 0.2
      : 1;
  return clamp((tempAdj + windAdj) * roofMultiplier, -0.55, 0.55);
}

function parkFactorContext(venueId, venueName = null, homeTeamId = null) {
  const baseline = PARK_FACTOR_BASELINES.get(venueId) || PARK_FACTOR_BASELINES.get(homeTeamId) || {
    runFactor: 1,
    homeRunFactor: 1,
    label: venueName || 'Neutral park'
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

function mapHasBothTeams(map, game) {
  return Boolean(
    map?.has?.(game?.teams?.away?.team?.id) &&
      map?.has?.(game?.teams?.home?.team?.id)
  );
}

function teamStatProfiles(game, teamStats) {
  return [
    teamStats?.get?.(game?.teams?.away?.team?.id),
    teamStats?.get?.(game?.teams?.home?.team?.id)
  ];
}

function teamStatsHaveBothBasicFamilies(teamStats, game) {
  return teamStatProfiles(game, teamStats).every(
    (profile) => profile?.hitting && profile?.pitching
  );
}

function teamStatsHaveBothAdvancedFamilies(teamStats, game) {
  return teamStatProfiles(game, teamStats).every(
    (profile) => profile?.hittingAdvanced && profile?.pitchingAdvanced
  );
}

function featureFallbackSummary({
  game,
  teamStats,
  standings,
  pitcherStats,
  pitcherRecentStarts,
  bullpenProfiles,
  scheduleFatigueProfiles,
  injuryProfiles,
  rollingTeamStats,
  lineupProfiles,
  headToHead
}) {
  const features = [];
  const reasons = [];
  const criticalFeatures = [];
  const criticalReasons = [];
  const awayStarterId = game?.teams?.away?.probablePitcher?.id;
  const homeStarterId = game?.teams?.home?.probablePitcher?.id;
  const addFallback = (feature, reason, { critical = false } = {}) => {
    features.push(feature);
    reasons.push(reason);
    if (critical) {
      criticalFeatures.push(feature);
      criticalReasons.push(reason);
    }
  };

  if (!teamStatsHaveBothBasicFamilies(teamStats, game)) {
    addFallback('team_season_basic', 'missing_team_season_basic', { critical: true });
  }
  if (!teamStatsHaveBothAdvancedFamilies(teamStats, game)) {
    addFallback('team_season_advanced', 'missing_team_season_advanced');
  }
  if (!mapHasBothTeams(standings, game)) {
    addFallback('standings_and_splits', 'missing_standings', { critical: true });
  }
  if (!awayStarterId || !homeStarterId) {
    addFallback(
      'probable_starter_season',
      'missing_probable_starter_identity',
      { critical: true }
    );
  } else if (
    !pitcherStats?.get?.(awayStarterId) ||
    !pitcherStats?.get?.(homeStarterId)
  ) {
    addFallback(
      'probable_starter_season',
      'missing_probable_starter_stats',
      { critical: true }
    );
  }
  if (
    pitcherRecentStarts &&
    (!pitcherRecentStarts?.get?.(awayStarterId) ||
      !pitcherRecentStarts?.get?.(homeStarterId))
  ) {
    addFallback('probable_starter_recent', 'missing_probable_starter_recent');
  }
  if (!mapHasBothTeams(rollingTeamStats, game)) {
    addFallback('rolling_team_form', 'missing_rolling_team_form');
  }
  if (bullpenProfiles && !mapHasBothTeams(bullpenProfiles, game)) {
    addFallback('bullpen_fatigue', 'missing_bullpen_fatigue');
  }
  if (scheduleFatigueProfiles && !mapHasBothTeams(scheduleFatigueProfiles, game)) {
    addFallback('schedule_fatigue', 'missing_schedule_fatigue');
  }
  if (injuryProfiles && !mapHasBothTeams(injuryProfiles, game)) {
    addFallback('injuries', 'missing_injury_profiles');
  }
  if (!lineupProfiles?.away || !lineupProfiles?.home) {
    addFallback('lineup', 'missing_lineup');
  }
  if (!headToHead || !Number.isFinite(Number(headToHead.games))) {
    addFallback('head_to_head', 'missing_head_to_head');
  }

  const uniqueFeatures = [...new Set(features)];
  const uniqueCriticalFeatures = [...new Set(criticalFeatures)];
  return {
    count: uniqueFeatures.length,
    features: uniqueFeatures,
    reasons: [...new Set(reasons)],
    criticalCount: uniqueCriticalFeatures.length,
    criticalFeatures: uniqueCriticalFeatures,
    criticalReasons: [...new Set(criticalReasons)],
    optionalFeatures: uniqueFeatures.filter(
      (feature) => !uniqueCriticalFeatures.includes(feature)
    )
  };
}

function buildPredictionQuality({
  game,
  predictionTimestampUtc,
  featureFallbacks,
  calibrationArtifact = null
}) {
  const temporal = assertPregameEligible({
    asOf: predictionTimestampUtc,
    firstPitch: game?.gameDate || null
  });
  if (!temporal.ok) {
    return {
      status: 'INELIGIBLE_TEMPORAL',
      promotionEligible: false,
      reasons: [temporal.reason]
    };
  }

  const criticalReasons = [
    ...(featureFallbacks?.criticalReasons || featureFallbacks?.reasons || [])
  ];
  const qualityReasons = [];
  let calibrationEligible = true;
  if (calibrationArtifact && calibrationArtifact.promotionSafe === false) {
    qualityReasons.push(
      `calibration_${calibrationArtifact.integrityStatus || 'not_promotion_safe'}`
    );
    calibrationEligible = false;
  }
  if (criticalReasons.length > 0) {
    qualityReasons.push(...criticalReasons);
  }

  const degraded =
    (featureFallbacks?.count || 0) > 0 ||
    qualityReasons.length > 0;
  return {
    status: degraded ? 'DEGRADED' : 'OK',
    promotionEligible:
      criticalReasons.length === 0 && calibrationEligible,
    reasons: [...new Set(qualityReasons)],
    fallbackFeatures: [...(featureFallbacks?.features || [])]
  };
}

function buildFeatureAvailability({
  game,
  teamStats,
  standings,
  pitcherStats,
  pitcherRecentStarts,
  bullpenProfiles,
  scheduleFatigueProfiles,
  injuryProfiles,
  rollingTeamStats,
  lineupProfiles,
  headToHead,
  predictionTimestampUtc
}) {
  const awayStarterId = game?.teams?.away?.probablePitcher?.id;
  const homeStarterId = game?.teams?.home?.probablePitcher?.id;
  return {
    teamSeasonBasic: teamStatsHaveBothBasicFamilies(teamStats, game),
    teamSeasonAdvanced: teamStatsHaveBothAdvancedFamilies(teamStats, game),
    standings: mapHasBothTeams(standings, game),
    probableStarters: Boolean(
      awayStarterId &&
        homeStarterId &&
        pitcherStats?.get?.(awayStarterId) &&
        pitcherStats?.get?.(homeStarterId)
    ),
    probableStarterRecent: Boolean(
      pitcherRecentStarts &&
        awayStarterId &&
        homeStarterId &&
        pitcherRecentStarts?.get?.(awayStarterId) &&
        pitcherRecentStarts?.get?.(homeStarterId)
    ),
    rollingTeamForm: mapHasBothTeams(rollingTeamStats, game),
    bullpenFatigue: mapHasBothTeams(bullpenProfiles, game),
    scheduleFatigue: mapHasBothTeams(scheduleFatigueProfiles, game),
    injuries: mapHasBothTeams(injuryProfiles, game),
    lineup: Boolean(lineupProfiles?.away && lineupProfiles?.home),
    headToHead: Boolean(headToHead && Number.isFinite(Number(headToHead.games))),
    pregame: assertPregameEligible({
      asOf: predictionTimestampUtc,
      firstPitch: game?.gameDate || null
    }).ok
  };
}

function lineupWinEdge(homeLineup, awayLineup, homeInjuries, awayInjuries) {
  return coreLineupWinEdge(homeLineup, awayLineup, homeInjuries, awayInjuries);
}

// Both teams have publicly posted full nine-hitter lineups.
export function bothLineupsConfirmed(lineups) {
  const away = lineups?.away;
  const home = lineups?.home;
  return Boolean(
    away?.confirmed && home?.confirmed && (away?.count || 0) >= 9 && (home?.count || 0) >= 9
  );
}

function bullpenAvailabilityEdge(homeBullpen, awayBullpen, options = {}) {
  return coreBullpenAvailabilityEdge(homeBullpen, awayBullpen, options);
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
    const platoon = isFiniteNumber(lineup.platoonOps)
      ? ` | split OPS ${Number(lineup.platoonOps).toFixed(3)}`
      : '';
    const additions =
      Array.isArray(lineup.newAdditionsNames) && lineup.newAdditionsNames.length > 0
        ? ` | new: ${lineup.newAdditionsNames.join(', ')}`
        : '';
    return `${label}: confirmed ${lineup.count}/9${top}${platoon}${additions}`;
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
  injuryProfiles,
  lineupProfiles,
  modelMemory,
  rollingTeamStats = new Map(),
  predictionTimestampUtc = null,
  rosterProfiles = null
) {
  // All deterministic probability math lives in the pure canonical core
  // (src/core/prediction_core.js). This wrapper injects the externally-sourced
  // inputs the pure core is forbidden from reading itself: evolution controls
  // (filesystem), the calibration function (artifact), park factor baselines,
  // and the wall-clock `now` used only for prediction tiering.
  const evolutionControls = loadEvolutionControls();
  const decisionTimestampUtc = predictionTimestampUtc || new Date().toISOString();
  const core = predictGameMoneylineCore({
    game,
    teamStats,
    standings,
    pitcherStats,
    pitcherDetails,
    pitcherRecentStarts,
    bullpenProfiles,
    scheduleFatigueProfiles,
    headToHead,
    injuryProfiles,
    rosterProfiles,
    lineupProfiles,
    modelMemory,
    rollingTeamStats,
    evolutionControls,
    calibratePercent,
    parkFactorBaselines: PARK_FACTOR_BASELINES,
    nowMs: decisionTimestampUtc,
    moneylineWeightMultiplierFn: moneylineWeightMultiplier,
    defaultBullpenProfileFn: (teamId) =>
      finalizeBullpenProfile({
        teamId,
        games: 0,
        bullpenPitches: 0,
        bullpenOuts: 0,
        relieverAppearances: 0,
        relieverDates: new Map(),
        highPitchRelievers: 0
      })
  });

  const {
    awayTeam,
    homeTeam,
    awayProfile,
    homeProfile,
    awayRolling,
    homeRolling,
    awayStanding,
    homeStanding,
    awayStarter,
    homeStarter,
    awayOpenerSituation,
    homeOpenerSituation,
    effectiveAwayPitcherStats,
    effectiveHomePitcherStats,
    awayPitcherStats,
    homePitcherStats,
    awayPitcherRecent,
    homePitcherRecent,
    awayBullpen,
    homeBullpen,
    awayScheduleFatigue,
    homeScheduleFatigue,
    awayPitcherRest,
    homePitcherRest,
    awayInjuries,
    homeInjuries,
    awayLineup,
    homeLineup,
    matchupMemory,
    awayPythagoreanPct,
    homePythagoreanPct,
    homeSeasonLog5,
    homePythagoreanLog5,
    homeRecentLog5,
    homeReferenceBlend,
    awayMemoryBias,
    homeMemoryBias,
    fatigueEdge,
    offenseBlend,
    starterWeightMultiplier,
    spRecentEdgeRaw,
    bothConfirmed,
    confirmationEdge,
    confirmationSignal,
    expectedRuns,
    modelBreakdown
  } = core;
  const homeProbability = core.calibrated.homeProbability;
  const awayProbability = core.calibrated.awayProbability;
  const rawHomeProbability = core.raw.homeProbability;
  const rawAwayProbability = core.raw.awayProbability;
  const gameDateYmd = core.gameDateYmd;

  modelBreakdown.sharpMoney = detectSharpMoneySignal(
    homeProbability >= awayProbability ? homeTeam.name : awayTeam.name,
    null,
    null
  );
  modelBreakdown.modelId = HEURISTIC_V1_MODEL_ID;
  modelBreakdown.modelVersion = PREDICTION_CORE_MODEL_VERSION;
  modelBreakdown.modelImplVersion = PREDICTION_CORE_MODEL_VERSION;
  modelBreakdown.featureSchemaVersion = CONTROL_FEATURE_SCHEMA_VERSION;

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
    rawBaseballProbability: rawHomeProbability,
    pureModelProbability: homeProbability,
    marketInformedProbability: null,
    displayProbability: homeProbability,
    valueModelProbability: homeProbability
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
    rawBaseballProbability: rawAwayProbability,
    pureModelProbability: awayProbability,
    marketInformedProbability: null,
    displayProbability: awayProbability,
    valueModelProbability: awayProbability
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
    homePitcherRecent,
    awayPitcherRecent,
    homeRolling,
    awayRolling,
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
  const awayPitcherRecentLine = awayOpenerSituation.isOpener
    ? 'Bulk pitcher TBD'
    : awayPitcherRecent?.line || 'recent starts unavailable';
  const homePitcherRecentLine = homeOpenerSituation.isOpener
    ? 'Bulk pitcher TBD'
    : homePitcherRecent?.line || 'recent starts unavailable';

  return {
    gamePk: game.gamePk,
    modelId: HEURISTIC_V1_MODEL_ID,
    modelVersion: PREDICTION_CORE_MODEL_VERSION,
    modelImplVersion: PREDICTION_CORE_MODEL_VERSION,
    featureVersion: CONTROL_FEATURE_SCHEMA_VERSION,
    featureSchemaVersion: CONTROL_FEATURE_SCHEMA_VERSION,
    featureRoleVersion: CONTROL_FEATURE_ROLE_VERSION,
    featureRoles: CONTROL_FEATURE_ROLES,
    status: game.status?.detailedState || 'Scheduled',
    start: formatGameTime(game.gameDate, MLB_TIMEZONE),
    startTime: game.gameDate || null,
    venue: game.venue?.name || 'TBD',
    // Surface the raw weather payload and computed park-factor context so the
    // dashboard quality report can honestly reflect which inputs were present
    // (previously it read weather_detail/park_detail, fields that never existed).
    weather: game.weather || null,
    parkFactor: parkFactorContext(game.venue?.id, game.venue?.name, home?.id),
    away,
    home,
    contextLine: `${standingContext(away, awayStanding, 'away')} | ${standingContext(home, homeStanding, 'home')}`,
    advancedLine: `${advancedContext(away, awayProfile)} | ${advancedContext(home, homeProfile)}`,
    matchupSplitLine: `${matchupSplitLine(away, awayStanding, homeStarter, 'away')} | ${matchupSplitLine(home, homeStanding, awayStarter, 'home')}`,
    pitcherRecentLine: `${away.abbreviation || away.name} SP ${awayPitcherRecentLine} | ${home.abbreviation || home.name} SP ${homePitcherRecentLine}`,
    rollingFormLine: `${rollingFormLine(away, awayRolling)} | ${rollingFormLine(home, homeRolling)}`,
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
    rollingForm: {
      away: awayRolling,
      home: homeRolling,
      windowDays: ROLLING_FORM_DAYS
    },
    modelReferenceLine: modelReferenceLines.join(' | '),
    modelReferenceLines,
    modelBreakdownLine: [
      edgeComponentText('matchup', modelBreakdown.matchupEdge, away, home),
      edgeComponentText('record/H2H', modelBreakdown.recordContextEdge, away, home),
      edgeComponentText('SP', modelBreakdown.starterEdge, away, home),
      Math.abs(spRecentEdgeRaw) >= 0.04
        ? edgeComponentText('SP recent', spRecentEdgeRaw * 0.42 * starterWeightMultiplier, away, home)
        : null,
      offenseBlend.rollingWeight >= 0.15
        ? edgeComponentText('L21 form', offenseBlend.rollingEdge * 0.32, away, home)
        : null,
      edgeComponentText('lineup', modelBreakdown.lineupEdge, away, home),
      edgeComponentText('bullpen', modelBreakdown.bullpenEdge, away, home),
      expectedRuns
        ? `xR ${away.abbreviation || away.name} ${expectedRuns.awayLambda.toFixed(2)} - ${home.abbreviation || home.name} ${expectedRuns.homeLambda.toFixed(2)} (Skellam ${expectedRuns.skellamHomeProbability.toFixed(1)}%)`
        : null,
      bothConfirmed && confirmationSignal > 0
        ? `lineup✓ ${Math.round(confirmationSignal * 100)}%`
        : bothConfirmed && Math.abs(confirmationEdge) >= 0.005
          ? edgeComponentText('lineup✓', confirmationEdge, away, home)
          : null
    ].filter(Boolean).join(' | '),
    expectedRuns,
    confirmationSignal,
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
    winner: homeProbability >= awayProbability ? home : away,
    reasons
  };
}

export const __mlbTestInternals = {
  actualStarterForSide,
  aggregateDateRange,
  americanToContinuousCents,
  starterEdge,
  starterRecentEdge,
  starterSeasonEdge,
  shrinkPitcherStats,
  guardFavoredCalibrationPercent,
  lineupWinEdge,
  bullpenAvailabilityEdge,
  blendHitterSeasonStats,
  hitterLineupScore,
  extractLineupProfile,
  finalizeBullpenProfile,
  summarizeBullpenLeverage,
  finalizeScheduleFatigueProfile,
  parseRosterAndTransactions,
  blendTeamStatsWithPrior,
  blendStandingsWithPrior,
  combinePitcherStatSplits,
  blendedTeamOffenseEdge,
  blendedTeamPreventionEdge,
  rollingFormWindow,
  teamStatBlockKind,
  getTeamStatMap,
  mergeTeamStatMaps,
  getRollingTeamStatMap,
  summarizeHeadToHeadGames,
  lineupTemporalEligibility,
  parkFactorContext,
  featureFallbackSummary,
  buildPredictionQuality,
  buildFeatureAvailability,
  moneylineOddsAgeMinutes,
  moneylineOddsFreshnessReason,
  determinePredictionTier,
  filterSplitsBeforeDate,
  devigMoneylinePercent,
  moneylineBooksAreSame,
  moneylineValueOption,
  MARKET_BLEND_WEIGHT,
  ROLLING_FORM_DAYS
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
  const collectorProvenance = {};
  const profileFetch = async (label, source, fn, fallbackValue = () => new Map()) => {
    const fetchStart = new Date().toISOString();
    try {
      const result = await fn();
      const sampleSize =
        result instanceof Map
          ? result.size
          : result?.injuries instanceof Map
            ? result.injuries.size
            : result?.teams && typeof result.teams === 'object'
              ? Object.keys(result.teams).length
              : Array.isArray(result)
                ? result.length
                : null;
      collectorProvenance[label] = {
        source,
        fetchStart,
        fetchEnd: new Date().toISOString(),
        status: 'ok',
        sampleSize,
        failureReason: null
      };
      return result;
    } catch (error) {
      console.warn(`getMlbPredictions: ${label} fetch failed, using empty data:`, error.message);
      collectorProvenance[label] = {
        source,
        fetchStart,
        fetchEnd: new Date().toISOString(),
        status: 'fetch_failed',
        sampleSize: 0,
        failureReason: error?.message || String(error || 'unknown_error')
      };
      return fallbackValue();
    }
  };
  const requestedCutoff = aggregateDateRange(season, dateYmd)?.endDate || null;
  const statcastCfg = loadConfig().statcast || { enabled: true, timeoutMs: 6000, cacheTtlMs: 10800000 };
  const [
    rawTeamStats,
    rollingTeamStats,
    rawStandings,
    bullpenProfiles,
    scheduleFatigueProfiles,
    rosterAndInjuryBundle,
    statcastBundle
  ] = await Promise.all([
    profileFetch('teamStats', 'MLB StatsAPI byDateRange+byDateRangeAdvanced', () => fetchTeamStats(season, dateYmd)),
    profileFetch('rollingTeamStats', 'MLB StatsAPI byDateRange', () => fetchRollingTeamStats(season, dateYmd)),
    profileFetch('standings', 'MLB StatsAPI standings', () => fetchStandings(season, dateYmd)),
    profileFetch('bullpenProfiles', 'MLB StatsAPI schedule+boxscore (14d quality + 3d fatigue + leverage)', () =>
      fetchBullpenProfiles(teamIds, dateYmd)
    ),
    profileFetch('scheduleFatigueProfiles', 'MLB StatsAPI schedule', () =>
      fetchScheduleFatigueProfiles(teamIds, dateYmd, games)
    ),
    profileFetch(
      'injuryProfiles',
      'MLB StatsAPI 40Man roster + offseason/in-season transactions',
      () => fetchRosterAndInjuryProfiles(teamIds, dateYmd, season),
      () => ({ injuries: new Map(), rosters: new Map() })
    ),
    statcastCfg.enabled
      ? profileFetch(
          'statcast',
          'Baseball Savant CSV leaderboards (team xwOBA/Barrel% + pitcher xERA)',
          () =>
            fetchLiveStatcastBundle(season, {
              timeoutMs: statcastCfg.timeoutMs,
              cacheTtlMs: statcastCfg.cacheTtlMs
            }),
          () => ({ teams: {}, pitchers: {} })
        )
      : Promise.resolve({ teams: {}, pitchers: {} })
  ]);

  const injuryProfiles = rosterAndInjuryBundle?.injuries || new Map();
  const rosterProfiles = rosterAndInjuryBundle?.rosters || new Map();

  // Early-season continuity: when any active club has < 35 games played in the
  // new season, pull completed `season - 1` baselines and blend inversely with
  // offseason/in-season roster turnover (`turnoverScore`).
  const needsPriorTeamBlend =
    collectorProvenance.teamStats?.status !== 'fetch_failed' &&
    teamIds.some((teamId) => toNumber(rawTeamStats.get(teamId)?.hitting?.gamesPlayed, 0) < 35);
  const needsPriorStandingsBlend =
    collectorProvenance.standings?.status !== 'fetch_failed' &&
    teamIds.some((teamId) => toNumber(rawStandings.get(teamId)?.gamesPlayed, 0) < 30);
  const [priorTeamStats, priorStandings] = await Promise.all([
    needsPriorTeamBlend ? fetchTeamStats(season - 1, null).catch(() => new Map()) : Promise.resolve(new Map()),
    needsPriorStandingsBlend ? fetchStandings(season - 1, null).catch(() => new Map()) : Promise.resolve(new Map())
  ]);
  const teamStats = needsPriorTeamBlend
    ? blendTeamStatsWithPrior(rawTeamStats, priorTeamStats, rosterProfiles, teamIds)
    : rawTeamStats;
  const standings = needsPriorStandingsBlend
    ? blendStandingsWithPrior(rawStandings, priorStandings, rosterProfiles, teamIds)
    : rawStandings;

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
  const pitcherFetchStart = new Date().toISOString();
  let pitcherStatsOk = 0;
  let pitcherStatsFailed = 0;
  let pitcherRecentOk = 0;
  let pitcherRecentFailed = 0;
  await Promise.all(
    probablePitcherIds.map(async (personId) => {
      try {
        pitcherDetails.set(personId, await fetchPerson(personId));
      } catch {
        pitcherDetails.set(personId, null);
      }

      try {
        pitcherStats.set(personId, await fetchPitcherStatsWithPrior(personId, season, dateYmd));
        pitcherStatsOk += 1;
      } catch {
        pitcherStats.set(personId, null);
        pitcherStatsFailed += 1;
      }

      try {
        pitcherRecentStarts.set(
          personId,
          await fetchPitcherRecentStarts(personId, season, 5, dateYmd)
        );
        pitcherRecentOk += 1;
      } catch {
        pitcherRecentStarts.set(personId, null);
        pitcherRecentFailed += 1;
      }
    })
  );
  collectorProvenance.pitcherStats = {
    source: 'MLB StatsAPI person stats (current + prior-season shrinkage)',
    fetchStart: pitcherFetchStart,
    fetchEnd: new Date().toISOString(),
    status: pitcherStatsFailed === 0 ? 'ok' : pitcherStatsOk === 0 ? 'fetch_failed' : 'partial',
    sampleSize: pitcherStatsOk,
    failureReason: pitcherStatsFailed > 0 ? `${pitcherStatsFailed}/${probablePitcherIds.length} pitcher stat fetches failed` : null
  };
  collectorProvenance.pitcherRecentStarts = {
    source: 'MLB StatsAPI gameLog',
    fetchStart: pitcherFetchStart,
    fetchEnd: new Date().toISOString(),
    status: pitcherRecentFailed === 0 ? 'ok' : pitcherRecentOk === 0 ? 'fetch_failed' : 'partial',
    sampleSize: pitcherRecentOk,
    failureReason: pitcherRecentFailed > 0 ? `${pitcherRecentFailed}/${probablePitcherIds.length} recent-start fetches failed` : null
  };

  const headToHeadStats = new Map();
  const h2hFetchStart = new Date().toISOString();
  let h2hOk = 0;
  let h2hFailed = 0;
  await Promise.all(
    games.map(async (game) => {
      try {
        headToHeadStats.set(game.gamePk, await fetchHeadToHead(game, season, dateYmd));
        h2hOk += 1;
      } catch {
        h2hFailed += 1;
        headToHeadStats.set(game.gamePk, {
          games: 0,
          awayWins: 0,
          homeWins: 0,
          awayProbability: 50,
          homeProbability: 50
        });
      }
    })
  );
  collectorProvenance.headToHead = {
    source: 'MLB StatsAPI schedule (head-to-head)',
    fetchStart: h2hFetchStart,
    fetchEnd: new Date().toISOString(),
    status: h2hFailed === 0 ? 'ok' : h2hOk === 0 ? 'fetch_failed' : 'partial',
    sampleSize: h2hOk,
    failureReason: h2hFailed > 0 ? `${h2hFailed}/${games.length} head-to-head fetches failed` : null
  };

  const lineupProfiles = new Map();
  const lineupRequestTimestampUtc = new Date().toISOString();
  const hitterCache = new Map();
  const platoonCache = new Map();
  let lineupOk = 0;
  let lineupFailed = 0;
  await Promise.all(
    games.map(async (game) => {
      try {
        lineupProfiles.set(
          game.gamePk,
          await fetchGameLineupProfile(game, lineupRequestTimestampUtc, {
            season,
            dateYmd,
            hitterCache,
            platoonCache,
            pitcherDetails,
            rosterProfiles
          })
        );
        lineupOk += 1;
      } catch {
        lineupFailed += 1;
        lineupProfiles.set(game.gamePk, {
          away: null,
          home: null,
          requestedAtUtc: lineupRequestTimestampUtc,
          fetchedAtUtc: null,
          temporal: lineupTemporalEligibility(game, lineupRequestTimestampUtc)
        });
      }
    })
  );
  collectorProvenance.lineup = {
    source: 'MLB StatsAPI boxscore + hitter prior/trade/platoon enrichment',
    fetchStart: lineupRequestTimestampUtc,
    fetchEnd: new Date().toISOString(),
    status: lineupFailed === 0 ? 'ok' : lineupOk === 0 ? 'fetch_failed' : 'partial',
    sampleSize: lineupOk,
    failureReason: lineupFailed > 0 ? `${lineupFailed}/${games.length} lineup fetches failed` : null
  };

  const calibrationArtifact = getCalibrationArtifact('moneyline');
  return games.map((game) => {
    const predictionTimestampUtc = new Date().toISOString();
    const lineupProfile = lineupProfiles.get(game.gamePk) || {
      away: null,
      home: null,
      requestedAtUtc: lineupRequestTimestampUtc,
      fetchedAtUtc: null,
      temporal: lineupTemporalEligibility(game, predictionTimestampUtc)
    };
    const controlLineupProfile = {
      away: lineupProfile.away || null,
      home: lineupProfile.home || null
    };
    const headToHead = headToHeadStats.get(game.gamePk);
    const awayTeamId = game.teams.away.team.id;
    const homeTeamId = game.teams.home.team.id;
    const prediction = predictGame(
      game,
      teamStats,
      standings,
      pitcherStats,
      pitcherDetails,
      pitcherRecentStarts,
      bullpenProfiles,
      scheduleFatigueProfiles,
      headToHead,
      injuryProfiles,
      controlLineupProfile,
      modelMemory,
      rollingTeamStats,
      predictionTimestampUtc,
      rosterProfiles
    );
    prediction.dateYmd = game.officialDate || dateYmd;
    prediction.rosterContext = {
      away: rosterProfiles.get(awayTeamId) || null,
      home: rosterProfiles.get(homeTeamId) || null
    };
    const gameStatcast = sliceGameStatcast(statcastBundle, {
      awayTeamId,
      homeTeamId,
      awayPitcherId: game.teams.away.probablePitcher?.id ?? null,
      homePitcherId: game.teams.home.probablePitcher?.id ?? null
    });
    // Freeze the raw core inputs so this live prediction can be recomputed by
    // snapshot replay (not just projected). Plain JSON; Maps serialized.
    prediction.coreInputs = buildCoreInputsSnapshot({
      game,
      teamStats,
      standings,
      pitcherStats,
      pitcherDetails,
      pitcherRecentStarts,
      bullpenProfiles,
      scheduleFatigueProfiles,
      headToHead,
      injuryProfiles,
      rosterProfiles,
      lineupProfiles: controlLineupProfile,
      modelMemory,
      rollingTeamStats,
      evolutionControls: loadEvolutionControls(),
      parkFactorBaselines: PARK_FACTOR_BASELINES,
      statcast: gameStatcast
    });
    prediction.predictionTimestampUtc = predictionTimestampUtc;
    prediction.asOfUtc = predictionTimestampUtc;
    prediction.featureAvailability = buildFeatureAvailability({
      game,
      teamStats,
      standings,
      pitcherStats,
      pitcherRecentStarts,
      bullpenProfiles,
      scheduleFatigueProfiles,
      injuryProfiles,
      rollingTeamStats,
      lineupProfiles: controlLineupProfile,
      headToHead,
      predictionTimestampUtc
    });
    prediction.featureFallbacks = featureFallbackSummary({
      game,
      teamStats,
      standings,
      pitcherStats,
      pitcherRecentStarts,
      bullpenProfiles,
      scheduleFatigueProfiles,
      injuryProfiles,
      rollingTeamStats,
      lineupProfiles: controlLineupProfile,
      headToHead
    });
    prediction.calibrationArtifact = calibrationArtifact;
    prediction.calibrationVersion = calibrationArtifact.calibrationVersion;
    prediction.predictionQuality = buildPredictionQuality({
      game,
      predictionTimestampUtc,
      featureFallbacks: prediction.featureFallbacks,
      calibrationArtifact
    });
    // Cross-reference critical-family fallbacks against collector provenance so
    // a transient API failure (fetch_failed) is distinguishable from genuine
    // missing data (valid_empty). Both degrade quality, but only the former is
    // retriable. Emit one structured warning per failed critical collector.
    const criticalCollectorByFamily = {
      team_season_basic: 'teamStats',
      standings_and_splits: 'standings',
      probable_starter_season: 'pitcherStats'
    };
    const fallbackFeatures = prediction.featureFallbacks?.features || [];
    const criticalFetchFailures = [];
    for (const [family, collector] of Object.entries(criticalCollectorByFamily)) {
      const provenance = collectorProvenance[collector];
      if (
        provenance &&
        provenance.status === 'fetch_failed' &&
        fallbackFeatures.includes(family)
      ) {
        criticalFetchFailures.push({
          family,
          collector,
          reason: provenance.failureReason
        });
      }
    }
    if (criticalFetchFailures.length > 0) {
      prediction.predictionQuality.criticalFetchFailures = criticalFetchFailures;
      // Surface in logs so a degraded slate is traceable to a specific API
      // failure rather than silent defaulting.
      console.warn(
        `getMlbPredictions: critical fetch failures for game ${game.gamePk}:`,
        JSON.stringify(criticalFetchFailures)
      );
    }
    prediction.featureProvenance = {
      source: 'MLB StatsAPI',
      requestedCutoff,
      lineupRequestedAt: lineupProfile.requestedAtUtc || lineupRequestTimestampUtc,
      lineupFetchedAt: lineupProfile.fetchedAtUtc || null,
      lineupTemporalStatus: lineupProfile.temporal || null,
      fetchedAt: predictionTimestampUtc,
      collectors: collectorProvenance
    };
    return prediction;
  });
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
  { maxGames = 8, teamFilter = '', includeAdvanced = true, includeNews = false } = {}
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
    const newsLines = includeNews
      ? (item.newsContext?.articles || []).slice(0, 2).map((article) => {
          const published = article.publishedAt
            ? new Date(article.publishedAt).toISOString().slice(0, 16).replace('T', ' ')
            : 'waktu tidak tersedia';
          return uiBullet('•', `[${article.sourceName}] ${article.title} | ${published} UTC`);
        })
      : [];
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
        // Always surface news risk flags when present (veto support), even if
        // full news section is off. Probability impact remains none.
        ...((item.newsContext?.newsRisk?.flags || []).length
          ? [
              uiSection('📰', 'News Risk'),
              ...item.newsContext.newsRisk.flags.slice(0, 4).map((f) =>
                uiBullet('•', `[${f.severity}] ${f.flag}${f.title ? `: ${f.title}` : ''}`)
              ),
              item.newsContext.newsRisk.veto
                ? uiKV('🛑', 'Veto', (item.newsContext.newsRisk.vetoReasons || []).join(' | '))
                : null,
              ''
            ]
          : []),
        ...(includeNews
          ? [
              uiSection('📰', 'External News'),
              ...(newsLines.length
                ? newsLines
                : [uiBullet('•', `Tidak ada artikel cocok (${item.newsContext?.status || 'unavailable'}).`)]),
              ''
            ]
          : []),
        ...(playerImpactLines(item).length
          ? [uiSection('🧩', 'Player Impact'), ...playerImpactLines(item), '']
          : []),
        uiSection('📈', 'SP Recent'),
        ...pitcherRecentLines,
        item.rollingFormLine ? '' : null,
        item.rollingFormLine ? uiSection('📉', 'Rolling L21') : null,
        ...(item.rollingFormLine ? splitInfoLine(item.rollingFormLine) : []),
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
