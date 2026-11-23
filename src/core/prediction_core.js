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

import { clamp, isFiniteNumber, sigmoid, toNumber } from '../utils.js';

export const PREDICTION_CORE_MODEL_VERSION = 'moneyline-core-v1.0';

/**
 * Serialize the externally-sourced core input bundle into plain JSON so it can
 * be frozen into an immutable prediction snapshot for later recompute replay.
 * Maps become plain objects keyed by id; park factor baselines become an array
 * of { id, value }. Functions (calibratePercent, weight multiplier) are NOT
 * serialized — replay reconstructs them from the frozen calibration artifact.
 */
export function buildCoreInputsSnapshot({
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
  parkFactorBaselines
} = {}) {
  const mapToObject = (value) => {
    if (value == null) return null;
    if (value instanceof Map) return Object.fromEntries(value);
    return value;
  };
  const parkEntries =
    parkFactorBaselines instanceof Map
      ? [...parkFactorBaselines.entries()].map(([id, value]) => ({ id, value }))
      : Array.isArray(parkFactorBaselines)
        ? parkFactorBaselines
        : [];
  const snapshot = {
    game: game || null,
    teamStats: mapToObject(teamStats),
    standings: mapToObject(standings),
    pitcherStats: mapToObject(pitcherStats),
    pitcherDetails: mapToObject(pitcherDetails),
    pitcherRecentStarts: mapToObject(pitcherRecentStarts),
    bullpenProfiles: mapToObject(bullpenProfiles),
    scheduleFatigueProfiles: mapToObject(scheduleFatigueProfiles),
    headToHead: headToHead || null,
    injuryProfiles: mapToObject(injuryProfiles),
    lineupProfiles: lineupProfiles || { away: null, home: null },
    modelMemory: modelMemory || {},
    rollingTeamStats: mapToObject(rollingTeamStats),
    evolutionControls: evolutionControls || {},
    parkFactorBaselines: parkEntries
  };
  if (rosterProfiles != null) {
    snapshot.rosterProfiles = mapToObject(rosterProfiles);
  }
  return snapshot;
}

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

// Smooth concave edge dampening: fights systematic overconfidence at larger
// raw edges while staying strictly monotonic everywhere (unlike the legacy
// piecewise step multipliers that created downward cliffs at 0.25 and 0.50).
// Asymptote 0.66 / 0.38 = 1.737 -> sigmoid(1.737) = 85.0% (aligned with
// [15%, 85%] clamp so genuine heavy mismatches break past the legacy 65% wall).
// Effective factor: ~0.64 at |e|=0.10, ~0.57 at |e|=0.40, ~0.49 at |e|=0.90.
const DAMPEN_SLOPE = 0.66;
const DAMPEN_CURVATURE = 0.38;
const BASELINE_MLB_RUNS = 8.8;
const BASELINE_STARTER_IP = 5.4;
const BASELINE_STARTER_SHARE = BASELINE_STARTER_IP / 9; // 0.60
const BASELINE_BULLPEN_SHARE = 1 - BASELINE_STARTER_SHARE; // 0.40

// Relaxed probability clamps (Phase 3.1): eliminates artificial 35%/65% wall
// that previously created false underdog value on genuine heavy mismatches.
export const RAW_PROBABILITY_MIN = 15;
export const RAW_PROBABILITY_MAX = 85;
export const CALIBRATED_PROBABILITY_MIN = 15;
export const CALIBRATED_PROBABILITY_MAX = 85;

export function dampenRawEdge(edge) {
  const e = toNumber(edge, 0);
  const absE = Math.abs(e);
  if (absE === 0) {
    return { dampenedEdge: 0, dampeningFactor: DAMPEN_SLOPE };
  }
  const dampeningFactor = DAMPEN_SLOPE / (1 + DAMPEN_CURVATURE * absE);
  return {
    dampenedEdge: e * dampeningFactor,
    dampeningFactor
  };
}

export function runEnvironmentEdgeScale(weatherAdj, parkRunFactor = 1.0) {
  const wAdj = toNumber(weatherAdj, 0);
  const rawPark =
    isFiniteNumber(parkRunFactor) && Number(parkRunFactor) > 0
      ? Number(parkRunFactor)
      : 1.0;
  // Normalize 100-scale park factors (e.g. 105 -> 1.05) defensively.
  const pFactor = rawPark > 10 ? rawPark / 100 : rawPark;
  // In Skellam / Pythagorean scoring, run-margin std scales with sqrt(R),
  // so win-probability logit leverage scales with sqrt(R0 / R). High-scoring
  // environments (wind out / warm / Coors) pull BOTH home and away favorites
  // symmetrically toward 50%; pitcher-friendly environments sharpen edges.
  const expectedRuns = Math.max(4.5, BASELINE_MLB_RUNS * pFactor + wAdj);
  return clamp(Math.sqrt(BASELINE_MLB_RUNS / expectedRuns), 0.85, 1.12);
}

function lookupParkInfo(parkFactorBaselines, venueId, homeTeamId = 0) {
  if (!parkFactorBaselines) return null;
  if (typeof parkFactorBaselines.get === 'function') {
    return (
      parkFactorBaselines.get(venueId) ??
      parkFactorBaselines.get(String(venueId)) ??
      parkFactorBaselines.get(homeTeamId) ??
      parkFactorBaselines.get(String(homeTeamId)) ??
      null
    );
  }
  if (Array.isArray(parkFactorBaselines)) {
    const findKey = (key) => {
      if (key == null || key === 0) return null;
      const match = parkFactorBaselines.find((entry) => {
        const id = Array.isArray(entry) ? entry[0] : entry?.id;
        return id === key || String(id) === String(key);
      });
      if (!match) return null;
      return Array.isArray(match) ? match[1] : match.value;
    };
    return findKey(venueId) ?? findKey(homeTeamId) ?? null;
  }
  if (typeof parkFactorBaselines === 'object') {
    return (
      parkFactorBaselines[venueId] ??
      parkFactorBaselines[String(venueId)] ??
      parkFactorBaselines[homeTeamId] ??
      parkFactorBaselines[String(homeTeamId)] ??
      null
    );
  }
  return null;
}

function normalizeParkFactorValue(value, fallback = 1.0) {
  if (!isFiniteNumber(value)) return fallback;
  const num = Number(value);
  if (!(num > 0)) return fallback;
  const normalized = num > 10 ? num / 100 : num;
  return clamp(normalized, 0.75, 1.35);
}

/**
 * Resolve a team's home-park run & HR factors and compute its effective
 * full-season park factor (50% home games + 50% league-average road games).
 * Eliminates Coors Field / pitcher-park inflation in raw season team RPG/OPS/ERA.
 */
export function teamHomeParkFactors(parkFactorBaselines, teamId) {
  const parkInfo = teamId ? lookupParkInfo(parkFactorBaselines, null, teamId) : null;
  const runFactor = normalizeParkFactorValue(parkInfo?.runFactor, 1.0);
  const homeRunFactor = normalizeParkFactorValue(parkInfo?.homeRunFactor, runFactor);
  const effectiveRunFactor = (1 + runFactor) / 2;
  const effectiveHrFactor = (1 + homeRunFactor) / 2;
  return {
    runFactor,
    homeRunFactor,
    effectiveRunFactor,
    effectiveHrFactor,
    opsScale: 1 + (effectiveRunFactor - 1) * 0.6,
    isoScale: 1 + (effectiveRunFactor - 1) * 0.5 + (effectiveHrFactor - 1) * 0.5,
    whipScale: 1 + (effectiveRunFactor - 1) * 0.5
  };
}

// Park-adjust ONLY when the raw stat is genuinely observed; never divide
// league-average DEFAULTS fallbacks by a team's park factor!
export function parkAdjustedRpg(stat, parkFactors = null) {
  if (!isFiniteNumber(stat?.runs) || !(toNumber(stat?.gamesPlayed, 0) > 0)) {
    return DEFAULTS.rpg;
  }
  const scale = parkFactors?.effectiveRunFactor || 1.0;
  return rpg(stat) / scale;
}

export function parkAdjustedOps(stat, parkFactors = null) {
  if (!isFiniteNumber(stat?.ops)) return DEFAULTS.ops;
  const scale = parkFactors?.opsScale || 1.0;
  return statOps(stat) / scale;
}

export function parkAdjustedIso(stat, parkFactors = null) {
  if (!isFiniteNumber(stat?.iso)) return DEFAULTS.iso;
  const scale = parkFactors?.isoScale || 1.0;
  return statIso(stat) / scale;
}

export function parkAdjustedEra(stat, parkFactors = null) {
  if (!isFiniteNumber(stat?.era)) return DEFAULTS.era;
  const scale = parkFactors?.effectiveRunFactor || 1.0;
  return statEra(stat) / scale;
}

export function parkAdjustedWhip(stat, parkFactors = null) {
  if (!isFiniteNumber(stat?.whip)) return DEFAULTS.whip;
  const scale = parkFactors?.whipScale || 1.0;
  return statWhip(stat) / scale;
}

export function parkAdjustedHr9(stat, parkFactors = null) {
  if (!isFiniteNumber(stat?.homeRunsPer9)) return DEFAULTS.hr9;
  const scale = parkFactors?.effectiveHrFactor || 1.0;
  return pitchingHr9(stat) / scale;
}

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

const NON_PITCHER_OPENER_RE = /\b(home|season|series|road|spring|exhibition|day)\s+opener\b/i;

export function detectOpenerSituation(game, side, pitcher, stats) {
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
  // Realistic MLB rest curve:
  //   <= 3d: short rest fatigue penalty (0.85)
  //   4d:    normal rotation rest (1.00)
  //   5-7d:  extra rest recovery bonus (1.02)
  //   8-9d:  extended rest neutral transition (1.00)
  //   >=10d: layoff / IL-return rust & pitch-limit penalty (0.93)
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
  return { pitcher: pitcher.fullName, restDays, multiplier, flag: label };
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

// ---------------------------------------------------------------------------
// team offense / prevention blend (pure)
// ---------------------------------------------------------------------------

export function blendedTeamOffenseEdge(seasonHome, seasonAway, rollingHome, rollingAway, options = {}) {
  const homePark = options?.homeParkFactors || null;
  const awayPark = options?.awayParkFactors || null;
  const homeRpg = parkAdjustedRpg(seasonHome?.hitting, homePark);
  const awayRpg = parkAdjustedRpg(seasonAway?.hitting, awayPark);
  const homeOps = parkAdjustedOps(seasonHome?.hitting, homePark);
  const awayOps = parkAdjustedOps(seasonAway?.hitting, awayPark);
  const homeIso = parkAdjustedIso(seasonHome?.hittingAdvanced, homePark);
  const awayIso = parkAdjustedIso(seasonAway?.hittingAdvanced, awayPark);
  const seasonEdge =
    (homeRpg - awayRpg) / 2.2 +
    (homeOps - awayOps) / 0.14 +
    (homeIso - awayIso) / 0.1 +
    (battingKRate(seasonAway?.hittingAdvanced) - battingKRate(seasonHome?.hittingAdvanced)) / 0.16 +
    (battingBbRate(seasonHome?.hittingAdvanced) - battingBbRate(seasonAway?.hittingAdvanced)) / 0.12;

  const homeGames = toNumber(rollingHome?.games, 0);
  const awayGames = toNumber(rollingAway?.games, 0);
  if (homeGames < 8 || awayGames < 8 || !rollingHome?.hitting || !rollingAway?.hitting) {
    return {
      edge: seasonEdge,
      rollingWeight: 0,
      rollingEdge: 0,
      homeParkAdjustedRpg: homeRpg,
      awayParkAdjustedRpg: awayRpg,
      homeParkAdjustedOps: homeOps,
      awayParkAdjustedOps: awayOps
    };
  }
  const rollingEdge =
    (rpg(rollingHome.hitting) - rpg(rollingAway.hitting)) / 2.2 +
    (statOps(rollingHome.hitting) - statOps(rollingAway.hitting)) / 0.14;
  const sample = Math.min(homeGames, awayGames);
  const rollingWeight = clamp((sample - 7) / 12, 0, 0.45);
  return {
    edge: seasonEdge * (1 - rollingWeight) + rollingEdge * rollingWeight,
    rollingWeight,
    rollingEdge,
    homeParkAdjustedRpg: homeRpg,
    awayParkAdjustedRpg: awayRpg,
    homeParkAdjustedOps: homeOps,
    awayParkAdjustedOps: awayOps
  };
}

export function blendedTeamPreventionEdge(seasonHome, seasonAway, rollingHome, rollingAway, options = {}) {
  const homePark = options?.homeParkFactors || null;
  const awayPark = options?.awayParkFactors || null;
  const homeEra = parkAdjustedEra(seasonHome?.pitching, homePark);
  const awayEra = parkAdjustedEra(seasonAway?.pitching, awayPark);
  const homeWhip = parkAdjustedWhip(seasonHome?.pitching, homePark);
  const awayWhip = parkAdjustedWhip(seasonAway?.pitching, awayPark);
  const homeHr9 = parkAdjustedHr9(seasonHome?.pitchingAdvanced, homePark);
  const awayHr9 = parkAdjustedHr9(seasonAway?.pitchingAdvanced, awayPark);
  const seasonEdge =
    (awayEra - homeEra) / 1.8 +
    (awayWhip - homeWhip) / 0.55 +
    (pitchingKMinusBb(seasonHome?.pitchingAdvanced) - pitchingKMinusBb(seasonAway?.pitchingAdvanced)) / 0.16 +
    (awayHr9 - homeHr9) / 1.2;

  const homeGames = toNumber(rollingHome?.games, 0);
  const awayGames = toNumber(rollingAway?.games, 0);
  if (homeGames < 8 || awayGames < 8 || !rollingHome?.pitching || !rollingAway?.pitching) {
    return {
      edge: seasonEdge,
      rollingWeight: 0,
      rollingEdge: 0,
      homeParkAdjustedEra: homeEra,
      awayParkAdjustedEra: awayEra
    };
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
    rollingEdge,
    homeParkAdjustedEra: homeEra,
    awayParkAdjustedEra: awayEra
  };
}

// ---------------------------------------------------------------------------
// starter edges (pure)
// ---------------------------------------------------------------------------

function parseBaseballInnings(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : null;
  const text = String(value).trim();
  if (!text) return null;
  const [whole, partial = '0'] = text.split('.');
  const wholeNum = Number.parseInt(whole, 10);
  const partialNum = Number.parseInt(partial, 10);
  if (!Number.isFinite(wholeNum)) return null;
  const safePartial = Number.isFinite(partialNum) && partialNum >= 0 && partialNum <= 2 ? partialNum : 0;
  return Math.max(0, (wholeNum * 3 + safePartial) / 3);
}

/**
 * Bayesian IP shrinkage + prior-season continuity for probable starters.
 * In early April, post-trade debuts, or rookie call-ups (low IP), raw ERA/WHIP
 * is noisy; shrink smoothly toward prior-season talent (if present on
 * `stats.priorSeason`) and league-average xFIP-style skill baselines.
 * Legacy fixtures without `inningsPitched` or `priorSeason` pass through
 * unchanged so existing golden tests remain bit-exact.
 */
export function shrinkPitcherStats(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const rawIp = parseBaseballInnings(stats.inningsPitched ?? stats.ip ?? stats.innings);
  const hasPrior = Boolean(stats.priorSeason && typeof stats.priorSeason === 'object');
  if (rawIp === null && !hasPrior) {
    return stats;
  }

  // Build prior baseline from priorSeason (shrunk gently toward league DEFAULTS)
  // so offseason-traded starters carry their real talent to their new club on Day 1.
  let priorEra = DEFAULTS.era;
  let priorWhip = DEFAULTS.whip;
  let priorKbb = 2.2;
  let priorKMinusBb = DEFAULTS.kMinusBb;
  let priorHr9 = DEFAULTS.hr9;

  if (hasPrior) {
    const p = stats.priorSeason;
    const pIp = parseBaseballInnings(p.inningsPitched ?? p.ip ?? p.innings);
    const pWeight = pIp === null ? 0.72 : clamp(pIp / (pIp + 45), 0, 0.82);
    priorEra = pWeight * statEra(p) + (1 - pWeight) * DEFAULTS.era;
    priorWhip = pWeight * statWhip(p) + (1 - pWeight) * DEFAULTS.whip;
    priorKbb = pWeight * kToBb(p) + (1 - pWeight) * 2.2;
    priorKMinusBb = pWeight * pitchingKMinusBb(p) + (1 - pWeight) * DEFAULTS.kMinusBb;
    priorHr9 = pWeight * pitchingHr9(p) + (1 - pWeight) * DEFAULTS.hr9;
  }

  const ip = rawIp ?? 0;
  const PRIOR_IP = 35;
  const w = clamp(ip / (ip + PRIOR_IP), 0, 1);

  const obsEra = ip > 0 ? statEra(stats) : priorEra;
  const obsWhip = ip > 0 ? statWhip(stats) : priorWhip;
  const obsKbb = ip > 0 ? kToBb(stats) : priorKbb;
  const obsKMinusBb = ip > 0 ? pitchingKMinusBb(stats) : priorKMinusBb;
  const obsHr9 = ip > 0 ? pitchingHr9(stats) : priorHr9;

  const shrunkKMinusBb = w * obsKMinusBb + (1 - w) * priorKMinusBb;
  const shrunkHr9 = w * obsHr9 + (1 - w) * priorHr9;
  let shrunkEra = w * obsEra + (1 - w) * priorEra;
  const shrunkWhip = w * obsWhip + (1 - w) * priorWhip;
  const shrunkKbb = w * obsKbb + (1 - w) * priorKbb;

  // xFIP-style skill stabilizer when current-season sample is < 65 IP:
  // prevents lucky/unlucky early-season BABIP/LOB% from distorting ERA.
  if (ip < 65) {
    const skillEra = clamp(
      DEFAULTS.era - (shrunkKMinusBb - DEFAULTS.kMinusBb) * 9.0 + (shrunkHr9 - DEFAULTS.hr9) * 1.15,
      2.35,
      6.10
    );
    const skillBlend = clamp((65 - ip) / 65, 0, 1) * 0.22;
    shrunkEra = shrunkEra * (1 - skillBlend) + skillEra * skillBlend;
  }

  return {
    ...stats,
    era: shrunkEra,
    whip: shrunkWhip,
    strikeoutsMinusWalksPercentage: shrunkKMinusBb,
    homeRunsPer9: shrunkHr9,
    _shrunkKbb: shrunkKbb,
    _effectiveIp: ip
  };
}

function starterInningMultipliers(options = {}) {
  const hasShares =
    isFiniteNumber(options?.homeStarterShare) &&
    isFiniteNumber(options?.awayStarterShare);
  if (!hasShares) {
    return { homeMult: 1.0, awayMult: 1.0 };
  }
  return {
    homeMult: clamp(Number(options.homeStarterShare) / BASELINE_STARTER_SHARE, 0.3, 1.3),
    awayMult: clamp(Number(options.awayStarterShare) / BASELINE_STARTER_SHARE, 0.3, 1.3)
  };
}

export function starterSeasonEdge(homePitcherStats, awayPitcherStats, options = {}) {
  if (!homePitcherStats && !awayPitcherStats) return 0;
  const homeShrunk = shrinkPitcherStats(homePitcherStats);
  const awayShrunk = shrinkPitcherStats(awayPitcherStats);
  const sideSkill = (shrunk) => {
    const era = statEra(shrunk);
    const whip = statWhip(shrunk);
    const kbb = Number.isFinite(shrunk?._shrunkKbb) ? shrunk._shrunkKbb : kToBb(shrunk);
    const kMinusBb = pitchingKMinusBb(shrunk);
    const hr9 = pitchingHr9(shrunk);
    return (
      (DEFAULTS.era - era) / 2.4 +
      (DEFAULTS.whip - whip) / 0.6 +
      (kbb - 2.2) / 4.0 +
      (kMinusBb - DEFAULTS.kMinusBb) / 0.16 +
      (DEFAULTS.hr9 - hr9) / 1.1
    );
  };
  // Asymmetric per-team inning scaling: an opener on one side reduces THAT side's
  // starter impact without diluting the opposing ace's 6.8 IP workload!
  const { homeMult, awayMult } = starterInningMultipliers(options);
  return clamp(sideSkill(homeShrunk) * homeMult - sideSkill(awayShrunk) * awayMult, -1.8, 1.8);
}

export function starterRecentEdge(homeRecent, awayRecent, options = {}) {
  const homeIp = toNumber(homeRecent?.innings, 0);
  const awayIp = toNumber(awayRecent?.innings, 0);
  if (homeIp < 6 || awayIp < 6) return 0;
  const sideRecentSkill = (recent, ip) => {
    const era = toNumber(recent.era, DEFAULTS.era);
    const whip = toNumber(recent.whip, DEFAULTS.whip);
    const kbb = toNumber(recent.strikeouts, 0) / Math.max(1, toNumber(recent.walks, 0));
    const hr9 = ip > 0 ? (toNumber(recent.homeRuns, 0) * 9) / ip : DEFAULTS.hr9;
    return (
      (DEFAULTS.era - era) / 2.6 +
      (DEFAULTS.whip - whip) / 0.65 +
      (kbb - 2.2) / 4.5 +
      (DEFAULTS.hr9 - hr9) / 1.2
    );
  };
  const { homeMult, awayMult } = starterInningMultipliers(options);
  const raw = sideRecentSkill(homeRecent, homeIp) * homeMult - sideRecentSkill(awayRecent, awayIp) * awayMult;
  const sampleWeight = clamp(Math.min(homeIp, awayIp) / 18, 0.35, 1);
  return clamp(raw * sampleWeight, -1.35, 1.35);
}

export function starterEdge(
  homePitcherStats,
  awayPitcherStats,
  homeRecent = null,
  awayRecent = null,
  options = {}
) {
  const season = starterSeasonEdge(homePitcherStats, awayPitcherStats, options);
  const recent = starterRecentEdge(homeRecent, awayRecent, options);
  if (!homePitcherStats && !awayPitcherStats && recent === 0) return 0;
  if (recent === 0) return season;
  return clamp(season * 0.55 + recent * 0.45, -1.8, 1.8);
}

/**
 * Project a starter's expected innings pitched (IP) and resulting starter vs
 * bullpen inning shares (IP / 9 vs (9 - IP) / 9) continuously — replacing the
 * brittle binary `< 4.8 IP` bullpen workload flag.
 */
export function projectStarterInnings(
  pitcherStats,
  pitcherRecent = null,
  openerSituation = null,
  pitcherRest = null
) {
  if (openerSituation?.isOpener) {
    const projectedIp = 1.75;
    return {
      projectedIp,
      starterShare: Math.round((projectedIp / 9) * 10000) / 10000,
      bullpenShare: Math.round(((9 - projectedIp) / 9) * 10000) / 10000,
      source: 'opener'
    };
  }

  let baseIp = BASELINE_STARTER_IP;
  let source = 'league_baseline';

  const extractSeasonIpPerStart = (statsObj) => {
    if (!statsObj || typeof statsObj !== 'object') return null;
    const ip = parseBaseballInnings(statsObj.inningsPitched ?? statsObj.ip ?? statsObj.innings);
    const gs = toNumber(statsObj.gamesStarted ?? statsObj.starts, 0);
    if (ip !== null && ip > 0 && gs >= 2) {
      return { avgIp: clamp(ip / gs, 2.5, 7.5), gs };
    }
    return null;
  };

  const seasonData = extractSeasonIpPerStart(pitcherStats);
  const priorData = extractSeasonIpPerStart(pitcherStats?.priorSeason);
  if (priorData) {
    const wPrior = clamp(priorData.gs / (priorData.gs + 10), 0, 0.7);
    baseIp = wPrior * priorData.avgIp + (1 - wPrior) * BASELINE_STARTER_IP;
    source = 'prior_season';
  }
  if (seasonData) {
    const wSeason = clamp(seasonData.gs / (seasonData.gs + 6), 0, 0.85);
    baseIp = wSeason * seasonData.avgIp + (1 - wSeason) * baseIp;
    source = 'season_shrunk';
  }

  const recentGames = toNumber(pitcherRecent?.games, 0);
  const recentIp = toNumber(pitcherRecent?.innings, 0);
  if (recentGames > 0 && recentIp > 0) {
    const recentAvg = clamp(recentIp / recentGames, 2.0, 7.8);
    const wRecent = clamp(recentGames / (recentGames + 3), 0, 0.65);
    baseIp = wRecent * recentAvg + (1 - wRecent) * baseIp;
    source = seasonData ? 'season_and_recent' : 'recent_shrunk';
  }

  const restDays = pitcherRest?.restDays;
  let restIpAdj = 0;
  if (isFiniteNumber(restDays)) {
    const d = Number(restDays);
    if (d <= 3) restIpAdj = -0.55;
    else if (d >= 10) restIpAdj = -0.65;
  }

  const projectedIp = Math.round(clamp(baseIp + restIpAdj, 1.5, 7.2) * 100) / 100;
  return {
    projectedIp,
    starterShare: Math.round((projectedIp / 9) * 10000) / 10000,
    bullpenShare: Math.round(((9 - projectedIp) / 9) * 10000) / 10000,
    source
  };
}

// ---------------------------------------------------------------------------
// lineup / platoon / bullpen / expected-runs / weather / park (pure)
// ---------------------------------------------------------------------------

function lineupRunAdjustment(lineup, injuries) {
  if (!lineup) return 0;
  const hitterInjuries = Array.isArray(injuries)
    ? injuries.filter((injury) => injury.position !== 'P').length
    : 0;
  if (lineup.confirmed) {
    const quality = toNumber(lineup.qualityScore, 0);
    // When the active confirmed 9-man lineup has strong positive hitter talent
    // (e.g. healthy stars or newly acquired trade/free-agent replacements),
    // legacy 40-man IL entries drag less on today's actual run production.
    const effectiveInjuries = quality > 0.02 ? hitterInjuries * 0.72 : hitterInjuries;
    const leadoffBonus = isFiniteNumber(lineup.leadoffObp)
      ? clamp((Number(lineup.leadoffObp) - 0.325) * 0.35, -0.02, 0.03)
      : 0;
    const newAdditions = Math.max(0, toNumber(lineup.acquisitionsInLineup, 0));
    const acquisitionSpark =
      newAdditions > 0 && quality > 0 ? Math.min(0.024, newAdditions * 0.009) : 0;
    return clamp(0.075 + leadoffBonus + acquisitionSpark - effectiveInjuries * 0.024, -0.2, 0.11);
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

  // Platoon split is computed exclusively in computePlatoonEdge() so handedness
  // splits are never double-counted between lineupEdge and platoonEdge.
  // Top-of-order (slots 1-4) OPS impact + confirmed starting-9 readiness boost.
  const homeTopAdj = isFiniteNumber(homeLineup?.topOrderOps)
    ? clamp((Number(homeLineup.topOrderOps) - 0.75) * 0.22, -0.03, 0.035)
    : 0;
  const awayTopAdj = isFiniteNumber(awayLineup?.topOrderOps)
    ? clamp((Number(awayLineup.topOrderOps) - 0.75) * 0.22, -0.03, 0.035)
    : 0;

  const homeConfirmedBoost =
    homeLineup?.confirmed && (homeLineup?.count || 0) >= 9
      ? 0.018 + Math.max(0, homeQuality) * 0.22
      : 0;
  const awayConfirmedBoost =
    awayLineup?.confirmed && (awayLineup?.count || 0) >= 9
      ? 0.018 + Math.max(0, awayQuality) * 0.22
      : 0;

  return clamp(
    (homeQuality - awayQuality) * 1.15 +
      (homeTopAdj - awayTopAdj) +
      (homeConfirmedBoost - awayConfirmedBoost) +
      (homeAvailability - awayAvailability) * 0.48,
    -0.22,
    0.22
  );
}

/**
 * Compute platoon advantage primarily from actual 9-batter lineup-weighted
 * platoon DELTA (split wOBA/OPS minus hitter's own overall baseline — zero
 * double-counting with offenseEdge/lineupEdge). Falls back to absolute lineup
 * platoon metrics only for legacy snapshots lacking deltas, and to shrunk team
 * standings split win% only when actual lineup platoon splits are absent.
 */
export function computePlatoonEdge(
  homeLineup,
  awayLineup,
  homeStanding,
  awayStanding,
  homeStarter,
  awayStarter
) {
  const coverage = clamp(
    Math.min(
      toNumber(homeLineup?.platoonCoverage, 1),
      toNumber(awayLineup?.platoonCoverage, 1)
    ),
    0.5,
    1.0
  );

  // Priority 1: Pure lineup-weighted platoon DELTA (split minus overall baseline).
  const hasHomeWobaDelta = isFiniteNumber(homeLineup?.platoonWobaDelta);
  const hasAwayWobaDelta = isFiniteNumber(awayLineup?.platoonWobaDelta);
  if (hasHomeWobaDelta && hasAwayWobaDelta) {
    return {
      edge: clamp(((Number(homeLineup.platoonWobaDelta) - Number(awayLineup.platoonWobaDelta)) / 0.055) * coverage, -0.14, 0.14),
      source: 'lineup_weighted_woba_delta',
      homeMetric: Number(homeLineup.platoonWobaDelta),
      awayMetric: Number(awayLineup.platoonWobaDelta)
    };
  }

  const hasHomeOpsDelta = isFiniteNumber(homeLineup?.platoonOpsDelta);
  const hasAwayOpsDelta = isFiniteNumber(awayLineup?.platoonOpsDelta);
  if (hasHomeOpsDelta && hasAwayOpsDelta) {
    return {
      edge: clamp(((Number(homeLineup.platoonOpsDelta) - Number(awayLineup.platoonOpsDelta)) / 0.13) * coverage, -0.14, 0.14),
      source: 'lineup_weighted_ops_delta',
      homeMetric: Number(homeLineup.platoonOpsDelta),
      awayMetric: Number(awayLineup.platoonOpsDelta)
    };
  }

  // Priority 2: Absolute lineup platoon wOBA/OPS (for snapshots/fixtures without deltas).
  const hasHomeWoba = isFiniteNumber(homeLineup?.platoonWoba);
  const hasAwayWoba = isFiniteNumber(awayLineup?.platoonWoba);
  if (hasHomeWoba && hasAwayWoba) {
    return {
      edge: clamp(((Number(homeLineup.platoonWoba) - Number(awayLineup.platoonWoba)) / 0.095) * coverage, -0.14, 0.14),
      source: 'lineup_weighted_woba',
      homeMetric: Number(homeLineup.platoonWoba),
      awayMetric: Number(awayLineup.platoonWoba)
    };
  }

  const hasHomeOps = isFiniteNumber(homeLineup?.platoonOps);
  const hasAwayOps = isFiniteNumber(awayLineup?.platoonOps);
  if (hasHomeOps && hasAwayOps) {
    return {
      edge: clamp(((Number(homeLineup.platoonOps) - Number(awayLineup.platoonOps)) / 0.22) * coverage, -0.14, 0.14),
      source: 'lineup_weighted_ops',
      homeMetric: Number(homeLineup.platoonOps),
      awayMetric: Number(awayLineup.platoonOps)
    };
  }

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

  if (hasHomeOps || hasAwayOps) {
    const homeScore = hasHomeOps
      ? clamp((Number(homeLineup.platoonOps) - DEFAULTS.ops) / 0.22, -0.09, 0.09)
      : homeVsStarterHand != null
        ? clamp((homeVsStarterHand - 0.5) * 0.35, -0.06, 0.06)
        : 0;
    const awayScore = hasAwayOps
      ? clamp((Number(awayLineup.platoonOps) - DEFAULTS.ops) / 0.22, -0.09, 0.09)
      : awayVsStarterHand != null
        ? clamp((awayVsStarterHand - 0.5) * 0.35, -0.06, 0.06)
        : 0;
    return {
      edge: clamp(homeScore - awayScore, -0.12, 0.12),
      source: 'hybrid_lineup_standings',
      homeMetric: hasHomeOps ? Number(homeLineup.platoonOps) : homeVsStarterHand,
      awayMetric: hasAwayOps ? Number(awayLineup.platoonOps) : awayVsStarterHand
    };
  }

  if (homeVsStarterHand != null && awayVsStarterHand != null) {
    return {
      edge: clamp((homeVsStarterHand - awayVsStarterHand) * 0.35, -0.08, 0.08),
      source: 'standings_fallback',
      homeMetric: homeVsStarterHand,
      awayMetric: awayVsStarterHand
    };
  }

  return { edge: 0, source: 'unavailable', homeMetric: null, awayMetric: null };
}

export function bothLineupsConfirmed(lineups) {
  const away = lineups?.away;
  const home = lineups?.home;
  return Boolean(
    away?.confirmed && home?.confirmed && (away?.count || 0) >= 9 && (home?.count || 0) >= 9
  );
}

export function bullpenAvailabilityEdge(homeBullpen, awayBullpen, options = {}) {
  const homeFatigue = toNumber(homeBullpen?.fatigueScore, 0);
  const awayFatigue = toNumber(awayBullpen?.fatigueScore, 0);
  const homeB2b = toNumber(homeBullpen?.backToBackRelievers, 0);
  const awayB2b = toNumber(awayBullpen?.backToBackRelievers, 0);
  const homeHighPitch = toNumber(homeBullpen?.highPitchRelievers, 0);
  const awayHighPitch = toNumber(awayBullpen?.highPitchRelievers, 0);

  // Per-team continuous bullpen inning exposure scaling (relative to 3.6/9 = 0.40).
  // When a team uses an opener (bullpen share ~0.81 -> 2.0x) while its opponent
  // starts a 6.5 IP workhorse (~0.28 -> 0.7x), each bullpen scales by its OWN workload.
  const hasContinuousShares =
    isFiniteNumber(options?.homeBullpenShare) &&
    isFiniteNumber(options?.awayBullpenShare);
  const legacyWorkloadMult = options?.highBullpenWorkload ? 1.25 : 1.0;
  const homeBpMult = hasContinuousShares
    ? clamp(Number(options.homeBullpenShare) / BASELINE_BULLPEN_SHARE, 0.55, 2.0)
    : 1.0;
  const awayBpMult = hasContinuousShares
    ? clamp(Number(options.awayBullpenShare) / BASELINE_BULLPEN_SHARE, 0.55, 2.0)
    : 1.0;

  const homeFatigueDrag =
    (homeFatigue * 0.07 + homeB2b * 0.024 + homeHighPitch * 0.017) * homeBpMult;
  const awayFatigueDrag =
    (awayFatigue * 0.07 + awayB2b * 0.024 + awayHighPitch * 0.017) * awayBpMult;
  const fatiguePart = awayFatigueDrag - homeFatigueDrag;

  // Bullpen run-prevention quality (14d shrunk relief ERA/WHIP/K-BB/HR9).
  // Absent on legacy snapshots -> 0 so historical replays stay exact.
  const hasReliefQuality =
    isFiniteNumber(homeBullpen?.reliefEra) &&
    isFiniteNumber(awayBullpen?.reliefEra);
  let qualityPart = 0;
  if (hasReliefQuality) {
    const homeEra = Number(homeBullpen.reliefEra);
    const awayEra = Number(awayBullpen.reliefEra);
    const homeWhip = toNumber(homeBullpen.reliefWhip, DEFAULTS.whip);
    const awayWhip = toNumber(awayBullpen.reliefWhip, DEFAULTS.whip);
    const homeKbb = toNumber(homeBullpen.reliefKbb, 2.3);
    const awayKbb = toNumber(awayBullpen.reliefKbb, 2.3);
    const homeHr9 = toNumber(homeBullpen.reliefHr9, DEFAULTS.hr9);
    const awayHr9 = toNumber(awayBullpen.reliefHr9, DEFAULTS.hr9);

    const homeReliefSkill =
      (DEFAULTS.era - homeEra) * 0.048 +
      (DEFAULTS.whip - homeWhip) * 0.12 +
      (homeKbb - 2.3) * 0.016 +
      (DEFAULTS.hr9 - homeHr9) * 0.028;
    const awayReliefSkill =
      (DEFAULTS.era - awayEra) * 0.048 +
      (DEFAULTS.whip - awayWhip) * 0.12 +
      (awayKbb - 2.3) * 0.016 +
      (DEFAULTS.hr9 - awayHr9) * 0.028;

    const rawQuality = hasContinuousShares
      ? homeReliefSkill * homeBpMult - awayReliefSkill * awayBpMult
      : (homeReliefSkill - awayReliefSkill) * legacyWorkloadMult;
    qualityPart = clamp(rawQuality, -0.15, 0.15);
  }

  return clamp(fatiguePart + qualityPart, -0.22, 0.22);
}

/**
 * Discrete Poisson/Skellam home win probability for expected runs (homeLambda,
 * awayLambda), resolving regulation ties using extra-inning home win probability.
 */
export function skellamWinProbability(homeLambda, awayLambda, extraInningHomeWinProb = 0.525) {
  const lh = clamp(toNumber(homeLambda, DEFAULTS.rpg), 0.5, 14);
  const la = clamp(toNumber(awayLambda, DEFAULTS.rpg), 0.5, 14);
  const maxRuns = 26;
  const pmf = (lambda) => {
    const arr = new Array(maxRuns + 1);
    let p = Math.exp(-lambda);
    arr[0] = p;
    for (let k = 1; k <= maxRuns; k += 1) {
      p = (p * lambda) / k;
      arr[k] = p;
    }
    return arr;
  };
  const ph = pmf(lh);
  const pa = pmf(la);
  let homeWin = 0;
  let tie = 0;
  let totalMass = 0;
  for (let h = 0; h <= maxRuns; h += 1) {
    for (let a = 0; a <= maxRuns; a += 1) {
      const joint = ph[h] * pa[a];
      totalMass += joint;
      if (h > a) homeWin += joint;
      else if (h === a) tie += joint;
    }
  }
  const extraHome = clamp(toNumber(extraInningHomeWinProb, 0.525), 0.42, 0.62);
  const prob = totalMass > 0 ? (homeWin + tie * extraHome) / totalMass : 0.5;
  return clamp(prob, 0.05, 0.95);
}

/**
 * Parallel non-overlapping Expected Runs model (lambda_home, lambda_away) ->
 * exact Skellam & Pythagenpat win probabilities. Separates park-adjusted offense
 * from inning-coupled pitching (starter share * SP + bullpen share * BP) with
 * zero double-counting of team ERA / standings.
 */
export function computeExpectedRunsModel({
  homeProfile,
  awayProfile,
  homeRolling,
  awayRolling,
  homeParkFactors,
  awayParkFactors,
  gameParkRunFactor = 1.0,
  weatherAdj = 0,
  homePitcherStats,
  awayPitcherStats,
  homePitcherRecent,
  awayPitcherRecent,
  homeStarterIp,
  awayStarterIp,
  homeBullpen,
  awayBullpen,
  homeLineup,
  awayLineup,
  platoonResult,
  homeScheduleFatigue,
  awayScheduleFatigue
} = {}) {
  const offenseFactor = (profile, rolling, parkFactors, lineup, fatigue, platoonSideDelta) => {
    const adjRpg = parkAdjustedRpg(profile?.hitting, parkFactors);
    const adjOps = parkAdjustedOps(profile?.hitting, parkFactors);
    let baseFactor = 0.55 * (adjRpg / DEFAULTS.rpg) + 0.45 * Math.pow(adjOps / DEFAULTS.ops, 1.45);
    const rollGames = toNumber(rolling?.games, 0);
    if (rollGames >= 8 && rolling?.hitting) {
      const rollFactor =
        0.55 * (rpg(rolling.hitting) / DEFAULTS.rpg) +
        0.45 * Math.pow(statOps(rolling.hitting) / DEFAULTS.ops, 1.45);
      const wRoll = clamp((rollGames - 7) / 14, 0, 0.35);
      baseFactor = baseFactor * (1 - wRoll) + rollFactor * wRoll;
    }
    const lineupQuality = toNumber(lineup?.qualityScore, 0);
    const lineupMult = 1 + clamp(lineupQuality * 0.45, -0.07, 0.07);
    const platoonMult = 1 + clamp(platoonSideDelta * 0.35, -0.05, 0.05);
    const fatigueMult = 1 + clamp(toNumber(fatigue?.offenseAdjustment, 0), -0.06, 0.04);
    return clamp(baseFactor * lineupMult * platoonMult * fatigueMult, 0.65, 1.45);
  };

  const pitchingAllowedFactor = (pitcherStats, pitcherRecent, starterIp, bullpen, teamPark) => {
    const shrunk = shrinkPitcherStats(pitcherStats);
    const hasObservedSpEra = Boolean(shrunk && isFiniteNumber(shrunk.era));
    let spEra = hasObservedSpEra ? Number(shrunk.era) : DEFAULTS.era;
    // Mildly park-adjust ONLY observed starter ERA toward neutral environment;
    // never divide a league-average DEFAULTS fallback (e.g. opener / TBD starter)!
    if (hasObservedSpEra && teamPark?.effectiveRunFactor) {
      spEra /= teamPark.effectiveRunFactor;
    }
    const recentIp = toNumber(pitcherRecent?.innings, 0);
    if (recentIp >= 10 && isFiniteNumber(pitcherRecent?.era)) {
      const wRec = clamp(recentIp / (recentIp + 30), 0, 0.35);
      spEra = spEra * (1 - wRec) + Number(pitcherRecent.era) * wRec;
    }
    spEra = clamp(spEra, 2.1, 6.8);

    const rawBpEra = isFiniteNumber(bullpen?.reliefEra) ? Number(bullpen.reliefEra) : DEFAULTS.era;
    const bpFatiguePenalty =
      toNumber(bullpen?.fatigueScore, 0) * 0.14 +
      toNumber(bullpen?.backToBackRelievers, 0) * 0.12 +
      toNumber(bullpen?.highPitchRelievers, 0) * 0.08;
    const bpEra = clamp(rawBpEra + bpFatiguePenalty, 2.2, 6.8);

    const wSp = clamp(toNumber(starterIp?.starterShare, BASELINE_STARTER_SHARE), 0.15, 0.85);
    const wBp = 1 - wSp;
    const blendedEra = wSp * spEra + wBp * bpEra;
    return {
      factor: clamp(blendedEra / DEFAULTS.era, 0.62, 1.55),
      spEra: Math.round(spEra * 100) / 100,
      bpEra: Math.round(bpEra * 100) / 100,
      blendedEra: Math.round(blendedEra * 100) / 100
    };
  };

  const platoonHalf = toNumber(platoonResult?.edge, 0) / 2;
  const homeOff = offenseFactor(homeProfile, homeRolling, homeParkFactors, homeLineup, homeScheduleFatigue, platoonHalf);
  const awayOff = offenseFactor(awayProfile, awayRolling, awayParkFactors, awayLineup, awayScheduleFatigue, -platoonHalf);

  const homePitch = pitchingAllowedFactor(homePitcherStats, homePitcherRecent, homeStarterIp, homeBullpen, homeParkFactors);
  const awayPitch = pitchingAllowedFactor(awayPitcherStats, awayPitcherRecent, awayStarterIp, awayBullpen, awayParkFactors);

  const parkMult = normalizeParkFactorValue(gameParkRunFactor, 1.0);
  const hfaRunSplit = 0.032; // ~3.2% run-scoring edge -> ~53.5% baseline HFA
  const halfWeather = toNumber(weatherAdj, 0) * 0.5;

  const homeLambda = clamp(
    DEFAULTS.rpg * homeOff * awayPitch.factor * parkMult * (1 + hfaRunSplit) + halfWeather,
    1.5,
    9.5
  );
  const awayLambda = clamp(
    DEFAULTS.rpg * awayOff * homePitch.factor * parkMult * (1 - hfaRunSplit) + halfWeather,
    1.5,
    9.5
  );

  // Extra-inning tie-break reflects home walk-off advantage + bullpen edge.
  const bpDiff = (awayPitch.bpEra - homePitch.bpEra) * 0.02;
  const extraHomeWin = clamp(0.525 + bpDiff, 0.45, 0.6);
  const skellamHome = skellamWinProbability(homeLambda, awayLambda, extraHomeWin);
  const totalLambda = homeLambda + awayLambda;
  const pythExp = Math.pow(Math.max(2, totalLambda), 0.287);
  const pythHome = clamp(
    Math.pow(homeLambda, pythExp) / (Math.pow(homeLambda, pythExp) + Math.pow(awayLambda, pythExp)),
    0.05,
    0.95
  );

  return {
    homeLambda: Math.round(homeLambda * 100) / 100,
    awayLambda: Math.round(awayLambda * 100) / 100,
    totalLambda: Math.round(totalLambda * 100) / 100,
    skellamHomeProbability: Math.round(skellamHome * 1000) / 10,
    skellamAwayProbability: Math.round((1 - skellamHome) * 1000) / 10,
    pythagenpatHomeProbability: Math.round(pythHome * 1000) / 10,
    pythagenpatAwayProbability: Math.round((1 - pythHome) * 1000) / 10,
    homeOffenseFactor: Math.round(homeOff * 1000) / 1000,
    awayOffenseFactor: Math.round(awayOff * 1000) / 1000,
    homePitchingFactor: Math.round(homePitch.factor * 1000) / 1000,
    awayPitchingFactor: Math.round(awayPitch.factor * 1000) / 1000,
    homeBlendedEra: homePitch.blendedEra,
    awayBlendedEra: awayPitch.blendedEra
  };
}

/**
 * Guard calibrated favored-side percentage against non-monotonic calibration-map
 * artifacts (e.g. legacy 2026 [0.498->0.3889] dip that inverted 50.0-51.6%
 * favorites into <50% underdogs, and 65-70% artificial overconfidence spikes).
 * Preserves identity calibration (`calibrated === raw`) untouched.
 */
export function guardFavoredCalibrationPercent(rawFavoredPercent, calibratedFavoredPercent) {
  const raw = Number(rawFavoredPercent);
  const cal = Number(calibratedFavoredPercent);
  if (!Number.isFinite(raw) || !Number.isFinite(cal)) return calibratedFavoredPercent;
  // Identity calibration (or exact match): never alter.
  if (Math.abs(cal - raw) < 1e-9) return cal;

  // Never allow a calibration map to invert the model's favored side (< 50%).
  if (raw > 50 && cal < 50.1) {
    return Math.round(Math.max(50.1, 50 + Math.min(2.4, (raw - 50) * 0.65 + 0.1)) * 10) / 10;
  }
  if (raw === 50 && cal < 50) {
    return 50;
  }

  // Tame artificial upward jumps above 64.0% when raw probability is moderate
  // (fixes the 65-70% overconfidence bucket observed across 2026 outcomes).
  if (cal > 64.0 && cal > raw + 3.0) {
    return Math.round(Math.max(raw, 64.0 + (cal - 64.0) * 0.45) * 10) / 10;
  }
  return cal;
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

function situationalWeightAdjustment(parkFactorBaselines, venueId, openerDetected, gameDateYmd, homeTeamId = 0) {
  const parkInfo = lookupParkInfo(parkFactorBaselines, venueId, homeTeamId);
  const rawRunFactor = parkInfo ? toNumber(parkInfo.runFactor, 1.0) : 1.0;
  const runFactor = rawRunFactor > 10 ? rawRunFactor / 100 : rawRunFactor;
  const parkType = runFactor >= 1.05 ? 'hitter_park' : runFactor <= 0.95 ? 'pitcher_park' : 'neutral';
  const month = gameDateYmd ? parseInt(String(gameDateYmd).slice(5, 7), 10) : 6;
  const phase = month <= 4 ? 'early' : month >= 8 ? 'late' : 'mid';

  const adj = { offense: 0, starting_pitcher: 0, bullpen: 0, recent_form: 0, home_advantage: 0 };
  if (parkType === 'hitter_park') { adj.offense += 0.08; adj.starting_pitcher -= 0.05; }
  else if (parkType === 'pitcher_park') { adj.starting_pitcher += 0.08; adj.offense -= 0.05; }
  // Opener starter->bullpen weight shift is now modeled continuously per team
  // via starterShare / bullpenShare (avoiding binary double-counting here).
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
    rosterProfiles,
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
  const awayRoster = get(rosterProfiles, awayTeam.id) || null;
  const homeRoster = get(rosterProfiles, homeTeam.id) || null;
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

  const homeParkFactors = teamHomeParkFactors(parkFactorBaselines, homeTeam.id || 0);
  const awayParkFactors = teamHomeParkFactors(parkFactorBaselines, awayTeam.id || 0);

  const winPctEdge = homeWinPct - awayWinPct;
  const offenseBlend = blendedTeamOffenseEdge(homeProfile, awayProfile, homeRolling, awayRolling, {
    homeParkFactors,
    awayParkFactors
  });
  const preventionBlend = blendedTeamPreventionEdge(homeProfile, awayProfile, homeRolling, awayRolling, {
    homeParkFactors,
    awayParkFactors
  });
  const offenseEdge = offenseBlend.edge;
  const preventionEdge = preventionBlend.edge;
  const openerDetected = homeOpenerSituation.isOpener || awayOpenerSituation.isOpener;
  const homeStarterIp = projectStarterInnings(
    effectiveHomePitcherStats,
    homeOpenerSituation.isOpener ? null : homePitcherRecent,
    homeOpenerSituation,
    homePitcherRest
  );
  const awayStarterIp = projectStarterInnings(
    effectiveAwayPitcherStats,
    awayOpenerSituation.isOpener ? null : awayPitcherRecent,
    awayOpenerSituation,
    awayPitcherRest
  );
  const spInningOpts = {
    homeStarterShare: homeStarterIp.starterShare,
    awayStarterShare: awayStarterIp.starterShare
  };
  const avgStarterShare = (homeStarterIp.starterShare + awayStarterIp.starterShare) / 2;
  const starterInningScale = clamp(avgStarterShare / BASELINE_STARTER_SHARE, 0.45, 1.22);

  const spSeasonEdge = starterSeasonEdge(effectiveHomePitcherStats, effectiveAwayPitcherStats, spInningOpts);
  const spRecentEdgeRaw = starterRecentEdge(
    homeOpenerSituation.isOpener ? null : homePitcherRecent,
    awayOpenerSituation.isOpener ? null : awayPitcherRecent,
    spInningOpts
  );
  const spEdge = starterEdge(
    effectiveHomePitcherStats,
    effectiveAwayPitcherStats,
    homeOpenerSituation.isOpener ? null : homePitcherRecent,
    awayOpenerSituation.isOpener ? null : awayPitcherRecent,
    spInningOpts
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
  const bullpenEdge = bullpenAvailabilityEdge(homeBullpen, awayBullpen, {
    homeBullpenShare: homeStarterIp.bullpenShare,
    awayBullpenShare: awayStarterIp.bullpenShare
  });

  const platoonResult = computePlatoonEdge(
    homeLineup,
    awayLineup,
    homeStanding,
    awayStanding,
    homeStarter,
    awayStarter
  );
  const platoonEdge = platoonResult.edge;

  const offenseFatigueEdge =
    homeScheduleFatigue.offenseAdjustment - awayScheduleFatigue.offenseAdjustment;
  const offenseWeightMultiplier = weightMultiplier(evolutionControls, 'offense');
  const starterWeightMultiplier = weightMultiplier(evolutionControls, 'starting_pitcher');
  const bullpenWeightMultiplier = weightMultiplier(evolutionControls, 'bullpen');
  const recentFormWeightMultiplier = weightMultiplier(evolutionControls, 'recent_form');
  const homeAdvantageWeightMultiplier = weightMultiplier(evolutionControls, 'home_advantage');

  const venueId = game.venue?.id || 0;
  const sitWeights = situationalWeightAdjustment(
    parkFactorBaselines,
    venueId,
    openerDetected,
    gameDateYmd,
    homeTeam.id || 0
  );

  // Early-season / high-roster-turnover adjustment: when clubs have traded or
  // rotated players and current-season team sample is small (< 35G), down-weight
  // stale team-aggregate offense slightly and boost the actual starting 9 lineup!
  const homeGamesSample = toNumber(
    homeStanding?.gamesPlayed ?? homeProfile?.hitting?.gamesPlayed,
    100
  );
  const awayGamesSample = toNumber(
    awayStanding?.gamesPlayed ?? awayProfile?.hitting?.gamesPlayed,
    100
  );
  const earlySeasonFactor = clamp((35 - Math.min(homeGamesSample, awayGamesSample)) / 35, 0, 1);
  const homeTurnover = toNumber(homeLineup?.rosterTurnover ?? homeRoster?.turnoverScore, 0);
  const awayTurnover = toNumber(awayLineup?.rosterTurnover ?? awayRoster?.turnoverScore, 0);
  const avgTurnover = clamp((homeTurnover + awayTurnover) / 2, 0, 1);
  const teamOffenseTurnoverScale = 1 - earlySeasonFactor * avgTurnover * 0.22;
  const lineupTurnoverBoost = 1 + earlySeasonFactor * avgTurnover * 0.30;

  const bothConfirmed = bothLineupsConfirmed({ away: awayLineup, home: homeLineup });
  const lineupComponent = lineupEdge * (bothConfirmed ? 1.08 : 0.92) * lineupTurnoverBoost;

  const offenseComponent =
    clamp(offenseEdge + offenseFatigueEdge, -1.5, 1.5) *
    0.32 *
    offenseWeightMultiplier *
    sitWeights.offense *
    teamOffenseTurnoverScale;
  const preventionComponent = clamp(preventionEdge, -1.35, 1.35) * 0.26;
  // Asymmetric per-team starter inning shares are already applied inside spEdge!
  const starterComponent =
    clamp(spEdge, -1.5, 1.5) *
    0.42 *
    starterWeightMultiplier *
    sitWeights.starting_pitcher;
  const bullpenComponent = bullpenEdge * 0.35 * bullpenWeightMultiplier * sitWeights.bullpen;
  const formComponent = clamp(formEdge, -0.3, 0.3) * 0.32 * recentFormWeightMultiplier * sitWeights.recent_form;
  const homeFieldComponent = 0.1 * homeAdvantageWeightMultiplier * sitWeights.home_advantage;

  const parkInfo = lookupParkInfo(parkFactorBaselines, venueId, homeTeam.id || 0);
  const parkRunFactor = toNumber(parkInfo?.runFactor, 1.0);
  const weatherAdj = weatherRunAdjustment(game.weather);
  const runEnvScale = runEnvironmentEdgeScale(weatherAdj, parkRunFactor);

  const matchupEdge =
    offenseComponent +
    preventionComponent +
    starterComponent +
    lineupComponent +
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

  // Phase 3.3: Separate lineup confirmation from mean probability shift!
  // Confirming lineups narrows uncertainty (confidence/Kelly signal) rather than
  // pushing the mean win probability further away from 50%.
  const lineupAgreesWithMatchup =
    Math.abs(lineupComponent) >= 0.02 && Math.sign(lineupComponent) === Math.sign(matchupEdge);
  const lineupOpposesMatchup =
    Math.abs(lineupComponent) >= 0.03 && Math.sign(lineupComponent) === -Math.sign(matchupEdge);
  const confirmationSignal = bothConfirmed
    ? clamp(
        Math.round(
          (0.5 +
            (lineupAgreesWithMatchup ? 0.35 : lineupOpposesMatchup ? -0.25 : 0.1) +
            Math.min(0.15, Math.abs(matchupEdge) * 0.25)) *
            1000
        ) / 1000,
        0,
        1
      )
    : 0;
  const confirmationEdge = 0;

  const preWeatherEdge =
    matchupEdge +
    (recordDominated ? recordContextEdge * 0.45 : recordContextEdge) +
    homeFieldComponent +
    confirmationEdge;

  // Express run-environment variance scaling as an additive delta so
  // sum(HEURISTIC_COMPONENTS) === rawEdge holds to machine precision.
  const weatherComponent = preWeatherEdge * (runEnvScale - 1);
  const edge = preWeatherEdge + weatherComponent;

  const { dampenedEdge, dampeningFactor } = dampenRawEdge(edge);

  const rawHomeProbability = clamp(
    sigmoid(dampenedEdge) * 100,
    RAW_PROBABILITY_MIN,
    RAW_PROBABILITY_MAX
  );
  const rawAwayProbability = 100 - rawHomeProbability;

  // Parallel non-overlapping Expected Runs (lambda_home, lambda_away) ->
  // Skellam & Pythagenpat win probabilities for shadow evaluation & diagnostics.
  const expectedRuns = computeExpectedRunsModel({
    homeProfile,
    awayProfile,
    homeRolling,
    awayRolling,
    homeParkFactors,
    awayParkFactors,
    gameParkRunFactor: parkRunFactor,
    weatherAdj,
    homePitcherStats: effectiveHomePitcherStats,
    awayPitcherStats: effectiveAwayPitcherStats,
    homePitcherRecent: homeOpenerSituation.isOpener ? null : homePitcherRecent,
    awayPitcherRecent: awayOpenerSituation.isOpener ? null : awayPitcherRecent,
    homeStarterIp,
    awayStarterIp,
    homeBullpen,
    awayBullpen,
    homeLineup,
    awayLineup,
    platoonResult,
    homeScheduleFatigue,
    awayScheduleFatigue
  });

  // Calibration is the FINAL probability transform. Calibrate the favored side
  // (guarded against winner-inversion dips and extreme map spikes) and derive
  // the other as its complement so both always sum to 100.
  let homeProbability = rawHomeProbability;
  let awayProbability = rawAwayProbability;
  let homeProbabilityPrecise = rawHomeProbability;
  let awayProbabilityPrecise = rawAwayProbability;
  if (rawHomeProbability >= 50) {
    const calibratedRaw = calibratePercent(rawHomeProbability, 'moneyline');
    homeProbability = clamp(
      guardFavoredCalibrationPercent(rawHomeProbability, calibratedRaw),
      CALIBRATED_PROBABILITY_MIN,
      CALIBRATED_PROBABILITY_MAX
    );
    awayProbability = 100 - homeProbability;
    homeProbabilityPrecise = homeProbability;
    awayProbabilityPrecise = awayProbability;
  } else {
    const calibratedRaw = calibratePercent(rawAwayProbability, 'moneyline');
    awayProbability = clamp(
      guardFavoredCalibrationPercent(rawAwayProbability, calibratedRaw),
      CALIBRATED_PROBABILITY_MIN,
      CALIBRATED_PROBABILITY_MAX
    );
    homeProbability = 100 - awayProbability;
    awayProbabilityPrecise = awayProbability;
    homeProbabilityPrecise = homeProbability;
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
    starterInningScale,
    homeStarterProjectedIp: homeStarterIp.projectedIp,
    awayStarterProjectedIp: awayStarterIp.projectedIp,
    homeBullpenShare: homeStarterIp.bullpenShare,
    awayBullpenShare: awayStarterIp.bullpenShare,
    lineupEdge: lineupComponent,
    confirmationEdge,
    confirmationSignal,
    lineupAgreesWithMatchup,
    lineupOpposesMatchup,
    bullpenEdge: bullpenComponent,
    fatigueEdge: fatigueEdge * 0.7,
    winPctEdge,
    pythagoreanEdge,
    log5Edge: log5Edge * 0.34,
    formEdge: formComponent,
    h2hEdge: h2hEdge * 0.025,
    memoryEdge,
    platoonEdge,
    platoonSource: platoonResult.source,
    homeFieldEdge: homeFieldComponent,
    weatherEdge: weatherComponent,
    runEnvScale,
    homeParkEffectiveRunFactor: homeParkFactors.effectiveRunFactor,
    awayParkEffectiveRunFactor: awayParkFactors.effectiveRunFactor,
    expectedRuns,
    rollingOffenseWeight: offenseBlend.rollingWeight,
    rollingPreventionWeight: preventionBlend.rollingWeight,
    rollingOffenseEdge: offenseBlend.rollingEdge,
    rollingPreventionEdge: preventionBlend.rollingEdge,
    rosterTurnoverAvg: avgTurnover,
    earlySeasonFactor,
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
    preventionBlend,
    starterWeightMultiplier,
    spRecentEdgeRaw,
    homeStarterIp,
    awayStarterIp,
    platoonResult,
    expectedRuns,
    bothConfirmed,
    confirmationEdge,
    confirmationSignal,
    raw: {
      edge,
      dampenedEdge,
      dampeningFactor,
      awayProbability: rawAwayProbability,
      homeProbability: rawHomeProbability
    },
    calibrated: {
      awayProbability,
      homeProbability,
      awayProbabilityPrecise,
      homeProbabilityPrecise
    },
    modelBreakdown
  };
}
