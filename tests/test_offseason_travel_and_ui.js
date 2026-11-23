import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MLB_TEAM_STADIUMS,
  computeTravelFatigueContext,
  haversineMiles,
  lookupStadium
} from '../src/mlb_stadiums.js';
import { __mlbTestInternals } from '../src/mlb.js';
import { buildFeatureVectorV2 } from '../src/core/feature_vector.js';

const { finalizeScheduleFatigueProfile } = __mlbTestInternals;

test('MLB_TEAM_STADIUMS covers all 30 MLB teams with valid in-season offsets', () => {
  const teams = Object.values(MLB_TEAM_STADIUMS);
  assert.equal(teams.length, 30);
  for (const t of teams) {
    assert.ok(t.lat > 24 && t.lat < 50, `unexpected lat for ${t.abbr}`);
    assert.ok(t.lon > -125 && t.lon < -70, `unexpected lon for ${t.abbr}`);
    assert.ok([-7, -6, -5, -4].includes(t.tzOffset), `unexpected in-season TZ for ${t.abbr}`);
  }
  // Arizona does not observe DST, so in-season MST = -7 (same as PDT).
  assert.equal(lookupStadium({ homeTeamId: 109 }).tzOffset, -7);
  // Neutral/international special venue takes priority over homeTeamId.
  assert.equal(lookupStadium({ venueId: 2724, homeTeamId: 119 }).city, 'Tokyo');
});

test('haversineMiles computes accurate great-circle distance', () => {
  const lad = lookupStadium({ homeTeamId: 119 });
  const nyy = lookupStadium({ homeTeamId: 147 });
  const miles = haversineMiles(lad.lat, lad.lon, nyy.lat, nyy.lon);
  assert.ok(miles > 2400 && miles < 2500, `expected LAD-NYY ~2445mi, got ${miles}`);
  assert.equal(haversineMiles(lad.lat, lad.lon, lad.lat, lad.lon), 0);
});

test('computeTravelFatigueContext penalizes eastbound coast-to-coast day-after-night more than westbound and attenuates on rest', () => {
  // LAD played night game at Dodger Stadium (2026-06-10 02:10Z = June 9 19:10 PDT)
  // and flies east to NYY for afternoon game next day (2026-06-10 17:05Z = 13:05 EDT).
  const eastbound = computeTravelFatigueContext(
    [{ date: '2026-06-09', side: 'home', homeTeamId: 119, gameDate: '2026-06-10T02:10:00Z' }],
    { homeTeamId: 147, gameDate: '2026-06-10T17:05:00Z' },
    '2026-06-10'
  );
  assert.ok(eastbound.travelMiles > 2400);
  assert.equal(eastbound.timezoneShiftHours, 3);
  assert.equal(eastbound.travelDirection, 'east');
  assert.equal(eastbound.dayAfterNight, true);
  assert.ok(eastbound.travelFatigueScore >= 0.85, `expected high score, got ${eastbound.travelFatigueScore}`);

  // Reverse direction (westbound NYY -> LAD, same 0 rest days, night -> night so no day-after-night).
  const eastNight = computeTravelFatigueContext(
    [{ date: '2026-06-09', side: 'home', homeTeamId: 119, gameDate: '2026-06-10T02:10:00Z' }],
    { homeTeamId: 147, gameDate: '2026-06-10T23:05:00Z' },
    '2026-06-10'
  );
  const westNight = computeTravelFatigueContext(
    [{ date: '2026-06-09', side: 'home', homeTeamId: 147, gameDate: '2026-06-09T23:05:00Z' }],
    { homeTeamId: 119, gameDate: '2026-06-11T02:10:00Z' },
    '2026-06-10'
  );
  assert.equal(westNight.timezoneShiftHours, -3);
  assert.equal(westNight.travelDirection, 'west');
  assert.ok(eastNight.travelFatigueScore > westNight.travelFatigueScore);

  // Off-day recovery (1 full rest day: played June 8, plays June 10).
  const eastWithOffDay = computeTravelFatigueContext(
    [{ date: '2026-06-08', side: 'home', homeTeamId: 119, gameDate: '2026-06-09T02:10:00Z' }],
    { homeTeamId: 147, gameDate: '2026-06-10T23:05:00Z' },
    '2026-06-10'
  );
  assert.ok(eastWithOffDay.travelFatigueScore < eastNight.travelFatigueScore);
});

test('finalizeScheduleFatigueProfile keeps legacy nulls when no todayGameInfo and populates Feature Vector v2.0 when present', () => {
  // Legacy call without todayGameInfo -> travel fields remain null (never fabricated).
  const legacy = finalizeScheduleFatigueProfile(
    119,
    [{ date: '2026-06-09', side: 'away' }],
    '2026-06-10'
  );
  assert.equal(legacy.travelMiles, null);
  assert.equal(legacy.timezoneShiftHours, null);
  assert.equal(legacy.travelFatigueScore, null);

  // Live call with stadium metadata -> populates all 3 v2.0 travel features automatically!
  const awaySched = finalizeScheduleFatigueProfile(
    119,
    [
      { date: '2026-06-09', side: 'away', homeTeamId: 115, gameDate: '2026-06-10T00:40:00Z' },
      { date: '2026-06-08', side: 'home', homeTeamId: 119, gameDate: '2026-06-09T02:10:00Z' }
    ],
    '2026-06-10',
    { homeTeamId: 147, gameDate: '2026-06-10T23:05:00Z' }
  );
  const homeSched = finalizeScheduleFatigueProfile(
    147,
    [{ date: '2026-06-09', side: 'home', homeTeamId: 147, gameDate: '2026-06-09T23:05:00Z' }],
    '2026-06-10',
    { homeTeamId: 147, gameDate: '2026-06-10T23:05:00Z' }
  );
  // Multi-leg cumulative 3-day travel: LAD -> COL (~830mi) + COL -> NYY (~1630mi) > 2400mi!
  assert.ok(awaySched.travelMiles > 2400);
  assert.equal(homeSched.travelMiles, 0);

  const v2 = buildFeatureVectorV2(
    {
      game: {
        gamePk: 991122,
        officialDate: '2026-06-10',
        teams: {
          away: { team: { id: 119 } },
          home: { team: { id: 147 } }
        }
      },
      scheduleFatigueProfiles: { '119': awaySched, '147': homeSched }
    },
    { asOfUtc: '2026-06-10T20:00:00Z', firstPitchUtc: '2026-06-10T23:05:00Z' }
  );
  assert.equal(v2.awayTravelMiles.missing, 0);
  assert.equal(v2.awayTravelMiles.value, awaySched.travelMiles);
  assert.equal(v2.awayTimezoneShift.value, 2); // COL (-6) -> NYY (-4) = +2h
  assert.equal(v2.awayTravelFatigueScore.missing, 0);
  assert.ok(v2.awayTravelFatigueScore.value > v2.homeTravelFatigueScore.value);
});
