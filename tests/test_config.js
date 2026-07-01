import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('config defaults moneyline edge and python executable safely', () => {
  const previousEdge = process.env.MINIMUM_MONEYLINE_EDGE;
  const previousPython = process.env.PYTHON_BIN;
  try {
    process.env.MINIMUM_MONEYLINE_EDGE = '';
    process.env.PYTHON_BIN = '';
    const config = loadConfig();
    assert.equal(config.minimumMoneylineEdge, 0.04);
    assert.equal(config.pythonExecutable, 'python3');

    process.env.MINIMUM_MONEYLINE_EDGE = '0.05';
    process.env.PYTHON_BIN = '/tmp/python';
    const overridden = loadConfig();
    assert.equal(overridden.minimumMoneylineEdge, 0.05);
    assert.equal(overridden.pythonExecutable, '/tmp/python');
  } finally {
    if (previousEdge === undefined) delete process.env.MINIMUM_MONEYLINE_EDGE;
    else process.env.MINIMUM_MONEYLINE_EDGE = previousEdge;
    if (previousPython === undefined) delete process.env.PYTHON_BIN;
    else process.env.PYTHON_BIN = previousPython;
  }
});
