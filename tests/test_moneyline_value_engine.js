import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  // Edge is measured vs the no-vig fair line (38.46/98.46 = 39.1%), not raw
  // implied (38.5%): 45 - 39.1 = 5.9.
  assert.equal(game.valuePick.fairProbability, 39.1);
  assert.equal(game.valuePick.edge, 5.9);
  // Quarter-Kelly off the calibrated model prob (45%) and offered odds (+160):
  // full = (1.6*0.45 - 0.55)/1.6 = 0.10625; quarter = 0.0265625 -> 2.7%.
  assert.equal(game.valuePick.kellyStakePercent, 2.7);
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
  // Record Favorite at -110 with model 60% has a positive raw edge, so a
  // quarter-Kelly size is still computed on the value option; the NO BET
  // downgrade is what suppresses it in /picks, not a null stake here.
  assert.equal(typeof game.valuePick.kellyStakePercent, 'number');
});

test('approved audit guardrail can downgrade weak model edge to no bet', () => {
  const previousDir = process.env.MLB_EVOLUTION_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'mlb-evolution-controls-'));
  process.env.MLB_EVOLUTION_DATA_DIR = dir;

  try {
    writeFileSync(
      join(dir, 'approved_rules.json'),
      JSON.stringify({
        active_rule_version: 'rules-v1.1',
        active_controls: [
          {
            rule_key: 'audit:no_bet:weak_edge',
            candidate_id: 'audit-safe-no-bet-weak-edge',
            type: 'no_bet_rule',
            status: 'active',
            production_update_allowed: true,
            parameters: {
              max_value_edge: 2,
              max_probability_edge: 5,
              max_matchup_edge: 0.08
            }
          }
        ],
        approved: []
      })
    );
    writeFileSync(
      join(dir, 'weight_versions.json'),
      JSON.stringify({
        active_version: 'weights-v1.0',
        versions: [{ version: 'weights-v1.0', status: 'active', weights: { moneyline: {} } }]
      })
    );

    const game = sampleGame({
      away: {
        id: 1,
        name: 'Away Team',
        abbreviation: 'AWY',
        winProbability: 48,
        starter: { fullName: 'Away Starter' }
      },
      home: {
        id: 2,
        name: 'Thin Favorite',
        abbreviation: 'THN',
        winProbability: 52,
        starter: { fullName: 'Home Starter' }
      },
      currentOdds: {
        awayMoneyline: -130,
        homeMoneyline: 120,
        moneylineBook: 'FanDuel'
      },
      modelBreakdown: {
        matchupEdge: 0.04,
        recordContextEdge: 0.01,
        recordDominated: false
      }
    });

    applyMoneylineValueMarket(game);

    assert.equal(game.valuePick.teamName, 'Thin Favorite');
    assert.equal(game.betDecision.status, 'NO BET');
    assert.match(game.betDecision.reason, /audit guardrail/);
    assert.deepEqual(game.activeEvolutionVersions, { rule: 'rules-v1.1', weights: 'weights-v1.0', memory: 'audit-memory-v1.0' });
  } finally {
    if (previousDir === undefined) {
      delete process.env.MLB_EVOLUTION_DATA_DIR;
    } else {
      process.env.MLB_EVOLUTION_DATA_DIR = previousDir;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit memory adds caution notes without forcing a bet decision by itself', () => {
  const previousDir = process.env.MLB_EVOLUTION_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'mlb-audit-memory-'));
  process.env.MLB_EVOLUTION_DATA_DIR = dir;

  try {
    writeFileSync(join(dir, 'approved_rules.json'), JSON.stringify({ active_rule_version: 'rules-v1.0', active_controls: [], approved: [] }));
    writeFileSync(
      join(dir, 'weight_versions.json'),
      JSON.stringify({
        active_version: 'weights-v1.0',
        versions: [{ version: 'weights-v1.0', status: 'active', weights: { moneyline: {} } }]
      })
    );
    writeFileSync(
      join(dir, 'audit_memory.json'),
      JSON.stringify({
        version: 'audit-memory-v1.0',
        mistake_patterns: [
          {
            type: 'factor_needs_review',
            factor: 'starting_pitcher',
            caution: 'Memory: starting pitcher signal has misled recent picks.'
          }
        ],
        next_game_cautions: []
      })
    );

    const game = sampleGame({
      modelBreakdown: {
        matchupEdge: 0.3,
        recordContextEdge: 0.02,
        starterEdge: 0.28,
        offenseEdge: 0.05,
        lineupEdge: 0.02,
        bullpenEdge: 0.01,
        recordDominated: false
      }
    });

    applyMoneylineValueMarket(game);

    assert.equal(game.betDecision.status, 'VALUE');
    assert.deepEqual(game.auditMemoryNotes, ['Memory: starting pitcher signal has misled recent picks.']);
  } finally {
    if (previousDir === undefined) {
      delete process.env.MLB_EVOLUTION_DATA_DIR;
    } else {
      process.env.MLB_EVOLUTION_DATA_DIR = previousDir;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
