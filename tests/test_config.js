import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('config defaults moneyline edge, odds max age, and python executable safely', () => {
  const previousEdge = process.env.MINIMUM_MONEYLINE_EDGE;
  const previousOddsMaxAge = process.env.MONEYLINE_ODDS_MAX_AGE_MINUTES;
  const previousPython = process.env.PYTHON_BIN;
  try {
    process.env.MINIMUM_MONEYLINE_EDGE = '';
    process.env.MONEYLINE_ODDS_MAX_AGE_MINUTES = '';
    process.env.PYTHON_BIN = '';
    const config = loadConfig();
    assert.equal(config.minimumMoneylineEdge, 0.04);
    assert.equal(config.moneylineOddsMaxAgeMinutes, 10);
    assert.equal(config.pythonExecutable, 'python3');

    process.env.MINIMUM_MONEYLINE_EDGE = '0.05';
    process.env.MONEYLINE_ODDS_MAX_AGE_MINUTES = '3';
    process.env.PYTHON_BIN = '/tmp/python';
    const overridden = loadConfig();
    assert.equal(overridden.minimumMoneylineEdge, 0.05);
    assert.equal(overridden.moneylineOddsMaxAgeMinutes, 3);
    assert.equal(overridden.pythonExecutable, '/tmp/python');
  } finally {
    if (previousEdge === undefined) delete process.env.MINIMUM_MONEYLINE_EDGE;
    else process.env.MINIMUM_MONEYLINE_EDGE = previousEdge;
    if (previousOddsMaxAge === undefined) delete process.env.MONEYLINE_ODDS_MAX_AGE_MINUTES;
    else process.env.MONEYLINE_ODDS_MAX_AGE_MINUTES = previousOddsMaxAge;
    if (previousPython === undefined) delete process.env.PYTHON_BIN;
    else process.env.PYTHON_BIN = previousPython;
  }
});
