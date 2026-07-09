import assert from 'node:assert/strict';
import test from 'node:test';
import { JS_HANDLERS, loadMoneylineRules } from '../src/rule_engine.js';

const VALID_ACTIONS = new Set(['NO_BET', 'CAP', 'ADJUST']);
const VALID_ENGINES = new Set(['js', 'py']);
const KNOWN_HANDLERS = new Set(); // handlers referenced by py-only rules; not registered in JS

test('rules file has the pinned version', () => {
  const rules = loadMoneylineRules();
  assert.equal(rules.version, 'moneyline-rules-v1');
});

test('every rule has required, well-typed fields', () => {
  const { rules } = loadMoneylineRules();
  assert.ok(Array.isArray(rules) && rules.length > 0);
  for (const rule of rules) {
    assert.equal(typeof rule.id, 'string', `id missing on ${JSON.stringify(rule)}`);
    assert.ok(Array.isArray(rule.engines) && rule.engines.length > 0, `engines missing on ${rule.id}`);
    assert.ok(rule.engines.every((e) => VALID_ENGINES.has(e)), `bad engine on ${rule.id}`);
    assert.ok([1, 2, 3].includes(rule.tier), `tier must be 1/2/3 on ${rule.id}`);
    assert.equal(typeof rule.order, 'number', `order missing on ${rule.id}`);
    assert.ok(VALID_ACTIONS.has(rule.action), `bad action on ${rule.id}`);
    assert.equal(typeof rule.handler, 'string', `handler missing on ${rule.id}`);
    assert.equal(typeof rule.message, 'string', `message missing on ${rule.id}`);
  }
});

test('rule ids are globally unique', () => {
  const { rules } = loadMoneylineRules();
  const ids = rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('(engine, order) pairs are unique within each engine', () => {
  const { rules } = loadMoneylineRules();
  for (const engine of VALID_ENGINES) {
    const orders = rules.filter((r) => r.engines.includes(engine)).map((r) => r.order);
    assert.equal(new Set(orders).size, orders.length, `duplicate order in engine ${engine}`);
  }
});

test('JS-scoped rule handlers all exist in JS_HANDLERS (no orphan rules)', () => {
  const { rules } = loadMoneylineRules();
  for (const rule of rules) {
    if (!rule.engines.includes('js')) continue;
    assert.ok(
      typeof JS_HANDLERS[rule.handler] === 'function',
      `JS rule ${rule.id} references unregistered handler ${rule.handler}`
    );
  }
});

test('every registered JS_HANDLER is referenced by a JS-scoped rule (no dead handlers)', () => {
  const { rules } = loadMoneylineRules();
  const referenced = new Set(
    rules.filter((r) => r.engines.includes('js')).map((r) => r.handler)
  );
  for (const name of Object.keys(JS_HANDLERS)) {
    if (KNOWN_HANDLERS.has(name)) continue;
    assert.ok(referenced.has(name), `JS_HANDLERS.${name} is not referenced by any JS rule`);
  }
});
