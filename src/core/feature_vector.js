/**
 * Stable feature-vector contract for the all-game research dataset.
 *
 * The feature vector is built ONLY from the frozen coreInputs that were
 * captured at prediction time — never recalculated from current files. This
 * is the bridge between the live JS control engine and offline Python
 * training/evaluation. It carries numeric values as observed (or null when
 * missing), sample sizes, and missingness indicators so a downstream model can
 * distinguish "absent" from "defaulted to league average".
 *
 * Contract rules:
 *  - Built from the SAME frozen inputs passed to buildCoreInputsSnapshot().
 *  - Numeric values as observed, or null. Never fabricated.
 *  - Feature hash covers schema, values, missingness, and source cutoffs —
 *    never outcomes.
 *  - Outcomes are separate labels and are never embedded here.
 *  - Versioned manifest: adding a feature bumps FEATURE_VECTOR_SCHEMA_VERSION.
 */

import { createHash } from 'node:crypto';
import { CONTROL_FEATURE_SCHEMA_VERSION } from './model_ids.js';

export const FEATURE_VECTOR_SCHEMA_VERSION = 'mlb-feature-vector-v1.0';
export const FEATURE_VECTOR_V2_SCHEMA_VERSION = 'mlb-feature-vector-v2.0';

export const FEATURE_VECTOR_V1_FEATURE_NAMES = [
  'awayRpg', 'awayOps', 'homeRpg', 'homeOps', 'awayTeamGames', 'homeTeamGames',
  'awayEra', 'awayWhip', 'homeEra', 'homeWhip',
  'awayRollingRpg', 'awayRollingOps', 'homeRollingRpg', 'homeRollingOps',
  'awayRollingGames', 'homeRollingGames',
  'awayWinPct', 'homeWinPct', 'awayLastTenPct', 'homeLastTenPct',
  'awayRunDiffPerGame', 'homeRunDiffPerGame',
  'awayVsStarterHandPct', 'homeVsStarterHandPct',
  'awayStarterEra', 'awayStarterWhip', 'homeStarterEra', 'homeStarterWhip',
  'awayStarterKMinusBb', 'homeStarterKMinusBb', 'awayStarterHr9', 'homeStarterHr9',
  'awayStarterRecentEra', 'awayStarterRecentWhip', 'awayStarterRecentInnings',
  'homeStarterRecentEra', 'homeStarterRecentWhip', 'homeStarterRecentInnings',
  'awayBullpenFatigue', 'homeBullpenFatigue',
  'awayBullpenBackToBack', 'homeBullpenBackToBack',
  'awayRestDays', 'homeRestDays', 'awayRoadStreak', 'homeRoadStreak',
  'awayLineupConfirmed', 'homeLineupConfirmed',
  'awayLineupQuality', 'homeLineupQuality',
  'awayLineupCount', 'homeLineupCount',
  'awayInjuryCount', 'homeInjuryCount',
  'h2hGames', 'h2hHomeWinPct',
  'temperature', 'windSpeed', 'windHittingOut', 'windHittingIn',
  'awayStarterHandLeft', 'homeStarterHandLeft'
];

export const FEATURE_VECTOR_V2_EXTRA_FEATURE_NAMES = [
  // Market timing / lead-time
  'leadTimeMinutes',
  // Park factors & park-adjusted season stats
  'gameParkRunFactor', 'gameParkHrFactor',
  'awayHomeParkEffRunFactor', 'homeHomeParkEffRunFactor',
  'awayParkAdjRpg', 'homeParkAdjRpg',
  'awayParkAdjOps', 'homeParkAdjOps',
  'awayParkAdjEra', 'homeParkAdjEra',
  'awayParkAdjWhip', 'homeParkAdjWhip',
  // Lineup-weighted platoon splits & top-of-order
  'awayLineupPlatoonOps', 'homeLineupPlatoonOps',
  'awayLineupPlatoonWoba', 'homeLineupPlatoonWoba',
  'awayLineupPlatoonOpsDelta', 'homeLineupPlatoonOpsDelta',
  'awayLineupPlatoonWobaDelta', 'homeLineupPlatoonWobaDelta',
  'awayLineupTopOrderOps', 'homeLineupTopOrderOps',
  // Continuous starter IP projection & bullpen relief quality
  'awayStarterProjectedIp', 'homeStarterProjectedIp',
  'awayStarterShare', 'homeStarterShare',
  'awayBullpenReliefEra', 'homeBullpenReliefEra',
  'awayBullpenReliefWhip', 'homeBullpenReliefWhip',
  // Statcast / expected metrics & travel/jet-lag fatigue (optional/nullable)
  'awayTeamXwoba', 'homeTeamXwoba',
  'awayTeamBarrelRate', 'homeTeamBarrelRate',
  'awayStarterXera', 'homeStarterXera',
  'awayTravelMiles', 'homeTravelMiles',
  'awayTimezoneShift', 'homeTimezoneShift',
  'awayTravelFatigueScore', 'homeTravelFatigueScore',
  // Domain interactions
  'platoonDeltaDiff', 'flyballParkWindIndex'
];

export const FEATURE_VECTOR_V2_FEATURE_NAMES = [
  ...FEATURE_VECTOR_V1_FEATURE_NAMES,
  ...FEATURE_VECTOR_V2_EXTRA_FEATURE_NAMES
];

function num(value, fallback = null) {
  if (value == null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function gp(stat) {
  return Math.max(1, num(stat?.gamesPlayed ?? stat?.hitting?.gamesPlayed, 1));
}

function rpg(stat) {
  if (!stat) return null;
  const runs = num(stat.runs ?? stat.hitting?.runs, null);
  if (runs == null) return null;
  return runs / gp(stat);
}

function ops(stat) {
  return stat ? num(stat.ops ?? stat.hitting?.ops, null) : null;
}

function era(stat) {
  return stat ? num(stat.era ?? stat.pitching?.era, null) : null;
}

function whip(stat) {
  return stat ? num(stat.whip ?? stat.pitching?.whip, null) : null;
}

function recordPct(record) {
  if (!record) return null;
  if (record.pct != null) return num(record.pct, null);
  const w = num(record.wins, 0);
  const l = num(record.losses, 0);
  const t = w + l;
  return t > 0 ? w / t : null;
}

function splitPct(standing, type) {
  if (!standing?.records?.splitRecords) return null;
  const rec = standing.records.splitRecords.find((r) => r.type === type);
  return rec ? recordPct(rec) : null;
}

function runDiffPerGame(standing) {
  if (!standing) return null;
  const rd = num(standing.runDifferential, null);
  const games = num(standing.gamesPlayed ?? standing.leagueRecord?.wins + standing.leagueRecord?.losses, null);
  if (rd == null || !games || games <= 0) return null;
  return rd / games;
}

function gamesPlayedRecord(standing) {
  if (!standing) return null;
  return num(
    standing.gamesPlayed ?? (standing.leagueRecord ? standing.leagueRecord.wins + standing.leagueRecord.losses : null),
    null
  );
}

function withMissing(value) {
  return { value, missing: value == null ? 1 : 0 };
}

/**
 * Build the normalized feature vector from frozen coreInputs (plain JSON, the
 * same object buildCoreInputsSnapshot returns). Returns a plain JSON object.
 */
export function buildFeatureVector(coreInputs) {
  const raw = coreInputs || {};
  const game = raw.game || {};
  const teams = game.teams || {};
  const awayTeam = teams.away?.team || {};
  const homeTeam = teams.home?.team || {};
  const awayId = awayTeam.id;
  const homeId = homeTeam.id;

  const at = (obj, id) => (obj && id != null ? obj[id] : null);
  const awayStats = at(raw.teamStats, awayId);
  const homeStats = at(raw.teamStats, homeId);
  const awayStanding = at(raw.standings, awayId);
  const homeStanding = at(raw.standings, homeId);
  const awayRolling = at(raw.rollingTeamStats, awayId);
  const homeRolling = at(raw.rollingTeamStats, homeId);

  const awayPitcherId = teams.away?.probablePitcher?.id;
  const homePitcherId = teams.home?.probablePitcher?.id;
  const awayPitcher = at(raw.pitcherStats, awayPitcherId);
  const homePitcher = at(raw.pitcherStats, homePitcherId);
  const awayPitcherRecent = at(raw.pitcherRecentStarts, awayPitcherId);
  const homePitcherRecent = at(raw.pitcherRecentStarts, homePitcherId);

  const awayBullpen = at(raw.bullpenProfiles, awayId);
  const homeBullpen = at(raw.bullpenProfiles, homeId);
  const awaySched = at(raw.scheduleFatigueProfiles, awayId);
  const homeSched = at(raw.scheduleFatigueProfiles, homeId);
  const awayInjuries = at(raw.injuryProfiles, awayId);
  const homeInjuries = at(raw.injuryProfiles, homeId);

  const awayLineup = raw.lineupProfiles?.away || null;
  const homeLineup = raw.lineupProfiles?.home || null;
  const h2h = raw.headToHead || null;

  const weather = game.weather || {};
  const tempNum = num(weather.temp, null);
  const windMatch = typeof weather.wind === 'string' ? weather.wind.match(/([\d.]+)\s*mph/i) : null;
  const windSpeed = windMatch ? num(windMatch[1], null) : null;
  const windOut = typeof weather.wind === 'string' ? /out|cf|lf|rf/i.test(weather.wind) : null;
  const windIn = typeof weather.wind === 'string' ? /\bin\b/i.test(weather.wind) : null;

  // Pitcher handedness (opposing team's platoon context).
  const awayStarterHand = teams.away?.probablePitcher?.pitchHand?.code || null;
  const homeStarterHand = teams.home?.probablePitcher?.pitchHand?.code || null;

  const vector = {
    schemaVersion: FEATURE_VECTOR_SCHEMA_VERSION,
    featureSchemaVersion: CONTROL_FEATURE_SCHEMA_VERSION,
    gamePk: String(game.gamePk ?? ''),
    awayTeamId: awayId != null ? String(awayId) : null,
    homeTeamId: homeId != null ? String(homeId) : null,
    venueId: game.venue?.id != null ? num(game.venue.id, null) : null,
    officialDate: game.officialDate || null,

    // --- Team season offense (run-based + rate) ---
    awayRpg: withMissing(rpg(awayStats)),
    awayOps: withMissing(ops(awayStats)),
    homeRpg: withMissing(rpg(homeStats)),
    homeOps: withMissing(ops(homeStats)),
    awayTeamGames: withMissing(gamesPlayedRecord(awayStanding)),
    homeTeamGames: withMissing(gamesPlayedRecord(homeStanding)),

    // --- Team season pitching ---
    awayEra: withMissing(era(awayStats)),
    awayWhip: withMissing(whip(awayStats)),
    homeEra: withMissing(era(homeStats)),
    homeWhip: withMissing(whip(homeStats)),

    // --- Rolling recent form ---
    awayRollingRpg: withMissing(rpg(awayRolling)),
    awayRollingOps: withMissing(ops(awayRolling)),
    homeRollingRpg: withMissing(rpg(homeRolling)),
    homeRollingOps: withMissing(ops(homeRolling)),
    awayRollingGames: withMissing(awayRolling ? num(awayRolling.games, null) : null),
    homeRollingGames: withMissing(homeRolling ? num(homeRolling.games, null) : null),

    // --- Standings / record ---
    awayWinPct: withMissing(recordPct(awayStanding?.leagueRecord)),
    homeWinPct: withMissing(recordPct(homeStanding?.leagueRecord)),
    awayLastTenPct: withMissing(splitPct(awayStanding, 'lastTen')),
    homeLastTenPct: withMissing(splitPct(homeStanding, 'lastTen')),
    awayRunDiffPerGame: withMissing(runDiffPerGame(awayStanding)),
    homeRunDiffPerGame: withMissing(runDiffPerGame(homeStanding)),
    // Platoon splits vs opposing starter hand:
    awayVsStarterHandPct: withMissing(
      homeStarterHand === 'L'
        ? splitPct(awayStanding, 'left')
        : homeStarterHand === 'R'
          ? splitPct(awayStanding, 'right')
          : null
    ),
    homeVsStarterHandPct: withMissing(
      awayStarterHand === 'L'
        ? splitPct(homeStanding, 'left')
        : awayStarterHand === 'R'
          ? splitPct(homeStanding, 'right')
          : null
    ),

    // --- Probable starter season ---
    awayStarterEra: withMissing(era(awayPitcher)),
    awayStarterWhip: withMissing(whip(awayPitcher)),
    homeStarterEra: withMissing(era(homePitcher)),
    homeStarterWhip: withMissing(whip(homePitcher)),
    awayStarterKMinusBb: withMissing(
      awayPitcher ? num(awayPitcher.strikeoutsMinusWalksPercentage, null) : null
    ),
    homeStarterKMinusBb: withMissing(
      homePitcher ? num(homePitcher.strikeoutsMinusWalksPercentage, null) : null
    ),
    awayStarterHr9: withMissing(awayPitcher ? num(awayPitcher.homeRunsPer9, null) : null),
    homeStarterHr9: withMissing(homePitcher ? num(homePitcher.homeRunsPer9, null) : null),

    // --- Probable starter recent ---
    awayStarterRecentEra: withMissing(era(awayPitcherRecent)),
    awayStarterRecentWhip: withMissing(whip(awayPitcherRecent)),
    awayStarterRecentInnings: withMissing(awayPitcherRecent ? num(awayPitcherRecent.innings, null) : null),
    homeStarterRecentEra: withMissing(era(homePitcherRecent)),
    homeStarterRecentWhip: withMissing(whip(homePitcherRecent)),
    homeStarterRecentInnings: withMissing(homePitcherRecent ? num(homePitcherRecent.innings, null) : null),

    // --- Bullpen fatigue ---
    awayBullpenFatigue: withMissing(awayBullpen ? num(awayBullpen.fatigueScore, null) : null),
    homeBullpenFatigue: withMissing(homeBullpen ? num(homeBullpen.fatigueScore, null) : null),
    awayBullpenBackToBack: withMissing(awayBullpen ? num(awayBullpen.backToBackRelievers, null) : null),
    homeBullpenBackToBack: withMissing(homeBullpen ? num(homeBullpen.backToBackRelievers, null) : null),

    // --- Schedule fatigue ---
    awayRestDays: withMissing(awaySched ? num(awaySched.restDays, null) : null),
    homeRestDays: withMissing(homeSched ? num(homeSched.restDays, null) : null),
    awayRoadStreak: withMissing(awaySched ? num(awaySched.roadStreak, null) : null),
    homeRoadStreak: withMissing(homeSched ? num(homeSched.roadStreak, null) : null),

    // --- Lineup ---
    awayLineupConfirmed: withMissing(awayLineup?.confirmed == null ? null : awayLineup.confirmed ? 1 : 0),
    homeLineupConfirmed: withMissing(homeLineup?.confirmed == null ? null : homeLineup.confirmed ? 1 : 0),
    awayLineupQuality: withMissing(awayLineup ? num(awayLineup.qualityScore, null) : null),
    homeLineupQuality: withMissing(homeLineup ? num(homeLineup.qualityScore, null) : null),
    awayLineupCount: withMissing(awayLineup ? num(awayLineup.count, null) : null),
    homeLineupCount: withMissing(homeLineup ? num(homeLineup.count, null) : null),

    // --- Injuries (hitter count) ---
    awayInjuryCount: withMissing(Array.isArray(awayInjuries) ? awayInjuries.length : null),
    homeInjuryCount: withMissing(Array.isArray(homeInjuries) ? homeInjuries.length : null),

    // --- Head to head ---
    h2hGames: withMissing(num(h2h?.games, null) > 0 ? num(h2h.games, null) : null),
    h2hHomeWinPct: withMissing(
      num(h2h?.games, null) > 0 && num(h2h?.homeProbability, null) != null
        ? num(h2h.homeProbability, null) / 100
        : null
    ),

    // --- Weather ---
    temperature: withMissing(tempNum),
    windSpeed: withMissing(windSpeed),
    windHittingOut: withMissing(windOut == null ? null : windOut ? 1 : 0),
    windHittingIn: withMissing(windIn == null ? null : windIn ? 1 : 0),

    // --- Pitcher handedness (categorical, encoded) ---
    awayStarterHandLeft: withMissing(
      awayStarterHand == null ? null : awayStarterHand === 'L' ? 1 : 0
    ),
    homeStarterHandLeft: withMissing(
      homeStarterHand == null ? null : homeStarterHand === 'L' ? 1 : 0
    )
  };

  vector.featureVectorHash = hashFeatureVector(vector);
  return vector;
}

function clampNum(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

const EXPLICIT_TZ_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function parseIsoMs(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Require explicit UTC/offset designator so JS (local OS TZ) and Python (UTC)
  // never diverge on naive timestamps.
  if (!EXPLICIT_TZ_RE.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function parseYmdUtcMs(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ms = Date.UTC(year, month - 1, day);
  return Number.isFinite(ms) ? ms : null;
}

function ymdDiffDays(targetYmd, earlierYmd) {
  const tMs = parseYmdUtcMs(targetYmd);
  const eMs = parseYmdUtcMs(earlierYmd);
  if (tMs == null || eMs == null) return null;
  return Math.round((tMs - eMs) / 86400000);
}

const OPENER_KEYWORD_RE = /\b(opener|bulk|piggyback)\b|opener\s*\/\s*bulk/i;
const NON_PITCHER_OPENER_RE = /\b(home|season|series|road|spring|exhibition|day)\s+opener\b/i;
const OPENER_NOTE_KEYS = [
  'note', 'notes', 'description', 'summary', 'role', 'type',
  'gameNote', 'gameNotes', 'probablePitcherNote', 'probablePitcherNotes'
];

function collectOpenerNotes(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const lines = [];
  for (const key of OPENER_NOTE_KEYS) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim()) {
      lines.push(val.trim());
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string' && item.trim()) lines.push(item.trim());
      }
    }
  }
  return lines;
}

function detectOpenerFlag(teamEntry, probablePitcher, pitcherStats, explicitOpener = false) {
  if (explicitOpener || pitcherStats?.isOpener === true) return true;
  const notes = [
    ...collectOpenerNotes(teamEntry),
    ...collectOpenerNotes(probablePitcher)
  ]
    .filter((line) => !NON_PITCHER_OPENER_RE.test(line))
    .join(' ');
  if (notes && OPENER_KEYWORD_RE.test(notes)) return true;

  const gs = num(pitcherStats?.gamesStarted ?? pitcherStats?.starts, null);
  const app = num(pitcherStats?.gamesPitched ?? pitcherStats?.appearances ?? pitcherStats?.games, null);
  if (gs != null && app != null && app >= 10 && gs / app < 0.3) {
    return true;
  }
  return false;
}

function lookupParkEntry(baselines, venueId, teamId) {
  if (!baselines) return null;
  const lookupKey = (key) => {
    if (key == null || key === '' || key === 0) return null;
    if (typeof baselines.get === 'function') {
      return baselines.get(key) ?? baselines.get(String(key)) ?? null;
    }
    if (Array.isArray(baselines)) {
      const match = baselines.find((entry) => {
        const id = Array.isArray(entry) ? entry[0] : entry?.id;
        return id === key || String(id) === String(key);
      });
      if (!match) return null;
      return Array.isArray(match) ? match[1] : match.value;
    }
    if (typeof baselines === 'object') {
      return baselines[key] ?? baselines[String(key)] ?? null;
    }
    return null;
  };
  return lookupKey(venueId) ?? lookupKey(teamId) ?? null;
}

function normalizeParkFactor(value) {
  const n = num(value, null);
  if (n == null || !(n > 0)) return null;
  const normalized = n > 10 ? n / 100 : n;
  return clampNum(normalized, 0.75, 1.35);
}

function parseBaseballIp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : null;
  const text = String(value).trim();
  if (!text) return null;
  const parts = text.split('.');
  const wholeNum = Number.parseInt(parts[0], 10);
  if (!Number.isFinite(wholeNum)) return null;
  const partialNum = parts.length > 1 ? Number.parseInt(parts[1], 10) : 0;
  const safePartial = Number.isFinite(partialNum) && partialNum >= 0 && partialNum <= 2 ? partialNum : 0;
  return Math.max(0, (wholeNum * 3 + safePartial) / 3);
}

function extractSeasonIpPerStart(statsObj) {
  if (!statsObj || typeof statsObj !== 'object') return null;
  const ip = parseBaseballIp(statsObj.inningsPitched ?? statsObj.ip ?? statsObj.innings);
  const gs = num(statsObj.gamesStarted ?? statsObj.starts, 0);
  if (ip !== null && ip > 0 && gs >= 2) {
    return { avgIp: clampNum(ip / gs, 2.5, 7.5), gs };
  }
  return null;
}

function computeProjectedStarterIp(
  pitcherStats,
  pitcherRecent,
  isOpener = false,
  officialDate = null
) {
  if (isOpener) {
    return 1.75;
  }
  const seasonData = extractSeasonIpPerStart(pitcherStats);
  const priorData = extractSeasonIpPerStart(pitcherStats?.priorSeason);
  const recentGames = num(pitcherRecent?.games, 0);
  const recentIp = num(pitcherRecent?.innings, 0);
  const hasRecent = recentGames > 0 && recentIp > 0;

  if (!seasonData && !priorData && !hasRecent) {
    return null;
  }

  let baseIp = 5.4;
  if (priorData) {
    const wPrior = clampNum(priorData.gs / (priorData.gs + 10), 0, 0.7);
    baseIp = wPrior * priorData.avgIp + (1 - wPrior) * 5.4;
  }
  if (seasonData) {
    const wSeason = clampNum(seasonData.gs / (seasonData.gs + 6), 0, 0.85);
    baseIp = wSeason * seasonData.avgIp + (1 - wSeason) * baseIp;
  }
  if (hasRecent) {
    const recentAvg = clampNum(recentIp / recentGames, 2.0, 7.8);
    const wRecent = clampNum(recentGames / (recentGames + 3), 0, 0.65);
    baseIp = wRecent * recentAvg + (1 - wRecent) * baseIp;
  }

  let restDays = num(pitcherRecent?.restDays ?? pitcherStats?.restDays, null);
  if (restDays === null && officialDate && pitcherRecent?.lastStartDate) {
    const diff = ymdDiffDays(officialDate, pitcherRecent.lastStartDate);
    if (diff !== null) {
      const derived = Math.max(0, diff - 1);
      if (derived <= 30) restDays = derived;
    }
  }
  let restIpAdj = 0;
  if (restDays !== null) {
    if (restDays <= 3) restIpAdj = -0.55;
    else if (restDays >= 10) restIpAdj = -0.65;
  }

  return Math.round(clampNum(baseIp + restIpAdj, 1.5, 7.2) * 100) / 100;
}

/**
 * Build the Phase 4 Feature Vector v2.0 (`mlb-feature-vector-v2.0`) from frozen
 * coreInputs plus optional temporal context ({ asOfUtc, firstPitchUtc }).
 *
 * Inherits all 62 v1.0 base features (fixing word-boundary windHittingOut) and
 * appends 45 v2.0 baseball, timing, park-adjusted, lineup-platoon, workload,
 * Statcast/travel, and domain interaction cells. Never fabricates missing data.
 */
export function buildFeatureVectorV2(coreInputs, context = {}) {
  const raw = coreInputs || {};
  const ctx = context || {};
  const baseV1 = buildFeatureVector(raw);

  const game = raw.game || {};
  const teams = game.teams || {};
  const awayTeam = teams.away?.team || {};
  const homeTeam = teams.home?.team || {};
  const awayId = awayTeam.id;
  const homeId = homeTeam.id;

  const at = (obj, id) => {
    if (!obj || typeof obj !== 'object' || id == null) return null;
    if (Object.prototype.hasOwnProperty.call(obj, id)) return obj[id];
    return obj[String(id)] ?? null;
  };

  const awayStats = at(raw.teamStats, awayId);
  const homeStats = at(raw.teamStats, homeId);
  const awayPitcherId = teams.away?.probablePitcher?.id;
  const homePitcherId = teams.home?.probablePitcher?.id;
  const awayPitcher = at(raw.pitcherStats, awayPitcherId);
  const homePitcher = at(raw.pitcherStats, homePitcherId);
  const awayPitcherRecent = at(raw.pitcherRecentStarts, awayPitcherId);
  const homePitcherRecent = at(raw.pitcherRecentStarts, homePitcherId);
  const awayBullpen = at(raw.bullpenProfiles, awayId);
  const homeBullpen = at(raw.bullpenProfiles, homeId);
  const awaySched = at(raw.scheduleFatigueProfiles, awayId);
  const homeSched = at(raw.scheduleFatigueProfiles, homeId);
  const awayLineup = raw.lineupProfiles?.away || null;
  const homeLineup = raw.lineupProfiles?.home || null;

  // Word-boundary fix for windHittingOut in v2.0 (prevents "south" false match).
  const weather = game.weather || {};
  const windOutV2 =
    typeof weather.wind === 'string' ? /\b(?:out|cf|lf|rf)\b/i.test(weather.wind) : null;
  const windInV2 =
    typeof weather.wind === 'string' ? /\bin\b/i.test(weather.wind) : null;
  const windSpeedV2 = baseV1.windSpeed.value;

  // 1. Lead-time before first pitch (minutes, pregame only).
  const asOfMs = parseIsoMs(ctx.asOfUtc ?? raw.asOfUtc ?? null);
  const firstPitchMs = parseIsoMs(ctx.firstPitchUtc ?? raw.firstPitchUtc ?? game.gameDate ?? null);
  const leadTimeMinutes =
    asOfMs != null && firstPitchMs != null && firstPitchMs > asOfMs
      ? (firstPitchMs - asOfMs) / 60000
      : null;

  // 2. Park factors & park-adjusted season stats (observed-only, never fabricated).
  const baselines = raw.parkFactorBaselines || null;
  const venueId = game.venue?.id != null ? num(game.venue.id, null) : null;
  const gameParkEntry = lookupParkEntry(baselines, venueId, homeId);
  const awayParkEntry = lookupParkEntry(baselines, null, awayId);
  const homeParkEntry = lookupParkEntry(baselines, null, homeId);

  const gameParkRunFactor = normalizeParkFactor(gameParkEntry?.runFactor);
  const gameParkHrFactor = normalizeParkFactor(gameParkEntry?.homeRunFactor ?? gameParkEntry?.runFactor);

  const awayHomeRunFactor = normalizeParkFactor(awayParkEntry?.runFactor);
  const homeHomeRunFactor = normalizeParkFactor(homeParkEntry?.runFactor);
  const awayEffRun = awayHomeRunFactor != null ? (1 + awayHomeRunFactor) / 2 : null;
  const homeEffRun = homeHomeRunFactor != null ? (1 + homeHomeRunFactor) / 2 : null;
  const awayOpsScale = awayEffRun != null ? 1 + (awayEffRun - 1) * 0.6 : null;
  const homeOpsScale = homeEffRun != null ? 1 + (homeEffRun - 1) * 0.6 : null;
  const awayWhipScale = awayEffRun != null ? 1 + (awayEffRun - 1) * 0.5 : null;
  const homeWhipScale = homeEffRun != null ? 1 + (homeEffRun - 1) * 0.5 : null;

  const awayRpgVal = baseV1.awayRpg.value;
  const homeRpgVal = baseV1.homeRpg.value;
  const awayOpsVal = baseV1.awayOps.value;
  const homeOpsVal = baseV1.homeOps.value;
  const awayEraVal = baseV1.awayEra.value;
  const homeEraVal = baseV1.homeEra.value;
  const awayWhipVal = baseV1.awayWhip.value;
  const homeWhipVal = baseV1.homeWhip.value;

  const awayParkAdjRpg = awayRpgVal != null && awayEffRun != null ? awayRpgVal / awayEffRun : null;
  const homeParkAdjRpg = homeRpgVal != null && homeEffRun != null ? homeRpgVal / homeEffRun : null;
  const awayParkAdjOps = awayOpsVal != null && awayOpsScale != null ? awayOpsVal / awayOpsScale : null;
  const homeParkAdjOps = homeOpsVal != null && homeOpsScale != null ? homeOpsVal / homeOpsScale : null;
  const awayParkAdjEra = awayEraVal != null && awayEffRun != null ? awayEraVal / awayEffRun : null;
  const homeParkAdjEra = homeEraVal != null && homeEffRun != null ? homeEraVal / homeEffRun : null;
  const awayParkAdjWhip = awayWhipVal != null && awayWhipScale != null ? awayWhipVal / awayWhipScale : null;
  const homeParkAdjWhip = homeWhipVal != null && homeWhipScale != null ? homeWhipVal / homeWhipScale : null;

  // 3. Lineup-weighted platoon & top-of-order.
  const awayLineupPlatoonOps = num(awayLineup?.platoonOps, null);
  const homeLineupPlatoonOps = num(homeLineup?.platoonOps, null);
  const awayLineupPlatoonWoba = num(awayLineup?.platoonWoba, null);
  const homeLineupPlatoonWoba = num(homeLineup?.platoonWoba, null);
  const awayLineupPlatoonOpsDelta = num(awayLineup?.platoonOpsDelta, null);
  const homeLineupPlatoonOpsDelta = num(homeLineup?.platoonOpsDelta, null);
  const awayLineupPlatoonWobaDelta = num(awayLineup?.platoonWobaDelta, null);
  const homeLineupPlatoonWobaDelta = num(homeLineup?.platoonWobaDelta, null);
  const awayLineupTopOrderOps = num(awayLineup?.topOrderOps, null);
  const homeLineupTopOrderOps = num(homeLineup?.topOrderOps, null);

  // 4. Continuous projected starter IP & bullpen relief quality.
  const awayIsOpener = detectOpenerFlag(
    teams.away,
    teams.away?.probablePitcher,
    awayPitcher,
    Boolean(raw.openerSituations?.away?.isOpener)
  );
  const homeIsOpener = detectOpenerFlag(
    teams.home,
    teams.home?.probablePitcher,
    homePitcher,
    Boolean(raw.openerSituations?.home?.isOpener)
  );
  const officialDate = game.officialDate || null;
  const awayStarterProjectedIp = computeProjectedStarterIp(
    awayPitcher,
    awayPitcherRecent,
    awayIsOpener,
    officialDate
  );
  const homeStarterProjectedIp = computeProjectedStarterIp(
    homePitcher,
    homePitcherRecent,
    homeIsOpener,
    officialDate
  );
  const awayStarterShare =
    awayStarterProjectedIp != null ? Math.round((awayStarterProjectedIp / 9) * 10000) / 10000 : null;
  const homeStarterShare =
    homeStarterProjectedIp != null ? Math.round((homeStarterProjectedIp / 9) * 10000) / 10000 : null;
  const awayBullpenReliefEra = num(awayBullpen?.reliefEra, null);
  const homeBullpenReliefEra = num(homeBullpen?.reliefEra, null);
  const awayBullpenReliefWhip = num(awayBullpen?.reliefWhip, null);
  const homeBullpenReliefWhip = num(homeBullpen?.reliefWhip, null);

  // 5. Statcast / expected metrics & travel/jet-lag fatigue (optional/nullable).
  const statcastTeams = raw.statcast?.teams || null;
  const statcastPitchers = raw.statcast?.pitchers || null;
  const awayStatcastTeam = at(statcastTeams, awayId);
  const homeStatcastTeam = at(statcastTeams, homeId);
  const awayStatcastPitcher = at(statcastPitchers, awayPitcherId);
  const homeStatcastPitcher = at(statcastPitchers, homePitcherId);

  const awayTeamXwoba = num(awayStatcastTeam?.xwoba ?? awayStats?.xwoba ?? awayStats?.hitting?.xwoba, null);
  const homeTeamXwoba = num(homeStatcastTeam?.xwoba ?? homeStats?.xwoba ?? homeStats?.hitting?.xwoba, null);
  const awayTeamBarrelRate = num(awayStatcastTeam?.barrelRate ?? awayStats?.barrelRate ?? awayStats?.hitting?.barrelRate, null);
  const homeTeamBarrelRate = num(homeStatcastTeam?.barrelRate ?? homeStats?.barrelRate ?? homeStats?.hitting?.barrelRate, null);
  const awayStarterXera = num(awayStatcastPitcher?.xera ?? awayPitcher?.xera ?? awayPitcher?.expectedEra, null);
  const homeStarterXera = num(homeStatcastPitcher?.xera ?? homePitcher?.xera ?? homePitcher?.expectedEra, null);

  const awayTravelMiles = num(awaySched?.travelMiles ?? awaySched?.milesTraveled, null);
  const homeTravelMiles = num(homeSched?.travelMiles ?? homeSched?.milesTraveled, null);
  const awayTimezoneShift = num(awaySched?.timezoneShiftHours ?? awaySched?.timezoneShift, null);
  const homeTimezoneShift = num(homeSched?.timezoneShiftHours ?? homeSched?.timezoneShift, null);
  const awayTravelFatigueScore = num(awaySched?.fatigueScore ?? awaySched?.travelFatigueScore, null);
  const homeTravelFatigueScore = num(homeSched?.fatigueScore ?? homeSched?.travelFatigueScore, null);

  // 6. Explicit domain interaction terms.
  let platoonDeltaDiff = null;
  if (homeLineupPlatoonWobaDelta != null && awayLineupPlatoonWobaDelta != null) {
    platoonDeltaDiff = homeLineupPlatoonWobaDelta - awayLineupPlatoonWobaDelta;
  } else if (homeLineupPlatoonOpsDelta != null && awayLineupPlatoonOpsDelta != null) {
    platoonDeltaDiff = (homeLineupPlatoonOpsDelta - awayLineupPlatoonOpsDelta) * 0.43;
  }

  const awayStarterHr9Val = baseV1.awayStarterHr9.value;
  const homeStarterHr9Val = baseV1.homeStarterHr9.value;
  let flyballParkWindIndex = null;
  if (
    awayStarterHr9Val != null &&
    homeStarterHr9Val != null &&
    (gameParkHrFactor != null || windOutV2 != null || windInV2 != null)
  ) {
    const parkTerm = gameParkHrFactor != null ? gameParkHrFactor - 1.0 : 0.0;
    const speedEff = windSpeedV2 != null ? windSpeedV2 : 8.0;
    const windTerm =
      ((windOutV2 ? 1 : 0) - (windInV2 ? 1 : 0)) * (speedEff / 100.0);
    flyballParkWindIndex = (awayStarterHr9Val - homeStarterHr9Val) * (parkTerm + windTerm);
  }

  const { featureVectorHash: _v1Hash, ...baseBody } = baseV1;
  const vectorV2 = {
    ...baseBody,
    schemaVersion: FEATURE_VECTOR_V2_SCHEMA_VERSION,
    windHittingOut: withMissing(windOutV2 == null ? null : windOutV2 ? 1 : 0),

    // v2.0 Market timing
    leadTimeMinutes: withMissing(leadTimeMinutes),

    // v2.0 Park factors & park-adjusted stats
    gameParkRunFactor: withMissing(gameParkRunFactor),
    gameParkHrFactor: withMissing(gameParkHrFactor),
    awayHomeParkEffRunFactor: withMissing(awayEffRun),
    homeHomeParkEffRunFactor: withMissing(homeEffRun),
    awayParkAdjRpg: withMissing(awayParkAdjRpg),
    homeParkAdjRpg: withMissing(homeParkAdjRpg),
    awayParkAdjOps: withMissing(awayParkAdjOps),
    homeParkAdjOps: withMissing(homeParkAdjOps),
    awayParkAdjEra: withMissing(awayParkAdjEra),
    homeParkAdjEra: withMissing(homeParkAdjEra),
    awayParkAdjWhip: withMissing(awayParkAdjWhip),
    homeParkAdjWhip: withMissing(homeParkAdjWhip),

    // v2.0 Lineup-weighted platoon & top-of-order
    awayLineupPlatoonOps: withMissing(awayLineupPlatoonOps),
    homeLineupPlatoonOps: withMissing(homeLineupPlatoonOps),
    awayLineupPlatoonWoba: withMissing(awayLineupPlatoonWoba),
    homeLineupPlatoonWoba: withMissing(homeLineupPlatoonWoba),
    awayLineupPlatoonOpsDelta: withMissing(awayLineupPlatoonOpsDelta),
    homeLineupPlatoonOpsDelta: withMissing(homeLineupPlatoonOpsDelta),
    awayLineupPlatoonWobaDelta: withMissing(awayLineupPlatoonWobaDelta),
    homeLineupPlatoonWobaDelta: withMissing(homeLineupPlatoonWobaDelta),
    awayLineupTopOrderOps: withMissing(awayLineupTopOrderOps),
    homeLineupTopOrderOps: withMissing(homeLineupTopOrderOps),

    // v2.0 Continuous projected starter IP & bullpen relief quality
    awayStarterProjectedIp: withMissing(awayStarterProjectedIp),
    homeStarterProjectedIp: withMissing(homeStarterProjectedIp),
    awayStarterShare: withMissing(awayStarterShare),
    homeStarterShare: withMissing(homeStarterShare),
    awayBullpenReliefEra: withMissing(awayBullpenReliefEra),
    homeBullpenReliefEra: withMissing(homeBullpenReliefEra),
    awayBullpenReliefWhip: withMissing(awayBullpenReliefWhip),
    homeBullpenReliefWhip: withMissing(homeBullpenReliefWhip),

    // v2.0 Statcast / expected metrics & travel/jet-lag fatigue
    awayTeamXwoba: withMissing(awayTeamXwoba),
    homeTeamXwoba: withMissing(homeTeamXwoba),
    awayTeamBarrelRate: withMissing(awayTeamBarrelRate),
    homeTeamBarrelRate: withMissing(homeTeamBarrelRate),
    awayStarterXera: withMissing(awayStarterXera),
    homeStarterXera: withMissing(homeStarterXera),
    awayTravelMiles: withMissing(awayTravelMiles),
    homeTravelMiles: withMissing(homeTravelMiles),
    awayTimezoneShift: withMissing(awayTimezoneShift),
    homeTimezoneShift: withMissing(homeTimezoneShift),
    awayTravelFatigueScore: withMissing(awayTravelFatigueScore),
    homeTravelFatigueScore: withMissing(homeTravelFatigueScore),

    // v2.0 Explicit domain interactions
    platoonDeltaDiff: withMissing(platoonDeltaDiff),
    flyballParkWindIndex: withMissing(flyballParkWindIndex)
  };

  vectorV2.featureVectorHash = hashFeatureVector(vectorV2);
  return vectorV2;
}

function stableStringify(value) {
  if (value === undefined) {
    return 'null';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Hash a feature vector. Covers schema, values, and missingness — never
 * outcomes. Used for dedup and dataset integrity.
 */
export function hashFeatureVector(vector) {
  const { featureVectorHash: _omit, ...body } = vector;
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

/**
 * Flatten the nested {value, missing} pairs into a simple numeric object for
 * Python/CSV consumption. Missing values become null; missingness flags become
 * `missing_<feature>` columns.
 */
export function flattenFeatureVector(vector) {
  const flat = {
    schemaVersion: vector.schemaVersion,
    featureSchemaVersion: vector.featureSchemaVersion,
    gamePk: vector.gamePk,
    awayTeamId: vector.awayTeamId,
    homeTeamId: vector.homeTeamId,
    venueId: vector.venueId,
    officialDate: vector.officialDate,
    featureVectorHash: vector.featureVectorHash
  };
  for (const [key, cell] of Object.entries(vector)) {
    if (['schemaVersion', 'featureSchemaVersion', 'gamePk', 'awayTeamId', 'homeTeamId', 'venueId', 'officialDate', 'featureVectorHash'].includes(key)) {
      continue;
    }
    if (cell && typeof cell === 'object' && 'value' in cell) {
      flat[key] = cell.value;
      flat[`missing_${key}`] = cell.missing;
    } else {
      flat[key] = cell;
    }
  }
  return flat;
}

/**
 * Classify an information state from actual timestamps + lineup confirmation.
 * Classification is metadata; it never changes control scoring.
 *
 *   scheduled_early   — far from first pitch, lineups not confirmed
 *   projected_lineup  — lineups present but not confirmed
 *   confirmed_lineup  — both lineups confirmed
 *   close_time        — within CLOSE_TIME_HOURS of first pitch
 *   ineligible        — as_of >= first_pitch (post-pitch)
 */
export const CLOSE_TIME_HOURS = 2;

export function classifyInformationState({ asOfUtc, firstPitchUtc, lineupsConfirmed }) {
  if (!asOfUtc || !firstPitchUtc) return 'ineligible';
  const asOf = Date.parse(asOfUtc);
  const firstPitch = Date.parse(firstPitchUtc);
  if (!Number.isFinite(asOf) || !Number.isFinite(firstPitch)) return 'ineligible';
  if (asOf >= firstPitch) return 'ineligible';
  const hoursBefore = (firstPitch - asOf) / 3.6e6;
  if (hoursBefore <= CLOSE_TIME_HOURS) return 'close_time';
  if (lineupsConfirmed === true) return 'confirmed_lineup';
  if (lineupsConfirmed === false) return 'projected_lineup';
  return 'scheduled_early';
}
