import assert from 'node:assert/strict';
import test from 'node:test';

import { formatPredictions } from '../src/mlb.js';

test('formatPredictions warns when probable pitcher is an opener', () => {
  const output = formatPredictions('2026-04-30', [
    {
      gamePk: 1,
      status: 'Scheduled',
      start: '7:10 PM',
      venue: 'Tropicana Field',
      away: {
        id: 111,
        name: 'Boston Red Sox',
        abbreviation: 'BOS',
        starterLine: 'Ace Starter ERA 3.20 WHIP 1.10',
        winProbability: 48,
      },
      home: {
        id: 139,
        name: 'Tampa Bay Rays',
        abbreviation: 'TB',
        starter: { fullName: 'Rays Opener' },
        starterLine: 'Bulk pitcher TBD',
        openerSituation: { isOpener: true, pitcherRole: 'opener', confidence: 'high' },
        winProbability: 52,
      },
      winner: { id: 139, name: 'Tampa Bay Rays', abbreviation: 'TB', winProbability: 52 },
      contextLine: 'BOS 10-10 | TB 11-9',
      matchupSplitLine: 'BOS away split | TB home split',
      bullpenLine: 'BOS bullpen rested | TB bullpen medium',
      pitcherRecentLine: 'BOS SP recent starts available | TB SP Bulk pitcher TBD',
      advancedLine: 'BOS OPS .720 | TB OPS .730',
      modelReferenceLines: ['Arah edge ML: TB'],
      injuryDetailLines: ['No major injuries'],
      headToHead: {
        games: 0,
        awayWins: 0,
        homeWins: 0,
        awayProbability: 50,
        homeProbability: 50,
      },
      firstInning: {
        baselinePick: 'YES',
        baselineProbability: 54,
        topRate: 23,
        bottomRate: 31,
        awayProfileLine: 'BOS scored 1st 4/20',
        homeProfileLine: 'TB scored 1st 5/20',
        reasons: ['Opener uncertainty raises early-game variance.'],
      },
      totalRuns: null,
      reasons: ['Small model edge.'],
    },
  ]);

  assert.match(output, /Opener situation/);
  assert.match(output, /Rays Opener may not be the primary pitcher/);
  assert.match(output, /Bulk pitcher TBD/);
});
