import assert from 'node:assert/strict';
import test from 'node:test';

import { formatPredictions } from '../src/mlb.js';

test('advanced Telegram output separates prediction lean value quality confidence and risk warning', () => {
  const output = formatPredictions('2026-05-04', [
    {
      gamePk: 1,
      status: 'Scheduled',
      start: '7:10 PM',
      venue: 'Sample Park',
      away: {
        id: 10,
        name: 'Away Team',
        abbreviation: 'AWY',
        starterLine: 'Away SP available',
        winProbability: 46,
      },
      home: {
        id: 20,
        name: 'Home Team',
        abbreviation: 'HOM',
        starterLine: 'Home SP available',
        winProbability: 54,
      },
      winner: { id: 20, name: 'Home Team', abbreviation: 'HOM', winProbability: 54 },
      betDecision: {
        status: 'NO BET',
        reason: 'odds are stale',
      },
      quality: {
        score: 58,
        fields: {
          lineup: { status: 'Projected' },
          odds: { status: 'Stale' },
        },
      },
      contextLine: 'Context',
      matchupSplitLine: 'Splits',
      bullpenLine: 'Bullpen',
      pitcherRecentLine: 'Recent pitcher',
      advancedLine: 'Advanced',
      modelReferenceLines: ['Reference'],
      injuryDetailLines: ['No major injuries'],
      headToHead: { games: 0, awayWins: 0, homeWins: 0, awayProbability: 50, homeProbability: 50 },
      firstInning: {
        baselinePick: 'NO',
        baselineProbability: 51,
        topRate: 20,
        bottomRate: 24,
        awayProfileLine: 'Away low YRFI',
        homeProfileLine: 'Home low YRFI',
        reasons: ['Small edge.'],
      },
      totalRuns: {
        projectedTotal: 8.4,
        awayExpectedRuns: 4.0,
        homeExpectedRuns: 4.4,
        marketLine: 8.5,
        marketDeltaRuns: -0.1,
        bestLean: 'No total lean',
        confidence: 'low',
        over: { 6.5: 60, 7.5: 55, 8.5: 49, 9.5: 43, 10.5: 35, 11.5: 28 },
        under: { 6.5: 40, 7.5: 45, 8.5: 51, 9.5: 57, 10.5: 65, 11.5: 72 },
        detail: {},
        factors: ['No edge.'],
      },
      reasons: ['Model lean is small.'],
    },
  ]);

  assert.match(output, /Prediction \| Home Team/);
  assert.match(output, /Value \| model condong Home Team/);
  assert.match(output, /Data Quality \| 58\/100/);
  // Status labels (NO BET / LEAN ONLY / VALUE) are replaced by a prediction
  // line with team name + confidence band; 54% conviction is in the 52-58% range -> "sedang".
  assert.match(output, /Prediksi \| Home Team 54\.0% \(sedang\)/);
  assert.doesNotMatch(output, /No Bet \|/);
  assert.match(output, /Risk Warning \| Analysis only/);
});
