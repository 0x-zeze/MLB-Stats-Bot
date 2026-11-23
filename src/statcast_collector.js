/**
 * Live Baseball Savant (Statcast) leaderboard collector — free public CSV
 * endpoints (no API key required).
 *
 * Populates the 6 Statcast slots in Feature Vector v2.0:
 *   - statcast.teams[teamId]     = { xwoba, barrelRate, pa, source }
 *   - statcast.pitchers[pitchId] = { xera, xwobaAllowed, pa, source }
 *
 * Design invariants:
 *   - Pure JS RFC-4180 CSV parser (handles quoted "Last, First" names).
 *   - Resilient column aliases across Savant schema updates.
 *   - Early-season Bayesian continuity: blends low-PA current-season numbers
 *     smoothly with prior-season Savant metrics (never fabricates league
 *     averages when BOTH current and prior are absent).
 *   - Bounded timeout + in-memory TTL cache (3h default) + graceful empty
 *     fallback so a Savant outage NEVER blocks or degrades live predictions.
 */

import { clamp } from './utils.js';
import { MLB_TEAM_STADIUMS } from './mlb_stadiums.js';

const SAVANT_BASE = 'https://baseballsavant.mlb.com/leaderboard';
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

const _cache = new Map();

// Build lookup tables mapping team abbreviations / city / names -> MLB teamId.
const TEAM_LOOKUP = new Map();
for (const entry of Object.values(MLB_TEAM_STADIUMS)) {
  TEAM_LOOKUP.set(String(entry.teamId), entry.teamId);
  TEAM_LOOKUP.set(entry.abbr.toUpperCase(), entry.teamId);
  TEAM_LOOKUP.set(entry.city.toUpperCase(), entry.teamId);
}
// Common Baseball Savant / MLB team abbreviation & name aliases.
const EXTRA_TEAM_ALIASES = {
  OAK: 133,
  ATH: 133,
  AZ: 109,
  ARI: 109,
  CHW: 145,
  CWS: 145,
  WSN: 120,
  WSH: 120,
  KCR: 118,
  KC: 118,
  SDP: 135,
  SD: 135,
  SFG: 137,
  SF: 137,
  TBR: 139,
  TB: 139,
  'ANGELS': 108,
  'DIAMONDBACKS': 109,
  'D-BACKS': 109,
  'ORIOLES': 110,
  'RED SOX': 111,
  'CUBS': 112,
  'REDS': 113,
  'GUARDIANS': 114,
  'ROCKIES': 115,
  'TIGERS': 116,
  'ASTROS': 117,
  'ROYALS': 118,
  'DODGERS': 119,
  'NATIONALS': 120,
  'METS': 121,
  'ATHLETICS': 133,
  'PIRATES': 134,
  'PADRES': 135,
  'MARINERS': 136,
  'GIANTS': 137,
  'CARDINALS': 138,
  'RAYS': 139,
  'RANGERS': 140,
  'BLUE JAYS': 141,
  'TWINS': 142,
  'PHILLIES': 143,
  'BRAVES': 144,
  'WHITE SOX': 145,
  'MARLINS': 146,
  'YANKEES': 147,
  'BREWERS': 158
};
for (const [alias, id] of Object.entries(EXTRA_TEAM_ALIASES)) {
  TEAM_LOOKUP.set(alias, id);
}

/**
 * RFC-4180 compliant CSV parser supporting quoted fields with embedded commas
 * and escaped double-quotes (""). Strips UTF-8 BOM if present.
 */
export function parseStatcastCsv(csvText) {
  if (typeof csvText !== 'string' || !csvText.trim()) return [];
  const text = csvText.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r') {
      continue;
    } else if (ch === '\n') {
      row.push(field.trim());
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    if (row.some((cell) => cell.length > 0)) rows.push(row);
  }
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const records = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    const obj = {};
    for (let c = 0; c < headers.length; c += 1) {
      obj[headers[c]] = cells[c] ?? '';
    }
    records.push(obj);
  }
  return records;
}

function finiteNum(value) {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = typeof value === 'string' ? value.replace(/%$/, '').trim() : value;
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function firstFinite(row, keys) {
  for (const k of keys) {
    const v = finiteNum(row[k]);
    if (v !== null) return v;
  }
  return null;
}

function normalizeRate(value) {
  if (value === null) return null;
  // Convert percentage scale (e.g. 9.8 -> 0.098) to decimal rate [0, 1].
  const rate = value > 1 ? value / 100 : value;
  return rate >= 0 && rate <= 1 ? Math.round(rate * 10000) / 10000 : null;
}

export function resolveSavantTeamId(row) {
  if (!row || typeof row !== 'object') return null;
  const idCandidates = [row.team_id, row.entity_id, row.id];
  for (const raw of idCandidates) {
    const n = finiteNum(raw);
    if (n !== null && MLB_TEAM_STADIUMS[n]) return n;
  }
  const textCandidates = [
    row.team_abbrev,
    row.team,
    row.entity_code,
    row.entity_name,
    row.team_name,
    row.name
  ];
  for (const raw of textCandidates) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const upper = raw.trim().toUpperCase();
    if (TEAM_LOOKUP.has(upper)) return TEAM_LOOKUP.get(upper);
    for (const [alias, id] of Object.entries(EXTRA_TEAM_ALIASES)) {
      if (alias.length >= 4 && upper.includes(alias)) return id;
    }
  }
  return null;
}

/**
 * Parse Savant expected-statistics + statcast-barrels CSVs into team metrics:
 *   Map<teamId, { xwoba, barrelRate, pa }>
 */
export function parseTeamStatcastTables(expectedCsvText, barrelsCsvText = '') {
  const byTeam = new Map();

  for (const row of parseStatcastCsv(expectedCsvText)) {
    const teamId = resolveSavantTeamId(row);
    if (!teamId) continue;
    const xwoba = firstFinite(row, ['est_woba', 'xwoba', 'expected_woba']);
    const pa = firstFinite(row, ['pa', 'plate_appearances', 'bip']) ?? 0;
    const barrelRaw = firstFinite(row, ['brl_percent', 'barrel_batted_rate', 'barrel_pct', 'barrel_rate']);
    const existing = byTeam.get(teamId) || { xwoba: null, barrelRate: null, pa: 0 };
    if (xwoba !== null && xwoba > 0.15 && xwoba < 0.6) {
      existing.xwoba = Math.round(xwoba * 10000) / 10000;
    }
    if (barrelRaw !== null) {
      const rate = normalizeRate(barrelRaw);
      if (rate !== null) existing.barrelRate = rate;
    }
    if (pa > existing.pa) existing.pa = pa;
    byTeam.set(teamId, existing);
  }

  for (const row of parseStatcastCsv(barrelsCsvText)) {
    const teamId = resolveSavantTeamId(row);
    if (!teamId) continue;
    const barrelRaw = firstFinite(row, ['brl_percent', 'barrel_batted_rate', 'barrel_pct', 'barrel_rate']);
    const pa = firstFinite(row, ['attempts', 'bip', 'pa']) ?? 0;
    const existing = byTeam.get(teamId) || { xwoba: null, barrelRate: null, pa: 0 };
    if (barrelRaw !== null) {
      const rate = normalizeRate(barrelRaw);
      if (rate !== null) existing.barrelRate = rate;
    }
    if (pa > existing.pa) existing.pa = pa;
    byTeam.set(teamId, existing);
  }

  return byTeam;
}

/**
 * Parse Savant pitcher expected-statistics CSV into pitcher metrics:
 *   Map<playerId, { xera, xwobaAllowed, pa }>
 */
export function parsePitcherStatcastTable(expectedCsvText) {
  const byPitcher = new Map();

  for (const row of parseStatcastCsv(expectedCsvText)) {
    const playerId = firstFinite(row, ['player_id', 'entity_id', 'mlbam_id']);
    if (!playerId) continue;
    const xera = firstFinite(row, ['xera', 'est_era', 'expected_era']);
    const xwobaAllowed = firstFinite(row, ['est_woba', 'xwoba', 'expected_woba']);
    const pa = firstFinite(row, ['pa', 'bf', 'bip']) ?? 0;
    if (xera === null && xwobaAllowed === null) continue;
    byPitcher.set(Math.trunc(playerId), {
      xera: xera !== null && xera > 0.5 && xera < 15 ? Math.round(xera * 1000) / 1000 : null,
      xwobaAllowed:
        xwobaAllowed !== null && xwobaAllowed > 0.15 && xwobaAllowed < 0.6
          ? Math.round(xwobaAllowed * 10000) / 10000
          : null,
      pa
    });
  }

  return byPitcher;
}

/**
 * Smooth Bayesian early-season blend between current-season and prior-season
 * Statcast maps. Never fabricates values when both seasons are absent.
 */
export function blendStatcastBundle(currentBundle, priorBundle = null, { teamPriorPa = 650, pitcherPriorPa = 120 } = {}) {
  const teams = {};
  const pitchers = {};

  const curTeams = currentBundle?.teams instanceof Map ? currentBundle.teams : new Map();
  const priTeams = priorBundle?.teams instanceof Map ? priorBundle.teams : new Map();
  const allTeamIds = new Set([...curTeams.keys(), ...priTeams.keys()]);

  for (const teamId of allTeamIds) {
    const cur = curTeams.get(teamId) || null;
    const pri = priTeams.get(teamId) || null;
    const curPa = Math.max(0, cur?.pa ?? 0);
    const w = curPa > 0 ? clamp(curPa / (curPa + teamPriorPa), 0, 1) : 0;

    const blendField = (cVal, pVal, decimals = 4) => {
      if (cVal !== null && cVal !== undefined && pVal !== null && pVal !== undefined) {
        const mult = 10 ** decimals;
        return Math.round((w * cVal + (1 - w) * pVal) * mult) / mult;
      }
      if (cVal !== null && cVal !== undefined) return cVal;
      if (pVal !== null && pVal !== undefined) return pVal;
      return null;
    };

    const xwoba = blendField(cur?.xwoba, pri?.xwoba, 4);
    const barrelRate = blendField(cur?.barrelRate, pri?.barrelRate, 4);
    if (xwoba !== null || barrelRate !== null) {
      teams[String(teamId)] = {
        xwoba,
        barrelRate,
        pa: curPa,
        source: cur && pri && w < 0.99 ? 'blended_prior' : cur ? 'current' : 'prior_only'
      };
    }
  }

  const curPitchers = currentBundle?.pitchers instanceof Map ? currentBundle.pitchers : new Map();
  const priPitchers = priorBundle?.pitchers instanceof Map ? priorBundle.pitchers : new Map();
  const allPitcherIds = new Set([...curPitchers.keys(), ...priPitchers.keys()]);

  for (const pid of allPitcherIds) {
    const cur = curPitchers.get(pid) || null;
    const pri = priPitchers.get(pid) || null;
    const curPa = Math.max(0, cur?.pa ?? 0);
    const w = curPa > 0 ? clamp(curPa / (curPa + pitcherPriorPa), 0, 1) : 0;

    const blendField = (cVal, pVal, decimals = 3) => {
      if (cVal !== null && cVal !== undefined && pVal !== null && pVal !== undefined) {
        const mult = 10 ** decimals;
        return Math.round((w * cVal + (1 - w) * pVal) * mult) / mult;
      }
      if (cVal !== null && cVal !== undefined) return cVal;
      if (pVal !== null && pVal !== undefined) return pVal;
      return null;
    };

    const xera = blendField(cur?.xera, pri?.xera, 3);
    const xwobaAllowed = blendField(cur?.xwobaAllowed, pri?.xwobaAllowed, 4);
    if (xera !== null || xwobaAllowed !== null) {
      pitchers[String(pid)] = {
        xera,
        xwobaAllowed,
        pa: curPa,
        source: cur && pri && w < 0.99 ? 'blended_prior' : cur ? 'current' : 'prior_only'
      };
    }
  }

  return { teams, pitchers };
}

/**
 * Filter a full league Statcast bundle down to a single game's teams & probable
 * starters so frozen prediction snapshots remain compact.
 */
export function sliceGameStatcast(bundle, { awayTeamId, homeTeamId, awayPitcherId, homePitcherId } = {}) {
  if (!bundle || typeof bundle !== 'object') return null;
  const teams = {};
  const pitchers = {};
  for (const tid of [awayTeamId, homeTeamId]) {
    if (tid != null && bundle.teams?.[String(tid)]) {
      teams[String(tid)] = bundle.teams[String(tid)];
    }
  }
  for (const pid of [awayPitcherId, homePitcherId]) {
    if (pid != null && bundle.pitchers?.[String(pid)]) {
      pitchers[String(pid)] = bundle.pitchers[String(pid)];
    }
  }
  if (Object.keys(teams).length === 0 && Object.keys(pitchers).length === 0) {
    return null;
  }
  return { teams, pitchers };
}

async function fetchCsvText(url, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MLB-Stats-Bot/1.0 (statcast-research)',
        Accept: 'text/csv,text/plain,*/*'
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSeasonStatcastRaw(season, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const urls = {
    teamExpected: `${SAVANT_BASE}/expected_statistics?type=batter-team&year=${season}&position=&team=&min=1&csv=true`,
    teamBarrels: `${SAVANT_BASE}/statcast?type=batter-team&year=${season}&position=&team=&min=1&csv=true`,
    pitcherExpected: `${SAVANT_BASE}/expected_statistics?type=pitcher&year=${season}&position=&team=&min=1&csv=true`
  };
  const [teamExpCsv, teamBrlCsv, pitcherExpCsv] = await Promise.all([
    fetchCsvText(urls.teamExpected, fetchImpl, timeoutMs).catch(() => ''),
    fetchCsvText(urls.teamBarrels, fetchImpl, timeoutMs).catch(() => ''),
    fetchCsvText(urls.pitcherExpected, fetchImpl, timeoutMs).catch(() => '')
  ]);
  return {
    teams: parseTeamStatcastTables(teamExpCsv, teamBrlCsv),
    pitchers: parsePitcherStatcastTable(pitcherExpCsv)
  };
}

export function _clearStatcastCache() {
  _cache.clear();
}

/**
 * Fetch cached Baseball Savant Statcast bundle for `season` (with automatic
 * prior-season shrinkage early in the season). Returns `{ teams, pitchers }`.
 */
export async function fetchLiveStatcastBundle(
  season,
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    includePriorBlend = true,
    nowMs = Date.now()
  } = {}
) {
  const yr = Number(season);
  if (!Number.isInteger(yr) || yr < 2015) {
    return { teams: {}, pitchers: {} };
  }
  const cacheKey = `${yr}:${includePriorBlend ? 'blend' : 'cur'}`;
  const cached = _cache.get(cacheKey);
  if (cached && nowMs - cached.fetchedAt < cacheTtlMs) {
    return cached.value;
  }

  const currentRaw = await fetchSeasonStatcastRaw(yr, { fetchImpl, timeoutMs });
  let priorRaw = null;
  if (includePriorBlend) {
    const maxTeamPa = Math.max(0, ...[...currentRaw.teams.values()].map((t) => t.pa || 0));
    const needsPrior = currentRaw.teams.size === 0 || maxTeamPa < 2200 || currentRaw.pitchers.size < 100;
    if (needsPrior) {
      priorRaw = await fetchSeasonStatcastRaw(yr - 1, { fetchImpl, timeoutMs }).catch(() => null);
    }
  }

  const blended = blendStatcastBundle(currentRaw, priorRaw);
  _cache.set(cacheKey, { fetchedAt: nowMs, value: blended });
  return blended;
}
