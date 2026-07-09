// Golden/characterization parity for the JS moneyline engine.
//
// The goldens in fixtures/moneyline_goldens.json were captured from the
// pre-refactor applyMoneylineValueMarket(). After the refactor delegates to
// src/rule_engine.js, this suite proves the {status, reason, reasons} output is
// byte-identical for every corpus case. If a golden ever needs to change, it
// must be because production behavior INTENTIONALLY changed — never to paper
// over a refactor regression.
//
// Runs under an isolated (empty) MLB_EVOLUTION_DATA_DIR so the two
// audit-guardrail rules stay inactive and results are deterministic regardless
// of the repo's live approved_rules.json.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GOLDENS = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/moneyline_goldens.json', import.meta.url)), 'utf8')
);

test('moneyline engine output matches captured goldens for the whole corpus', async () => {
  const previousDir = process.env.MLB_EVOLUTION_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'mlb-parity-'));
  process.env.MLB_EVOLUTION_DATA_DIR = dir;
  try {
    // Import AFTER setting the env dir; evolutionControls reads it per call so
    // an empty dir yields the advisory-only defaults (no active guardrails).
    const { applyMoneylineValueMarket } = await import('../src/mlb.js');
    const { CORPUS } = await import('./fixtures/moneyline_corpus.js');

    const names = Object.keys(CORPUS);
    assert.equal(names.length, Object.keys(GOLDENS).length, 'corpus and goldens must cover the same cases');

    for (const name of names) {
      const golden = GOLDENS[name];
      assert.ok(golden, `missing golden for corpus case ${name}`);
      const game = CORPUS[name]();
      applyMoneylineValueMarket(game);
      const actual = {
        status: game.betDecision.status,
        reason: game.betDecision.reason,
        reasons: game.betDecision.reasons
      };
      assert.deepEqual(actual, golden, `parity mismatch on case "${name}"`);
    }
  } finally {
    if (previousDir === undefined) delete process.env.MLB_EVOLUTION_DATA_DIR;
    else process.env.MLB_EVOLUTION_DATA_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
