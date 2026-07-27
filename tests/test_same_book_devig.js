import assert from 'node:assert/strict';
import test from 'node:test';

import { __mlbTestInternals } from '../src/mlb.js';

const {
  devigMoneylinePercent,
  moneylineBooksAreSame,
  moneylineValueOption
} = __mlbTestInternals;

test('same-book de-vig produces fair probs with positive overround', () => {
  const devig = devigMoneylinePercent(-150, 130, { sameBook: true });
  assert.equal(devig.usableAsFair, true);
  assert.ok(devig.away > 0 && devig.home > 0);
  assert.ok(Math.abs(devig.away + devig.home - 100) < 0.01);
  assert.ok(devig.overround > 0);
});

test('cross-book pair is not usable as fair market', () => {
  const devig = devigMoneylinePercent(-150, 160, { sameBook: false });
  assert.equal(devig.usableAsFair, false);
  assert.equal(devig.synthetic, true);
  assert.equal(devig.away, null);
  assert.equal(devig.home, null);
});

test('moneylineBooksAreSame requires matching side books', () => {
  assert.equal(
    moneylineBooksAreSame({
      homeMoneylineBook: 'DraftKings',
      awayMoneylineBook: 'DraftKings'
    }),
    true
  );
  assert.equal(
    moneylineBooksAreSame({
      homeMoneylineBook: 'DraftKings',
      awayMoneylineBook: 'FanDuel'
    }),
    false
  );
  assert.equal(moneylineBooksAreSame({ moneylineBook: 'DraftKings' }), true);
  assert.equal(
    moneylineBooksAreSame({
      homeMoneylineBook: 'FanDuel',
      moneylineBook: 'DraftKings'
    }),
    false
  );
});

test('value option uses side-specific book and raw implied when books differ', () => {
  const item = {
    away: { id: 1, name: 'Away', abbreviation: 'AWY', pureModelProbability: 48 },
    home: { id: 2, name: 'Home', abbreviation: 'HOM', pureModelProbability: 52 },
    currentOdds: {
      awayMoneyline: 150,
      homeMoneyline: -160,
      awayMoneylineBook: 'FanDuel',
      homeMoneylineBook: 'DraftKings',
      moneylineBook: 'DraftKings'
    }
  };
  const homeOpt = moneylineValueOption(item, 'home');
  assert.equal(homeOpt.book, 'DraftKings');
  assert.equal(homeOpt.fairSource, 'raw_implied_executable');
  assert.equal(homeOpt.sameBookDevig, false);

  const awayOpt = moneylineValueOption(item, 'away');
  assert.equal(awayOpt.book, 'FanDuel');
  assert.equal(awayOpt.fairSource, 'raw_implied_executable');
});

test('value option uses same-book devig when books match', () => {
  const item = {
    away: { id: 1, name: 'Away', abbreviation: 'AWY', pureModelProbability: 45 },
    home: { id: 2, name: 'Home', abbreviation: 'HOM', pureModelProbability: 55 },
    currentOdds: {
      awayMoneyline: 140,
      homeMoneyline: -160,
      awayMoneylineBook: 'Pinnacle',
      homeMoneylineBook: 'Pinnacle',
      moneylineBook: 'Pinnacle'
    }
  };
  const homeOpt = moneylineValueOption(item, 'home');
  assert.equal(homeOpt.book, 'Pinnacle');
  assert.equal(homeOpt.fairSource, 'same_book_devig');
  assert.equal(homeOpt.sameBookDevig, true);
  // Fair home should be less than raw juiced favorite implied.
  assert.ok(homeOpt.fairProbability < homeOpt.impliedProbability);
});
