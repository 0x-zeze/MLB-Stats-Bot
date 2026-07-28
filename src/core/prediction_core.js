/**
 * Canonical pure production prediction core (moneyline).
 *
 * This module is extracted from src/mlb.js `predictGame` so the exact same
 * deterministic calculation can run in three places without divergence:
 *
 *   1. live predictions (src/mlb.js predictGame wrapper),
 *   2. snapshot replay (src/prediction_replay.js),
 *   3. offline evaluation / tests.
 *
 * Purity contract — this module MUST NOT:
 *   - perform HTTP requests,
 *   - read or write the filesystem,
 *   - read `Date.now()` / `new Date()` for the current time,
 *   - read environment variables,
 *   - touch a database,
 *   - mutate its inputs,
 *   - depend on global mutable state.
 *
 * Every externally-sourced input (evolution controls, calibration function,
 * wall-clock for tiering) is injected as a plain argument. Given identical
 * inputs the output is deterministic.
 *
 * Probability stages are exposed separately so the full pipeline is auditable:
 *   raw edge -> dampened edge -> sigmoid -> raw probability -> calibrated
 *   probability. Calibration is the FINAL probability transform; downstream
 *   market/edge/stake logic must consume only the calibrated value.
 */

import { clamp, sigmoid, toNumber } from '../utils.js';

export const PREDICTION_CORE_MODEL_VERSION = 'moneyline-core-v1.0';

// League-average fallbacks (mirrors DEFAULTS in mlb.js). Kept local so the
// core carries no import from the network-bound module.
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

// Situational weight adjustment baselines (mirrors mlb.js).
const BASE_WEIGHTS = {
  offense: 0.30,
  starting_pitcher: 0.38,
  bullpen: 0.90,
  recent_form: 0.28,
  home_advantage: 1.0
};
const MAX_WEIGHT_SHIFT = 0.15;

// Edge dampening: the model is systematically overconfident at higher edges.
// (Analysis of 773 moneyline outcomes + 59 staked bets; see mlb.js history.)
const DAMPEN_LOW = 0.65;
const DAMPEN_MID = 0.50;
const DAMPEN_HIGH = 0.38;

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

// ---------------------------------------------------------------------------
// small pure stat helpers
// ---------------------------------------------------------------------------

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

function leagueRecordPct(record) {
  if (!record) return DEFAULTS.winPct;
  if (record.pct !== undefined) return toNumber(record.pct, DEFAULTS.winPct);
  const wins = toNumber(record.wins, 0);
  const losses = toNumber(record.losses, 0);
  const total = wins + losses;
  return total > 0 ? wins / total : DEFAULTS.winPct;
}

function splitRecord(standing, type) {
  return standing?.records?.splitRecords?.find((record) => record.type === type) || null;
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

// ---------------------------------------------------------------------------
// date helpers (pure: operate only on passed date strings, never wall-clock)
// ---------------------------------------------------------------------------

function ymdDiff(laterYmd, earlierYmd) {
  const later = new Date(`${laterYmd}T00:00:00Z`);
  const earlier = new Date(`${earlierYmd}T00:00:00Z`);
  return Math.round((later.getTime() - earlier.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// opener detection (pure)
// ---------------------------------------------------------------------------

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

export function detectOpenerSituation(game, side, pitcher, stats) {
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

// ---------------------------------------------------------------------------
// schedule / fatigue / rest (pure)
// ---------------------------------------------------------------------------

export function finalizeScheduleFatigueProfile(teamId, games, dateYmd) {
  const sorted = [...(games || [])].sort((left, right) =>
    String(right.date).localeCompare(String(left.date))
  );
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

export function pitcherRestProfile(pitcher, recentStarts, dateYmd) {
  if (!pitcher) {
    return { pitcher: 'TBD', restDays: null, multiplier: 1, flag: 'SP rest unavailable' };
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
  return { pitcher: pitcher.fullName, restDays, multiplier, flag: label };
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

// ---------------------------------------------------------------------------
// team offense / prevention blend (pure)
// ---------------------------------------------------------------------------

export function blendedTeamOffenseEdge(seasonHome, seasonAway, rollingHome, rollingAway) {
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

export function blendedTeamPreventionEdge(seasonHome, seasonAway, rollingHome, rollingAway) {
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
    (toNumber(homePitch.homeRunsPer9, DEFAULTS.hr9) - toNumber(awayPitch.homeRunsPer9, DEFAULTS.hr9)) / 1.2 +
    (toNumber(homePitch.strikeoutWalkRatio, 2.2) - toNumber(awayPitch.strikeoutWalkRatio, 2.2)) / 4.0;
  const sample = Math.min(homeGames, awayGames);
  const rollingWeight = clamp((sample - 7) / 12, 0, 0.4);
  return {
    edge: seasonEdge * (1 - rollingWeight) + rollingEdge * rollingWeight,
    rollingWeight,
    rollingEdge
  };
}

// ---------------------------------------------------------------------------
// starter edges (pure)
// ---------------------------------------------------------------------------

export function starterSeasonEdge(homePitcherStats, awayPitcherStats) {
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

export function starterRecentEdge(homeRecent, awayRecent) {
  const homeIp = toNumber(homeRecent?.innings, 0);
  const awayIp = toNumber(awayRecent?.innings, 0);
  if (homeIp < 6 || awayIp < 6) return 0;
  const homeEra = toNumber(homeRecent.era, DEFAULTS.era);
  const awayEra = toNumber(awayRecent.era, DEFAULTS.era);
  const homeWhip = toNumber(homeRecent.whip, DEFAULTS.whip);
  const awayWhip = toNumber(awayRecent.whip, DEFAULTS.whip);
  const homeKbb = toNumber(homeRecent.strikeouts, 0) / Math.max(1, toNumber(homeRecent.walks, 0));
  const awayKbb = toNumber(awayRecent.strikeouts, 0) / Math.max(1, toNumber(awayRecent.walks, 0));
  const homeHr9 = homeIp > 0 ? (toNumber(homeRecent.homeRuns, 0) * 9) / homeIp : DEFAULTS.hr9;
  const awayHr9 = awayIp > 0 ? (toNumber(awayRecent.homeRuns, 0) * 9) / awayIp : DEFAULTS.hr9;
  const raw =
    (awayEra - homeEra) / 2.6 +
    (awayWhip - homeWhip) / 0.65 +
    (homeKbb - awayKbb) / 4.5 +
    (awayHr9 - homeHr9) / 1.2;
  const sampleWeight = clamp(Math.min(homeIp, awayIp) / 18, 0.35, 1);
  return clamp(raw * sampleWeight, -1.2, 1.2);
}

export function starterEdge(homePitcherStats, awayPitcherStats, homeRecent = null, awayRecent = null) {
  const season = starterSeasonEdge(homePitcherStats, awayPitcherStats);
  const recent = starterRecentEdge(homeRecent, awayRecent);
  if (!homePitcherStats && !awayPitcherStats && recent === 0) return 0;
  if (recent === 0) return season;
  return clamp(season * 0.55 + recent * 0.45, -1.6, 1.6);
}

// ---------------------------------------------------------------------------
// lineup / bullpen / weather / park (pure)
// ---------------------------------------------------------------------------

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

export function lineupWinEdge(homeLineup, awayLineup, homeInjuries, awayInjuries) {
  const homeQuality = toNumber(homeLineup?.qualityScore, 0);
  const awayQuality = toNumber(awayLineup?.qualityScore, 0);
  const homeAvailability = lineupRunAdjustment(homeLineup, homeInjuries);
  const awayAvailability = lineupRunAdjustment(awayLineup, awayInjuries);
  return clamp(homeQuality - awayQuality + (homeAvailability - awayAvailability) * 0.45, -0.18, 0.18);
}

export function bothLineupsConfirmed(lineups) {
  const away = lineups?.away;
  const home = lineups?.home;
  return Boolean(
    away?.confirmed && home?.confirmed && (away?.count || 0) >= 9 && (home?.count || 0) >= 9
  );
}

export function bullpenAvailabilityEdge(homeBullpen, awayBullpen) {
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

function parseWeatherNumber(value) {
  const parsed = String(value || '').match(/-?\d+(\.\d+)?/);
  return parsed ? Number.parseFloat(parsed[0]) : null;
}

export function weatherRunAdjustment(weather) {
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

// ---------------------------------------------------------------------------
// memory / matchup (pure)
// ---------------------------------------------------------------------------

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

export function buildMatchupMemoryContext(modelMemory, awayTeam, homeTeam) {
  const key = matchupMemoryKey(awayTeam.id, homeTeam.id);
  const entry = modelMemory?.matchupMemory?.[key];
  if (!entry) {
    return { key, games: 0, edge: 0, note: 'Belum ada matchup memory tersimpan.', recentGames: [] };
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

// ---------------------------------------------------------------------------
// situational weights (pure; park factors injected)
// ---------------------------------------------------------------------------

function situationalWeightAdjustment(parkFactorBaselines, venueId, openerDetected, gameDateYmd) {
  const parkInfo = parkFactorBaselines?.get ? parkFactorBaselines.get(venueId) : null;
  const runFactor = parkInfo ? parkInfo.runFactor : 1.0;
  const parkType = runFactor >= 1.05 ? 'hitter_park' : runFactor <= 0.95 ? 'pitcher_park' : 'neutral';
  const month = gameDateYmd ? parseInt(String(gameDateYmd).slice(5, 7), 10) : 6;
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

// ---------------------------------------------------------------------------
// prediction tier (pure; `now` injected, never wall-clock)
// ---------------------------------------------------------------------------

export function determinePredictionTier(gameStartTime, now) {
  if (!gameStartTime) return { tier: 'standard', label: 'Standard', confidenceCap: 85 };
  const current = now instanceof Date ? now : new Date(now);
  const start = new Date(gameStartTime);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(current.getTime())) {
    return { tier: 'standard', label: 'Standard', confidenceCap: 85 };
  }
  const hoursToGame = (start - current) / 3600000;
  if (hoursToGame < 0) {
    return { tier: 'in_play', label: 'In Play', confidenceCap: 0, reject: true };
  }
  if (hoursToGame >= 6) return { tier: 'early_preview', label: 'Early Preview', confidenceCap: 60 };
  if (hoursToGame >= 2) return { tier: 'standard', label: 'Standard', confidenceCap: 85 };
  return { tier: 'final', label: 'Final Prediction', confidenceCap: 95 };
}

// ---------------------------------------------------------------------------
// canonical pure core
// ---------------------------------------------------------------------------

/**
 * Compute the deterministic moneyline probability pipeline for one game.
 *
 * @param {object} input
 * @param {object} input.game  MLB schedule game object (teams, venue, weather, status).
 * @param {Map|object} input.teamStats  season team profiles keyed by team id.
 * @param {Map|object} input.standings  standings keyed by team id.
 * @param {Map|object} input.pitcherStats  season pitcher stats keyed by person id.
 * @param {Map|object} input.pitcherDetails  pitcher detail (handedness) keyed by id.
 * @param {Map|object} input.pitcherRecentStarts  recent-start summaries keyed by id.
 * @param {Map|object} input.bullpenProfiles  bullpen profiles keyed by team id.
 * @param {Map|object} input.scheduleFatigueProfiles  fatigue keyed by team id.
 * @param {object} input.headToHead  head-to-head summary for this matchup.
 * @param {object} input.injuryProfiles  Map keyed by team id -> injury array.
 * @param {object} input.lineupProfiles  { away, home } lineup summaries.
 * @param {object} input.modelMemory  evolution matchup/team memory (injected).
 * @param {Map|object} input.rollingTeamStats  rolling form keyed by team id.
 * @param {object} input.evolutionControls  injected controls (weights/version).
 * @param {Function} input.calibratePercent  (rawPercent, market) -> calibrated percent.
 * @param {Map} input.parkFactorBaselines  venue id -> { runFactor, ... }.
 * @param {number|string|Date} input.nowMs  injected "now" for tiering (no wall-clock).
 * @param {Function} [input.moneylineWeightMultiplierFn]  (controls, factor) -> multiplier.
 *
 * @returns {object} deterministic core result with every probability stage named.
 */
export function predictGameMoneylineCore(input) {
  const {
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
    rollingTeamStats,
    evolutionControls,
    calibratePercent,
    parkFactorBaselines,
    nowMs,
    moneylineWeightMultiplierFn,
    defaultBullpenProfileFn
  } = input;

  if (!game || !game.teams) {
    throw new Error('predictGameMoneylineCore requires game.teams');
  }
  if (typeof calibratePercent !== 'function') {
    throw new Error('predictGameMoneylineCore requires an injected calibratePercent function');
  }
  const weightMultiplier =
    typeof moneylineWeightMultiplierFn === 'function'
      ? moneylineWeightMultiplierFn
      : () => 1;

  const get = (container, key) =>
    container == null ? undefined : container instanceof Map ? container.get(key) : container[key];

  const awayTeam = game.teams.away.team;
  const homeTeam = game.teams.home.team;
  const awayProfile = get(teamStats, awayTeam.id) || {};
  const homeProfile = get(teamStats, homeTeam.id) || {};
  const awayRolling = get(rollingTeamStats, awayTeam.id) || null;
  const homeRolling = get(rollingTeamStats, homeTeam.id) || null;
  const awayStanding = get(standings, awayTeam.id) || null;
  const homeStanding = get(standings, homeTeam.id) || null;
  const awayStarter = game.teams.away.probablePitcher
    ? { ...game.teams.away.probablePitcher, ...(get(pitcherDetails, game.teams.away.probablePitcher.id) || {}) }
    : null;
  const homeStarter = game.teams.home.probablePitcher
    ? { ...game.teams.home.probablePitcher, ...(get(pitcherDetails, game.teams.home.probablePitcher.id) || {}) }
    : null;
  const awayPitcherStats = awayStarter ? get(pitcherStats, awayStarter.id) : null;
  const homePitcherStats = homeStarter ? get(pitcherStats, homeStarter.id) : null;
  const awayOpenerSituation = detectOpenerSituation(game, 'away', awayStarter, awayPitcherStats);
  const homeOpenerSituation = detectOpenerSituation(game, 'home', homeStarter, homePitcherStats);
  const effectiveAwayPitcherStats = effectivePitcherStats(awayPitcherStats, awayOpenerSituation);
  const effectiveHomePitcherStats = effectivePitcherStats(homePitcherStats, homeOpenerSituation);
  const awayPitcherRecent = awayStarter ? get(pitcherRecentStarts, awayStarter.id) : null;
  const homePitcherRecent = homeStarter ? get(pitcherRecentStarts, homeStarter.id) : null;
  const defaultBullpen = (teamId) =>
    typeof defaultBullpenProfileFn === 'function'
      ? defaultBullpenProfileFn(teamId)
      : { teamId, fatigueScore: 0, backToBackRelievers: 0, highPitchRelievers: 0, line: 'bullpen data unavailable' };
  const awayBullpen = get(bullpenProfiles, awayTeam.id) || defaultBullpen(awayTeam.id);
  const homeBullpen = get(bullpenProfiles, homeTeam.id) || defaultBullpen(homeTeam.id);
  const gameDateYmd = game.officialDate || String(game.gameDate || '').slice(0, 10);
  const awayScheduleFatigue =
    get(scheduleFatigueProfiles, awayTeam.id) ||
    finalizeScheduleFatigueProfile(awayTeam.id, [], gameDateYmd);
  const homeScheduleFatigue =
    get(scheduleFatigueProfiles, homeTeam.id) ||
    finalizeScheduleFatigueProfile(homeTeam.id, [], gameDateYmd);
  const awayPitcherRest = pitcherRestProfile(awayStarter, awayPitcherRecent, gameDateYmd);
  const homePitcherRest = pitcherRestProfile(homeStarter, homePitcherRecent, gameDateYmd);
  const awayInjuries = get(injuryProfiles, awayTeam.id) || [];
  const homeInjuries = get(injuryProfiles, homeTeam.id) || [];
  const awayLineup = lineupProfiles?.away || null;
  const homeLineup = lineupProfiles?.home || null;

  const homeWinPct = leagueRecordPct(homeStanding?.leagueRecord || game.teams.home.leagueRecord);
  const awayWinPct = leagueRecordPct(awayStanding?.leagueRecord || game.teams.away.leagueRecord);
  const homeLastTenPct = splitPct(homeStanding, 'lastTen');
  const awayLastTenPct = splitPct(awayStanding, 'lastTen');
  const homeVenuePct = splitPct(homeStanding, 'home');
  const awayVenuePct = splitPct(awayStanding, 'away');
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
  const offenseBlend = blendedTeamOffenseEdge(homeProfile, awayProfile, homeRolling, awayRolling);
  const preventionBlend = blendedTeamPreventionEdge(homeProfile, awayProfile, homeRolling, awayRolling);
  const offenseEdge = offenseBlend.edge;
  const preventionEdge = preventionBlend.edge;
  const spSeasonEdge = starterSeasonEdge(effectiveHomePitcherStats, effectiveAwayPitcherStats);
  const spRecentEdgeRaw = starterRecentEdge(
    homeOpenerSituation.isOpener ? null : homePitcherRecent,
    awayOpenerSituation.isOpener ? null : awayPitcherRecent
  );
  const spEdge = starterEdge(
    effectiveHomePitcherStats,
    effectiveAwayPitcherStats,
    homeOpenerSituation.isOpener ? null : homePitcherRecent,
    awayOpenerSituation.isOpener ? null : awayPitcherRecent
  );
  const formEdge =
    (homeLastTenPct - awayLastTenPct) * 0.45 +
    (homeVenuePct - awayVenuePct) * 0.3 +
    (homeRunDiff - awayRunDiff) / 7;
  const pythagoreanEdge = homePythagoreanPct - awayPythagoreanPct;
  const log5Edge = homeReferenceBlend - 0.5;
  const h2hEdge = headToHead?.games > 0 ? (headToHead.homeProbability - 50) / 50 : 0;
  const memoryEdge = (homeMemoryBias - awayMemoryBias) * 0.06 + matchupMemory.edge * 0.12;
  const fatigueEdge = scheduleFatigueEdge(
    homeScheduleFatigue,
    awayScheduleFatigue,
    homePitcherRest,
    awayPitcherRest
  );
  const lineupEdge = lineupWinEdge(homeLineup, awayLineup, homeInjuries, awayInjuries);
  const bullpenEdge = bullpenAvailabilityEdge(homeBullpen, awayBullpen);

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
  const offenseWeightMultiplier = weightMultiplier(evolutionControls, 'offense');
  const starterWeightMultiplier = weightMultiplier(evolutionControls, 'starting_pitcher');
  const bullpenWeightMultiplier = weightMultiplier(evolutionControls, 'bullpen');
  const recentFormWeightMultiplier = weightMultiplier(evolutionControls, 'recent_form');
  const homeAdvantageWeightMultiplier = weightMultiplier(evolutionControls, 'home_advantage');

  const venueId = game.venue?.id || 0;
  const openerDetected = homeOpenerSituation.isOpener || awayOpenerSituation.isOpener;
  const sitWeights = situationalWeightAdjustment(parkFactorBaselines, venueId, openerDetected, gameDateYmd);

  const offenseComponent = clamp(offenseEdge + offenseFatigueEdge, -1.5, 1.5) * 0.32 * offenseWeightMultiplier * sitWeights.offense;
  const preventionComponent = clamp(preventionEdge, -1.35, 1.35) * 0.26;
  const starterComponent = clamp(spEdge, -1.35, 1.35) * 0.42 * starterWeightMultiplier * sitWeights.starting_pitcher;
  const bullpenComponent = bullpenEdge * 0.35 * bullpenWeightMultiplier * sitWeights.bullpen;
  const formComponent = clamp(formEdge, -0.3, 0.3) * 0.32 * recentFormWeightMultiplier * sitWeights.recent_form;
  const homeFieldComponent = 0.1 * homeAdvantageWeightMultiplier * sitWeights.home_advantage;

  const weatherAdj = weatherRunAdjustment(game.weather);
  const weatherComponent = clamp(weatherAdj * -0.08, -0.06, 0.06);

  const matchupEdge =
    offenseComponent +
    preventionComponent +
    starterComponent +
    lineupEdge * (bothLineupsConfirmed({ away: awayLineup, home: homeLineup }) ? 0.95 : 0.85) +
    bullpenComponent +
    fatigueEdge * 0.7;

  const recordContextEdge =
    log5Edge * 0.34 +
    formComponent +
    h2hEdge * 0.025 +
    memoryEdge +
    platoonEdge;
  const recordDominated =
    Math.abs(recordContextEdge) > Math.abs(matchupEdge) * 1.25 && Math.abs(matchupEdge) < 0.18;

  const bothConfirmed = bothLineupsConfirmed({ away: awayLineup, home: homeLineup });
  const confirmationEdge = bothConfirmed
    ? clamp(Math.sign(matchupEdge) * Math.min(Math.abs(matchupEdge) * 0.08, 0.04), -0.04, 0.04)
    : 0;

  const edge =
    matchupEdge +
    (recordDominated ? recordContextEdge * 0.45 : recordContextEdge) +
    homeFieldComponent +
    weatherComponent +
    confirmationEdge;

  const absEdge = Math.abs(edge);
  const dampeningFactor = absEdge < 0.25 ? DAMPEN_LOW : absEdge < 0.50 ? DAMPEN_MID : DAMPEN_HIGH;
  const dampenedEdge = edge * dampeningFactor;

  const rawHomeProbability = clamp(sigmoid(dampenedEdge) * 100, 35, 65);
  const rawAwayProbability = 100 - rawHomeProbability;

  // Calibration is the FINAL probability transform. Calibrate the favored side
  // and derive the other as its complement so both always sum to 100.
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
    starterSeasonEdge: spSeasonEdge,
    starterRecentEdge: spRecentEdgeRaw,
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
    rollingOffenseWeight: offenseBlend.rollingWeight,
    rollingPreventionWeight: preventionBlend.rollingWeight,
    rollingOffenseEdge: offenseBlend.rollingEdge,
    rollingPreventionEdge: preventionBlend.rollingEdge,
    recordDominated,
    rawHomeProbability,
    rawAwayProbability,
    pureHomeProbability: homeProbability,
    pureAwayProbability: awayProbability,
    activeWeightVersion: evolutionControls?.activeWeightVersion ?? null,
    situationalWeights: sitWeights,
    predictionTier: determinePredictionTier(game.gameDate, nowMs)
  };

  return {
    gamePk: game.gamePk,
    gameDateYmd,
    awayTeam,
    homeTeam,
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
    awayStanding,
    homeStanding,
    awayProfile,
    homeProfile,
    awayRolling,
    homeRolling,
    matchupMemory,
    raw: {
      edge,
      dampenedEdge,
      dampeningFactor,
      awayProbability: rawAwayProbability,
      homeProbability: rawHomeProbability
    },
    calibrated: {
      awayProbability,
      homeProbability
    },
    modelBreakdown
  };
}
