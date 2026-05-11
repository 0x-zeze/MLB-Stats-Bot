import assert from 'node:assert/strict';
import test from 'node:test';

import { formatPredictions } from '../src/mlb.js';

function game(gamePk, awayName, homeName, awayProb, homeProb) {
  return {
    gamePk,
    status: 'Scheduled',
    start: `${gamePk}:10 PM`,
    venue: `Ballpark ${gamePk}`,
    away: {
      id: gamePk * 10 + 1,
      name: awayName,
      abbreviation: awayName.slice(0, 3).toUpperCase(),
      starterLine: 'Starter stats hidden in compact mode',
      winProbability: awayProb
    },
    home: {
      id: gamePk * 10 + 2,
      name: homeName,
      abbreviation: homeName.slice(0, 3).toUpperCase(),
      starterLine: 'Starter stats hidden in compact mode',
      winProbability: homeProb
    },
    winner:
      homeProb >= awayProb
        ? { id: gamePk * 10 + 2, name: homeName, abbreviation: homeName.slice(0, 3).toUpperCase() }
        : { id: gamePk * 10 + 1, name: awayName, abbreviation: awayName.slice(0, 3).toUpperCase() },
    contextLine: 'Context should be hidden',
    matchupSplitLine: 'Splits should be hidden',
    bullpenLine: 'Bullpen should be hidden',
    pitcherRecentLine: 'Recent pitcher should be hidden',
    advancedLine: 'Advanced should be hidden',
    modelReferenceLines: ['Reference should be hidden'],
    injuryDetailLines: ['Injury should be hidden'],
    headToHead: { games: 0, awayProbability: 50, homeProbability: 50 },
    firstInning: { baselinePick: 'NO', baselineProbability: 50, topRate: 0, bottomRate: 0, reasons: [] },
    totalRuns: null,
    reasons: ['Reason should be hidden.']
  };
}

test('compact today format lists all supplied games with only core fields', () => {
  const output = formatPredictions(
    '2026-05-04',
    [
      game(1, 'Away One', 'Home One', 45, 55),
      game(2, 'Away Two', 'Home Two', 52, 48),
      game(3, 'Away Three', 'Home Three', 49, 51)
    ],
    { includeAdvanced: false, maxGames: 3 }
  );

  assert.match(output, /Away One @ Home One/);
  assert.match(output, /Away Two @ Home Two/);
  assert.match(output, /Away Three @ Home Three/);
  assert.match(output, /Probabilitas \|/);
  assert.match(output, /Pick Model \| Home One/);
  assert.doesNotMatch(output, /Context should be hidden/);
  assert.doesNotMatch(output, /Main Factors/);
  assert.doesNotMatch(output, /\+ 1 game lain/);
});
