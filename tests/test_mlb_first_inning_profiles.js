import assert from 'node:assert/strict';
import test from 'node:test';

import { __mlbTestInternals } from '../src/mlb.js';

const {
  actualStarterForSide,
  addPitcherFirstInningGame,
  firstInningHistoryEndDate,
  firstInningRunsChargedToPitcher,
  pitcherFirstInningRisk,
  buildFirstInningProjection
} = __mlbTestInternals;

function boxscoreWithStarter(side, starterId, name = 'Actual Starter') {
  return {
    teams: {
      [side]: {
        pitchers: [starterId, 99],
        players: {
          [`ID${starterId}`]: {
            person: { id: starterId, fullName: name },
            stats: { pitching: { gamesStarted: 1 } }
          },
          ID99: {
            person: { id: 99, fullName: 'Reliever' },
            stats: { pitching: { gamesStarted: 0 } }
          }
        }
      }
    }
  };
}

function scoringPlay({ halfInning = 'top', pitcherId, batterId = 10, runnerId = batterId, start = '', end = 'score' }) {
  return {
    about: { inning: 1, halfInning },
    matchup: {
      pitcher: { id: pitcherId },
      batter: { id: batterId }
    },
    runners: [
      {
        details: { runner: { id: runnerId }, event: 'Home Run' },
        movement: { start, end, isOut: false }
      }
    ]
  };
}

test('first-inning history cutoff excludes the prediction date', () => {
  assert.equal(firstInningHistoryEndDate('2026-06-01'), '2026-05-31');
});

test('actualStarterForSide uses boxscore gamesStarted rather than probable pitcher', () => {
  const starter = actualStarterForSide(boxscoreWithStarter('home', 42, 'Actual Home Starter'), 'home');
  assert.deepEqual(starter, { id: 42, fullName: 'Actual Home Starter' });
});

test('pitcher first-inning profile keys actual starter, not schedule probable pitcher', () => {
  const profiles = new Map();
  const game = {
    gamePk: 123,
    officialDate: '2026-05-31',
    teams: { home: { probablePitcher: { id: 77, fullName: 'Wrong Probable' } } }
  };
  const boxscore = boxscoreWithStarter('home', 42, 'Actual Home Starter');
  const liveFeed = { liveData: { plays: { allPlays: [scoringPlay({ pitcherId: 42 })] } } };

  addPitcherFirstInningGame(profiles, game, boxscore, liveFeed, 'home');

  assert.equal(profiles.has(42), true);
  assert.equal(profiles.has(77), false);
  assert.equal(profiles.get(42).games[0].allowedRuns, 1);
});

test('pitcher first-inning profile does not charge whole half-inning runs to starter', () => {
  const profiles = new Map();
  const game = {
    gamePk: 124,
    officialDate: '2026-05-31',
    linescore: { innings: [{ away: { runs: 3 }, home: { runs: 0 } }] }
  };
  const boxscore = boxscoreWithStarter('home', 42, 'Actual Home Starter');
  const liveFeed = { liveData: { plays: { allPlays: [scoringPlay({ pitcherId: 99 })] } } };

  addPitcherFirstInningGame(profiles, game, boxscore, liveFeed, 'home');

  assert.equal(profiles.get(42).games[0].allowed, false);
  assert.equal(profiles.get(42).games[0].allowedRuns, 0);
});

test('first-inning responsibility follows inherited runners charged to starter', () => {
  const liveFeed = {
    liveData: {
      plays: {
        allPlays: [
          {
            about: { inning: 1, halfInning: 'top' },
            matchup: { pitcher: { id: 42 }, batter: { id: 10 } },
            runners: [
              { details: { runner: { id: 10 }, event: 'Single' }, movement: { start: '', end: '1B', isOut: false } }
            ]
          },
          {
            about: { inning: 1, halfInning: 'top' },
            matchup: { pitcher: { id: 99 }, batter: { id: 11 } },
            runners: [
              { details: { runner: { id: 10 }, event: 'Double' }, movement: { start: '1B', end: 'score', isOut: false } },
              { details: { runner: { id: 11 }, event: 'Double' }, movement: { start: '', end: '2B', isOut: false } }
            ]
          }
        ]
      }
    }
  };

  assert.equal(firstInningRunsChargedToPitcher(liveFeed, 'home', 42), 1);
});

test('neutral thin first-inning profile does not suppress bad season pitcher risk', () => {
  const badStats = { era: 8.5, whip: 1.9, strikeOuts: 20, baseOnBalls: 30 };
  const seasonOnlyRisk = pitcherFirstInningRisk(badStats, null);
  const profileRisk = pitcherFirstInningRisk(badStats, {
    starts: 1,
    allowedRateBlend: 0.33
  });

  assert.equal(seasonOnlyRisk, 0.1);
  assert.equal(profileRisk, 0.1);
});

test('opener-side null pitcher profile removes starter history from first-inning reasons', () => {
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

  assert.equal(projection.reasons.some((reason) => reason.includes('Starter 1st-inning history')), false);
});
