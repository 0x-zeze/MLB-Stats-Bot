import assert from 'node:assert/strict';
import test from 'node:test';

import { __newsTestInternals } from '../src/news.js';

const { extractNewsRiskFlags } = __newsTestInternals;

test('SP scratch and IL flags force news veto', () => {
  const risk = extractNewsRiskFlags(
    {
      lineups: { away: { confirmed: false, count: 0 }, home: { confirmed: false, count: 0 } },
      newsContext: {
        articles: [
          {
            title: 'Ace scratched from start',
            summary: 'will not start tonight',
            sourceName: 'MLBTR'
          },
          {
            title: 'Star placed on 10-day IL',
            summary: 'out indefinitely',
            sourceName: 'CBS'
          }
        ]
      }
    },
    { riskVeto: true }
  );
  assert.equal(risk.veto, true);
  assert.equal(risk.probabilityImpact, 'none');
  assert.ok(risk.vetoReasons.some((r) => r.includes('SP scratch')));
  assert.ok(risk.vetoReasons.some((r) => r.includes('IL')));
});

test('medium lineup risk does not veto when both lineups confirmed', () => {
  const risk = extractNewsRiskFlags(
    {
      lineups: { away: { confirmed: true, count: 9 }, home: { confirmed: true, count: 9 } },
      newsContext: {
        articles: [
          {
            title: 'Projected lineup for tonight',
            summary: 'expected lineup released early',
            sourceName: 'BA'
          }
        ]
      }
    },
    { riskVeto: true }
  );
  assert.equal(risk.veto, false);
});

test('opener/bulk news is a high veto', () => {
  const risk = extractNewsRiskFlags(
    {
      lineups: { away: { confirmed: true, count: 9 }, home: { confirmed: true, count: 9 } },
      newsContext: {
        articles: [
          {
            title: 'Team goes with opener and bulk pitcher',
            summary: 'bullpen game planned',
            sourceName: 'MLBTR'
          }
        ]
      }
    },
    { riskVeto: true }
  );
  assert.equal(risk.veto, true);
  assert.ok(risk.flags.some((f) => f.flag === 'opener_bulk'));
});

test('riskVeto false never vetoes', () => {
  const risk = extractNewsRiskFlags(
    {
      lineups: { away: { confirmed: false, count: 0 }, home: { confirmed: false, count: 0 } },
      newsContext: {
        articles: [{ title: 'Starter scratched', summary: 'won\'t start', sourceName: 'X' }]
      }
    },
    { riskVeto: false }
  );
  assert.equal(risk.veto, false);
  assert.ok(risk.flags.length >= 1);
});
