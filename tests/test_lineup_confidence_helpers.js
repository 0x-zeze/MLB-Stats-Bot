import assert from 'node:assert/strict';
import test from 'node:test';

import { bothLineupsConfirmed } from '../src/mlb.js';

test('bothLineupsConfirmed requires both sides confirmed with nine hitters', () => {
  assert.equal(
    bothLineupsConfirmed({
      away: { confirmed: true, count: 9 },
      home: { confirmed: true, count: 9 }
    }),
    true
  );

  assert.equal(
    bothLineupsConfirmed({
      away: { confirmed: true, count: 9 },
      home: { confirmed: true, count: 8 }
    }),
    false
  );

  assert.equal(
    bothLineupsConfirmed({
      away: { confirmed: true, count: 9 },
      home: null
    }),
    false
  );
});
