import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTopPicksAnswer, normalizeInteractiveAnswer } from '../src/llm.js';

function prediction(gamePk, awayName, homeName, awayProbability, homeProbability, reason, overrides = {}) {
  const away = {
    id: gamePk * 10 + 1,
    name: awayName,
    abbreviation: awayName.slice(0, 3).toUpperCase(),
    winProbability: awayProbability,
    starterLine: `${awayName} starter edge`
  };
  const home = {
    id: gamePk * 10 + 2,
    name: homeName,
    abbreviation: homeName.slice(0, 3).toUpperCase(),
    winProbability: homeProbability,
    starterLine: `${homeName} starter edge`
  };
  const winner = homeProbability >= awayProbability ? home : away;

  return {
    gamePk,
    away,
    home,
    winner,
    reasons: [reason],
    modelBreakdown: {
      matchupEdge: 0.2,
      recordContextEdge: 0.04,
      recordDominated: false
    },
    betDecision: {
      status: 'LEAN ONLY',
      edge: 0
    },
    ...overrides
  };
}

test('interactive answer normalization removes hidden reasoning tags', () => {
  const answer = normalizeInteractiveAnswer(
    '<think>long private ranking process</think>\nTop 5 Pick Model Hari Ini\n1. BAL ML - prediksi menang: Baltimore Orioles.'
  );

  assert.doesNotMatch(answer, /<think>/i);
  assert.doesNotMatch(answer, /private ranking/i);
  assert.match(answer, /Top 5 Pick Model Hari Ini/);
});

test('top 5 pick question uses concise deterministic formatter', () => {
  const predictions = [
    prediction(1, 'Away One', 'Home One', 45, 55, 'Home One punya starter dan offense lebih stabil.'),
    prediction(2, 'Away Two', 'Home Two', 63, 37, 'Away Two unggul run prevention hari ini.'),
    prediction(3, 'Away Three', 'Home Three', 40, 60, 'Home Three didukung bullpen lebih segar.'),
    prediction(4, 'Away Four', 'Home Four', 58, 42, 'Away Four punya matchup edge dari starter.'),
    prediction(5, 'Away Five', 'Home Five', 35, 65, 'Home Five unggul offense dan park context.'),
    prediction(6, 'Away Six', 'Home Six', 51, 49, 'Away Six hanya edge tipis.')
  ];

  const answer = buildTopPicksAnswer(predictions, 'best 5 top pick for today');

  assert.match(answer, /^🏆 Top 5 Pick Model \| Hari Ini/);
  assert.match(answer, /Prediksi menang \|/);
  assert.match(answer, /Alasan \|/);
  assert.match(answer, /5\. /);
  assert.doesNotMatch(answer, /6\. /);
  assert.doesNotMatch(answer, /RISK:/i);
  assert.doesNotMatch(answer, /<think>/i);
});
