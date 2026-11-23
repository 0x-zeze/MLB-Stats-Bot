/**
 * Static MLB stadium geospatial & in-season timezone metadata + pure travel
 * fatigue calculation (zero external API requests).
 *
 * Uses in-season MLB UTC offsets (April-October):
 *   EDT = -4, CDT = -5, MDT = -6, MST (Arizona, no DST) = -7, PDT = -7.
 *
 * Feeds directly into scheduleFatigueProfiles -> coreInputs ->
 * buildFeatureVectorV2 (awayTravelMiles, homeTravelMiles, awayTimezoneShift,
 * homeTimezoneShift, awayTravelFatigueScore, homeTravelFatigueScore).
 */

import { clamp } from './utils.js';

const EARTH_RADIUS_MILES = 3958.7613;

export const MLB_TEAM_STADIUMS = {
  108: { teamId: 108, abbr: 'LAA', city: 'Anaheim', stadium: 'Angel Stadium', lat: 33.8003, lon: -117.8827, tzOffset: -7 },
  109: { teamId: 109, abbr: 'ARI', city: 'Phoenix', stadium: 'Chase Field', lat: 33.4455, lon: -112.0667, tzOffset: -7 },
  110: { teamId: 110, abbr: 'BAL', city: 'Baltimore', stadium: 'Camden Yards', lat: 39.2839, lon: -76.6217, tzOffset: -4 },
  111: { teamId: 111, abbr: 'BOS', city: 'Boston', stadium: 'Fenway Park', lat: 42.3467, lon: -71.0972, tzOffset: -4 },
  112: { teamId: 112, abbr: 'CHC', city: 'Chicago', stadium: 'Wrigley Field', lat: 41.9484, lon: -87.6553, tzOffset: -5 },
  113: { teamId: 113, abbr: 'CIN', city: 'Cincinnati', stadium: 'Great American Ball Park', lat: 39.0979, lon: -84.5082, tzOffset: -4 },
  114: { teamId: 114, abbr: 'CLE', city: 'Cleveland', stadium: 'Progressive Field', lat: 41.4962, lon: -81.6852, tzOffset: -4 },
  115: { teamId: 115, abbr: 'COL', city: 'Denver', stadium: 'Coors Field', lat: 39.7559, lon: -104.9942, tzOffset: -6 },
  116: { teamId: 116, abbr: 'DET', city: 'Detroit', stadium: 'Comerica Park', lat: 42.3390, lon: -83.0485, tzOffset: -4 },
  117: { teamId: 117, abbr: 'HOU', city: 'Houston', stadium: 'Daikin Park', lat: 29.7573, lon: -95.3555, tzOffset: -5 },
  118: { teamId: 118, abbr: 'KC', city: 'Kansas City', stadium: 'Kauffman Stadium', lat: 39.0517, lon: -94.4803, tzOffset: -5 },
  119: { teamId: 119, abbr: 'LAD', city: 'Los Angeles', stadium: 'Dodger Stadium', lat: 34.0739, lon: -118.2400, tzOffset: -7 },
  120: { teamId: 120, abbr: 'WSH', city: 'Washington', stadium: 'Nationals Park', lat: 38.8730, lon: -77.0074, tzOffset: -4 },
  121: { teamId: 121, abbr: 'NYM', city: 'New York', stadium: 'Citi Field', lat: 40.7571, lon: -73.8458, tzOffset: -4 },
  133: { teamId: 133, abbr: 'ATH', city: 'West Sacramento', stadium: 'Sutter Health Park', lat: 38.5804, lon: -121.5138, tzOffset: -7 },
  134: { teamId: 134, abbr: 'PIT', city: 'Pittsburgh', stadium: 'PNC Park', lat: 40.4469, lon: -80.0057, tzOffset: -4 },
  135: { teamId: 135, abbr: 'SD', city: 'San Diego', stadium: 'Petco Park', lat: 32.7076, lon: -117.1570, tzOffset: -7 },
  136: { teamId: 136, abbr: 'SEA', city: 'Seattle', stadium: 'T-Mobile Park', lat: 47.5914, lon: -122.3325, tzOffset: -7 },
  137: { teamId: 137, abbr: 'SF', city: 'San Francisco', stadium: 'Oracle Park', lat: 37.7786, lon: -122.3893, tzOffset: -7 },
  138: { teamId: 138, abbr: 'STL', city: 'St. Louis', stadium: 'Busch Stadium', lat: 38.6226, lon: -90.1928, tzOffset: -5 },
  139: { teamId: 139, abbr: 'TB', city: 'Tampa Bay', stadium: 'Tampa Bay Ballpark', lat: 27.9803, lon: -82.5067, tzOffset: -4 },
  140: { teamId: 140, abbr: 'TEX', city: 'Arlington', stadium: 'Globe Life Field', lat: 32.7473, lon: -97.0842, tzOffset: -5 },
  141: { teamId: 141, abbr: 'TOR', city: 'Toronto', stadium: 'Rogers Centre', lat: 43.6414, lon: -79.3894, tzOffset: -4 },
  142: { teamId: 142, abbr: 'MIN', city: 'Minneapolis', stadium: 'Target Field', lat: 44.9817, lon: -93.2776, tzOffset: -5 },
  143: { teamId: 143, abbr: 'PHI', city: 'Philadelphia', stadium: 'Citizens Bank Park', lat: 39.9061, lon: -75.1665, tzOffset: -4 },
  144: { teamId: 144, abbr: 'ATL', city: 'Atlanta', stadium: 'Truist Park', lat: 33.8907, lon: -84.4677, tzOffset: -4 },
  145: { teamId: 145, abbr: 'CWS', city: 'Chicago', stadium: 'Rate Field', lat: 41.8299, lon: -87.6338, tzOffset: -5 },
  146: { teamId: 146, abbr: 'MIA', city: 'Miami', stadium: 'loanDepot park', lat: 25.7781, lon: -80.2197, tzOffset: -4 },
  147: { teamId: 147, abbr: 'NYY', city: 'New York', stadium: 'Yankee Stadium', lat: 40.8296, lon: -73.9262, tzOffset: -4 },
  158: { teamId: 158, abbr: 'MIL', city: 'Milwaukee', stadium: 'American Family Field', lat: 43.0280, lon: -87.9712, tzOffset: -5 }
};

// Special/international neutral-site MLB venues (resolved before homeTeamId fallback).
export const MLB_SPECIAL_VENUES = {
  2523: { city: 'Tampa', stadium: 'George M. Steinbrenner Field', lat: 27.9803, lon: -82.5067, tzOffset: -4 },
  2529: { city: 'West Sacramento', stadium: 'Sutter Health Park', lat: 38.5804, lon: -121.5138, tzOffset: -7 },
  2724: { city: 'Tokyo', stadium: 'Tokyo Dome', lat: 35.7056, lon: 139.7519, tzOffset: 9 },
  5381: { city: 'London', stadium: 'London Stadium', lat: 51.5387, lon: -0.0166, tzOffset: 1 },
  5385: { city: 'Mexico City', stadium: 'Estadio Alfredo Harp Helu', lat: 19.4036, lon: -99.0846, tzOffset: -6 }
};

const ABBR_INDEX = Object.fromEntries(
  Object.values(MLB_TEAM_STADIUMS).map((s) => [s.abbr, s])
);
ABBR_INDEX.OAK = MLB_TEAM_STADIUMS[133];
ABBR_INDEX.AZ = MLB_TEAM_STADIUMS[109];
ABBR_INDEX.CHW = MLB_TEAM_STADIUMS[145];

/**
 * Resolve stadium geospatial + in-season UTC offset from venueId, homeTeamId, or teamAbbr.
 */
export function lookupStadium({ venueId = null, homeTeamId = null, teamAbbr = null } = {}) {
  if (venueId != null && MLB_SPECIAL_VENUES[Number(venueId)]) {
    return MLB_SPECIAL_VENUES[Number(venueId)];
  }
  if (homeTeamId != null && MLB_TEAM_STADIUMS[Number(homeTeamId)]) {
    return MLB_TEAM_STADIUMS[Number(homeTeamId)];
  }
  if (typeof teamAbbr === 'string' && teamAbbr.trim()) {
    const key = teamAbbr.trim().toUpperCase();
    if (ABBR_INDEX[key]) return ABBR_INDEX[key];
  }
  return null;
}

/**
 * Great-circle Haversine distance in statute miles (rounded to 0.1 mi).
 */
export function haversineMiles(lat1, lon1, lat2, lon2) {
  if (
    !Number.isFinite(lat1) || !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) || !Number.isFinite(lon2)
  ) {
    return null;
  }
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return Math.round(EARTH_RADIUS_MILES * c * 10) / 10;
}

function localStartHour(isoUtc, tzOffset) {
  if (!isoUtc || typeof isoUtc !== 'string' || !Number.isFinite(tzOffset)) return null;
  const ms = Date.parse(isoUtc);
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + tzOffset * 3600000);
  return shifted.getUTCHours() + shifted.getUTCMinutes() / 60;
}

function calendarDayDiff(targetYmd, earlierYmd) {
  if (!targetYmd || !earlierYmd) return null;
  const t = Date.parse(`${targetYmd}T00:00:00Z`);
  const e = Date.parse(`${earlierYmd}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(e)) return null;
  return Math.round((t - e) / 86400000);
}

/**
 * Compute observed MLB travel & jet-lag metrics from a team's recent completed
 * games (newest first) and today's scheduled game. Returns nulls when stadium
 * metadata is unavailable (never fabricates travel on minimal test fixtures).
 */
export function computeTravelFatigueContext(recentGamesSortedNewestFirst, todayGameInfo, dateYmd) {
  const empty = {
    travelMiles: null,
    legTravelMiles: null,
    timezoneShiftHours: null,
    travelDirection: null,
    dayAfterNight: false,
    travelFatigueScore: null
  };
  if (!todayGameInfo || !Array.isArray(recentGamesSortedNewestFirst) || recentGamesSortedNewestFirst.length === 0) {
    return empty;
  }

  const dest = lookupStadium({
    venueId: todayGameInfo.venueId,
    homeTeamId: todayGameInfo.homeTeamId,
    teamAbbr: todayGameInfo.homeAbbr
  });
  const lastGame = recentGamesSortedNewestFirst[0];
  const prev = lookupStadium({
    venueId: lastGame?.venueId,
    homeTeamId: lastGame?.homeTeamId,
    teamAbbr: lastGame?.homeAbbr
  });
  if (!dest || !prev) {
    return empty;
  }

  const legMiles = haversineMiles(prev.lat, prev.lon, dest.lat, dest.lon);
  if (legMiles == null) return empty;

  // Cumulative travel miles over the last 3 days (including today's inbound leg).
  const last3DaysChrono = recentGamesSortedNewestFirst
    .filter((g) => {
      const diff = calendarDayDiff(dateYmd, g.date);
      return diff != null && diff >= 1 && diff <= 3;
    })
    .reverse();

  let cumulativeMiles = 0;
  if (last3DaysChrono.length > 0) {
    const stops = last3DaysChrono
      .map((g) => lookupStadium({ venueId: g.venueId, homeTeamId: g.homeTeamId, teamAbbr: g.homeAbbr }))
      .filter(Boolean);
    stops.push(dest);
    for (let i = 1; i < stops.length; i += 1) {
      const hop = haversineMiles(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon);
      if (hop != null) cumulativeMiles += hop;
    }
  } else {
    cumulativeMiles = legMiles;
  }
  const travelMiles = Math.round(cumulativeMiles * 10) / 10;

  // Signed timezone shift: positive = eastbound (sleep loss), negative = westbound.
  const timezoneShiftHours = dest.tzOffset - prev.tzOffset;
  const travelDirection =
    timezoneShiftHours > 0 ? 'east' : timezoneShiftHours < 0 ? 'west' : 'same';

  const dayDiff = calendarDayDiff(dateYmd, lastGame.date);
  const restDays = dayDiff != null ? Math.max(0, dayDiff - 1) : 1;

  // Day game after night game: played yesterday (>= 18:00 local) and plays today (< 16:00 local).
  const prevHour = localStartHour(lastGame.gameDate, prev.tzOffset);
  const todayHour = localStartHour(todayGameInfo.gameDate, dest.tzOffset);
  const dayAfterNight = Boolean(
    restDays === 0 &&
    prevHour != null &&
    todayHour != null &&
    prevHour >= 18 &&
    todayHour < 16
  );

  // Bounded [0, 1] travel fatigue score (higher = more fatigued), aligned with
  // src/travel_fatigue.py physiology (eastbound > westbound, coast-to-coast,
  // day-after-night, zero-rest flight, attenuated by off-day recovery).
  const zones = Math.abs(timezoneShiftHours);
  const eastbound = timezoneShiftHours > 0;
  const recoveryScale = restDays === 0 ? 1.0 : restDays === 1 ? 0.55 : 0.2;
  const rawScore =
    (Math.min(travelMiles, 3500) / 3500) * 0.35 +
    (Math.min(zones, 4) / 3) * (eastbound ? 0.35 : 0.22) +
    (zones >= 3 ? 0.10 : 0) +
    (dayAfterNight ? 0.25 : 0) +
    (legMiles >= 500 && restDays === 0 ? 0.10 : 0);

  const travelFatigueScore = Math.round(clamp(rawScore * recoveryScale, 0, 1) * 1000) / 1000;

  return {
    travelMiles,
    legTravelMiles: legMiles,
    timezoneShiftHours,
    travelDirection,
    dayAfterNight,
    travelFatigueScore
  };
}
