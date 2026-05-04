import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMoneylineValueMarket } from '../src/mlb.js';

function sampleGame(overrides = {}) {
  return {
    status: 'Scheduled',
    away: {
      id: 1,
      name: 'Away Underdogs',
      abbreviation: 'AWY',
      winProbability: 45,
      starter: { fullName: 'Away Starter' }
    },
    home: {
      id: 2,
      name: 'Home Favorites',
      abbreviation: 'HOM',
      winProbability: 55,
      starter: { fullName: 'Home Starter' }
    },
    currentOdds: {
      awayMoneyline: 160,
      homeMoneyline: -150,
      moneylineBook: 'FanDuel'
    },
    modelBreakdown: {
      matchupEdge: 0.3,
      recordContextEdge: 0.02,
      recordDominated: false
    },
    lineups: {
      away: { confirmed: true, count: 9 },
      home: { confirmed: true, count: 9 }
    },
    ...overrides
  };
}

test('moneyline value can select lower-probability underdog when odds are mispriced', () => {
  const game = sampleGame();

  applyMoneylineValueMarket(game);

  assert.equal(game.betDecision.status, 'VALUE');
  assert.equal(game.valuePick.teamName, 'Away Underdogs');
  assert.equal(game.valuePick.modelProbability, 45);
  assert.equal(game.valuePick.impliedProbability, 38.5);
  assert.equal(game.valuePick.edge, 6.5);
});

test('record dominated favorite is downgraded to no bet even with positive value', () => {
  const game = sampleGame({
    away: {
      id: 1,
      name: 'Away Team',
      abbreviation: 'AWY',
      winProbability: 40,
      starter: { fullName: 'Away Starter' }
    },
    home: {
      id: 2,
      name: 'Record Favorite',
      abbreviation: 'REC',
      winProbability: 60,
      starter: { fullName: 'Home Starter' }
    },
    currentOdds: {
      awayMoneyline: 125,
      homeMoneyline: -110,
      moneylineBook: 'FanDuel'
    },
    modelBreakdown: {
      matchupEdge: 0.04,
      recordContextEdge: 0.22,
      recordDominated: true
    }
  });

  applyMoneylineValueMarket(game);

  assert.equal(game.valuePick.teamName, 'Record Favorite');
  assert.equal(game.betDecision.status, 'NO BET');
  assert.match(game.betDecision.reason, /record\/H2H/);
});
