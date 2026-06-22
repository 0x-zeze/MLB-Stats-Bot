import test from 'node:test';
import assert from 'node:assert/strict';

import { namesMatch, teamToken, findEventForGame } from '../src/lineMovement.js';

test('relocated Athletics match across feed name variants', () => {
  // MLB StatsAPI now lists "Athletics"; books may carry "Oakland Athletics"
  // or "Las Vegas Athletics". All must resolve to one token.
  assert.equal(teamToken('Athletics'), 'oak');
  assert.equal(teamToken('Oakland Athletics'), 'oak');
  assert.equal(teamToken('Las Vegas Athletics'), 'oak');
  assert.ok(namesMatch('Athletics', 'Oakland Athletics'));
});

test('the two Sox never collide', () => {
  assert.equal(teamToken('Chicago White Sox'), 'chw');
  assert.equal(teamToken('Boston Red Sox'), 'bos');
  assert.ok(!namesMatch('Chicago White Sox', 'Boston Red Sox'));
});

test('accented names normalize', () => {
  // Not a team but exercises the accent-stripping path used on outcome names.
  assert.equal(teamToken('San Diego Padres'), 'sd');
  assert.equal(teamToken('St. Louis Cardinals'), 'stl');
});

test('Guardians/Indians legacy alias resolves', () => {
  assert.equal(teamToken('Cleveland Indians'), teamToken('Cleveland Guardians'));
});

test('different teams do not match', () => {
  assert.ok(!namesMatch('Arizona Diamondbacks', 'Los Angeles Angels'));
  assert.ok(!namesMatch('New York Yankees', 'New York Mets'));
});

test('findEventForGame matches by token, ignoring full-name drift', () => {
  const game = {
    home: { name: 'Athletics' },
    away: { name: 'Los Angeles Angels' },
    startTime: '2026-06-16T02:05:00Z'
  };
  const events = [
    { home_team: 'Oakland Athletics', away_team: 'Los Angeles Angels', commence_time: '2026-06-16T02:05:00Z' }
  ];
  assert.equal(findEventForGame(game, events), events[0]);
});

test('doubleheader: picks the event closest to scheduled start', () => {
  const game1 = {
    home: { name: 'New York Yankees' },
    away: { name: 'Boston Red Sox' },
    startTime: '2026-06-16T17:05:00Z'
  };
  const game2 = {
    home: { name: 'New York Yankees' },
    away: { name: 'Boston Red Sox' },
    startTime: '2026-06-16T23:05:00Z'
  };
  const events = [
    { home_team: 'New York Yankees', away_team: 'Boston Red Sox', commence_time: '2026-06-16T17:10:00Z', id: 'gm1' },
    { home_team: 'New York Yankees', away_team: 'Boston Red Sox', commence_time: '2026-06-16T23:10:00Z', id: 'gm2' }
  ];
  assert.equal(findEventForGame(game1, events).id, 'gm1');
  assert.equal(findEventForGame(game2, events).id, 'gm2');
});

test('no match returns undefined', () => {
  const game = { home: { name: 'Atlanta Braves' }, away: { name: 'Miami Marlins' } };
  const events = [{ home_team: 'Chicago Cubs', away_team: 'Cincinnati Reds' }];
  assert.equal(findEventForGame(game, events), undefined);
});
