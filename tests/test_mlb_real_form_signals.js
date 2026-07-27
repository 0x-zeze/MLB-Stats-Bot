import assert from 'node:assert/strict';
import test from 'node:test';

import { __mlbTestInternals } from '../src/mlb.js';

const {
  starterEdge,
  starterRecentEdge,
  starterSeasonEdge,
  blendedTeamOffenseEdge,
  blendedTeamPreventionEdge,
  rollingFormWindow,
  getRollingTeamStatMap,
  buildFirstInningProjection,
  MARKET_BLEND_WEIGHT,
  ROLLING_FORM_DAYS
} = __mlbTestInternals;

test('rolling form window ends day-before prediction (no leakage)', () => {
  assert.deepEqual(rollingFormWindow('2026-07-27', 21), {
    startDate: '2026-07-06',
    endDate: '2026-07-26'
  });
  assert.equal(ROLLING_FORM_DAYS, 21);
});

test('getRollingTeamStatMap parses MLB byDateRange blocks', () => {
  const map = getRollingTeamStatMap({
    stats: [
      {
        type: { displayName: 'byDateRange' },
        group: { displayName: 'hitting' },
        splits: [
          {
            team: { id: 147, name: 'New York Yankees', abbreviation: 'NYY' },
            stat: { gamesPlayed: 18, runs: 90, ops: '.780' }
          }
        ]
      },
      {
        type: { displayName: 'byDateRange' },
        group: { displayName: 'pitching' },
        splits: [
          {
            team: { id: 147, name: 'New York Yankees', abbreviation: 'NYY' },
            stat: { gamesPlayed: 18, era: '3.40', whip: '1.15' }
          }
        ]
      }
    ]
  });

  assert.equal(map.size, 1);
  const profile = map.get(147);
  assert.equal(profile.games, 18);
  assert.equal(profile.hitting.ops, '.780');
  assert.equal(profile.pitching.era, '3.40');
});

test('blended offense prefers rolling form when both sides have sample', () => {
  const seasonHome = {
    hitting: { gamesPlayed: 100, runs: 450, ops: '.720' },
    hittingAdvanced: { iso: 0.15, strikeoutsPerPlateAppearance: 0.22, walksPerPlateAppearance: 0.08 }
  };
  const seasonAway = {
    hitting: { gamesPlayed: 100, runs: 440, ops: '.715' },
    hittingAdvanced: { iso: 0.15, strikeoutsPerPlateAppearance: 0.22, walksPerPlateAppearance: 0.08 }
  };
  const rollingHome = {
    games: 18,
    hitting: { gamesPlayed: 18, runs: 110, ops: '.850' }
  };
  const rollingAway = {
    games: 18,
    hitting: { gamesPlayed: 18, runs: 60, ops: '.650' }
  };

  const thin = blendedTeamOffenseEdge(seasonHome, seasonAway, { games: 3, hitting: rollingHome.hitting }, rollingAway);
  const full = blendedTeamOffenseEdge(seasonHome, seasonAway, rollingHome, rollingAway);

  assert.equal(thin.rollingWeight, 0);
  assert.ok(full.rollingWeight > 0.2);
  assert.ok(full.edge > thin.edge);
});

test('starterEdge blends season with recent gameLog form', () => {
  // Mild season gap so clamps do not mask the blend math.
  const goodSeason = { era: 3.6, whip: 1.2, strikeOuts: 100, baseOnBalls: 40, homeRuns: 14, strikeoutsMinusWalksPercentage: 0.14, homeRunsPer9: 1.1 };
  const badSeason = { era: 4.2, whip: 1.32, strikeOuts: 90, baseOnBalls: 45, homeRuns: 16, strikeoutsMinusWalksPercentage: 0.11, homeRunsPer9: 1.25 };
  const hotRecent = { games: 5, innings: 30, era: 2.1, whip: 1.0, strikeouts: 35, walks: 8, homeRuns: 2 };
  const coldRecent = { games: 5, innings: 28, era: 5.4, whip: 1.55, strikeouts: 20, walks: 14, homeRuns: 6 };

  const seasonOnly = starterSeasonEdge(goodSeason, badSeason);
  const recentOnly = starterRecentEdge(hotRecent, coldRecent);
  const blended = starterEdge(goodSeason, badSeason, hotRecent, coldRecent);
  const expected = seasonOnly * 0.55 + recentOnly * 0.45;

  assert.ok(seasonOnly > 0);
  assert.ok(recentOnly > seasonOnly);
  assert.ok(blended > seasonOnly);
  assert.ok(Math.abs(blended - expected) < 1e-9);
});

test('YRFI mid-band lean is PASS not forced YES', () => {
  const teamProfile = {
    scoredBlend: 0.33,
    allowedBlend: 0.33,
    anyRunBlend: 0.55,
    season: { scored: 4, allowed: 4, games: 12 },
    recent: { anyRun: 5, games: 10 },
    team: { name: 'Team', abbreviation: 'TST' }
  };

  const projection = buildFirstInningProjection({
    away: { name: 'Away', abbreviation: 'AWY' },
    home: { name: 'Home', abbreviation: 'HME' },
    awayProfile: { ...teamProfile, team: { name: 'Away', abbreviation: 'AWY' } },
    homeProfile: { ...teamProfile, team: { name: 'Home', abbreviation: 'HME' } },
    awayPitcherStats: null,
    homePitcherStats: null,
    awayPitcherFirstInningProfile: null,
    homePitcherFirstInningProfile: null,
    headToHead: null
  });

  assert.equal(projection.baselineLean, 'PASS');
  assert.equal(projection.baselinePick, 'NO BET');
  assert.ok(MARKET_BLEND_WEIGHT >= 0.2);
});

test('blended prevention uses rolling staff ERA/WHIP when available', () => {
  const seasonHome = {
    pitching: { era: 4.2, whip: 1.3 },
    pitchingAdvanced: { strikeoutsMinusWalksPercentage: 0.12, homeRunsPer9: 1.1 }
  };
  const seasonAway = {
    pitching: { era: 4.1, whip: 1.28 },
    pitchingAdvanced: { strikeoutsMinusWalksPercentage: 0.12, homeRunsPer9: 1.1 }
  };
  const rollingHome = {
    games: 16,
    pitching: { era: '2.50', whip: '1.00', homeRunsPer9: '0.70', strikeoutWalkRatio: '4.0' }
  };
  const rollingAway = {
    games: 16,
    pitching: { era: '5.50', whip: '1.50', homeRunsPer9: '1.60', strikeoutWalkRatio: '1.5' }
  };

  const result = blendedTeamPreventionEdge(seasonHome, seasonAway, rollingHome, rollingAway);
  assert.ok(result.rollingWeight > 0);
  assert.ok(result.edge > 0.2);
});
