// Declarative rule evaluator for the moneyline value engine (JS side).
//
// The rule catalog lives in data/rules/moneyline_rules.json — the single source
// of truth shared with the Python evaluator (src/rule_engine.py). This module
// owns ONLY the per-language predicate logic (the `handler` functions); every
// threshold, message, ordering, engine-scope and tier lives in the JSON.
//
// Behavior contract: evaluateMoneyline() must reproduce the exact reason strings
// and ordering that the old inline valueSafetyReasons() produced in src/mlb.js.
// Rules fire in ascending `order` (which mirrors the original source line
// sequence); `tier` is descriptive metadata only and does NOT affect ordering.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toNumber } from './utils.js';

let _rulesCache = null;

function rulesPath() {
  return process.env.MLB_RULES_FILE || fileURLToPath(new URL('../data/rules/moneyline_rules.json', import.meta.url));
}

export function loadMoneylineRules() {
  if (_rulesCache) return _rulesCache;
  _rulesCache = JSON.parse(readFileSync(rulesPath(), 'utf8'));
  return _rulesCache;
}

// Test-only: drop the cache so a different MLB_RULES_FILE can be loaded.
export function _resetRulesCache() {
  _rulesCache = null;
}

function renderMessage(template, tokens, override) {
  if (override !== undefined && override !== null) return override;
  if (!tokens) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => String(tokens[key]));
}

function absEdge(item, key) {
  return Math.abs(toNumber(item.modelBreakdown?.[key], 0));
}

// Each handler mirrors one check from the original valueSafetyReasons()
// (src/mlb.js). It returns { fired } plus either `tokens` (filled into the
// rule's message template) or `override` (a pre-built string used verbatim).
export const JS_HANDLERS = {
  // src/mlb.js:529-530 — stale/absent odds timestamp. Host pre-computes the
  // freshness string (config-driven max age) and passes it via ctx.
  staleOdds(ctx) {
    const reason = ctx.oddsFreshnessReason;
    return reason ? { fired: true, override: reason } : { fired: false };
  },

  // src/mlb.js:533-535 — configurable value-edge floor.
  edgeFloor(ctx) {
    const { option, edgeThreshold } = ctx;
    if (option.edge < edgeThreshold) {
      return {
        fired: true,
        tokens: {
          sign: option.edge >= 0 ? '+' : '',
          edge: option.edge.toFixed(1),
          threshold: edgeThreshold.toFixed(1)
        }
      };
    }
    return { fired: false };
  },

  // src/mlb.js:541-545 — picked-team season win% quality floor.
  teamQuality(ctx, params) {
    const floor = toNumber(params.min_win_pct, 0.52);
    if (ctx.pickedTeamWinPct < floor) {
      return {
        fired: true,
        tokens: {
          pct: (ctx.pickedTeamWinPct * 100).toFixed(0),
          floor: (floor * 100).toFixed(0)
        }
      };
    }
    return { fired: false };
  },

  // src/mlb.js:551-553 — away underdog plus-money ceiling.
  awayUnderdog(ctx, params) {
    const { option } = ctx;
    const max = toNumber(params.max_odds, 115);
    if (option.side === 'away' && Number(option.odds) > max) {
      return { fired: true, tokens: { odds: option.odds, max } };
    }
    return { fired: false };
  },

  // src/mlb.js:559-562 — pick must be the model's favored side.
  marketAgreement(ctx) {
    return { fired: ctx.option.side !== ctx.modelFavoredSide };
  },

  // src/mlb.js:566-568 — calibrated conviction floor.
  convictionFloor(ctx, params) {
    const floor = toNumber(params.min_probability, 52);
    const prob = toNumber(ctx.option.modelProbability, 0);
    if (prob < floor) {
      return { fired: true, tokens: { prob: prob.toFixed(1), floor: String(floor) } };
    }
    return { fired: false };
  },

  // src/mlb.js:575-578 — sharp money moved against the pick.
  sharpContra(ctx, params) {
    const sharp = ctx.item.modelBreakdown?.sharpMoney;
    const min = toNumber(params.min_magnitude, 10);
    if (sharp && sharp.direction === 'against_model' && sharp.magnitude >= min) {
      return { fired: true, tokens: { magnitude: sharp.magnitude } };
    }
    return { fired: false };
  },

  // src/mlb.js:580-584 — season record / H2H dominates today's matchup edge.
  recordDominance(ctx, params) {
    const matchupEdge = absEdge(ctx.item, 'matchupEdge');
    const recordContextEdge = absEdge(ctx.item, 'recordContextEdge');
    const mult = toNumber(params.record_multiplier, 1.35);
    const maxMatchup = toNumber(params.max_matchup_edge, 0.2);
    const fired = ctx.item.modelBreakdown?.recordDominated
      || (recordContextEdge > matchupEdge * mult && matchupEdge < maxMatchup);
    return { fired: Boolean(fired) };
  },

  // src/mlb.js:586-596 — evolution-approved record-bias guardrail (params from
  // the active rule; only fires when that rule is present).
  auditRecordBias(ctx, params) {
    const rule = ctx.getEvolutionRule(ctx.evolutionControls, params.evolution_rule_key);
    if (!rule) return { fired: false };
    const rp = rule.parameters || {};
    const matchupEdge = absEdge(ctx.item, 'matchupEdge');
    const recordContextEdge = absEdge(ctx.item, 'recordContextEdge');
    const mult = toNumber(rp.record_context_multiplier, toNumber(params.default_record_context_multiplier, 1.25));
    const maxMatchup = toNumber(rp.max_matchup_edge, toNumber(params.default_max_matchup_edge, 0.18));
    const recordDominatedThin = ctx.item.modelBreakdown?.recordDominated && matchupEdge < maxMatchup;
    const recordContextDominates = recordContextEdge > matchupEdge * mult && matchupEdge < maxMatchup;
    return { fired: Boolean(recordDominatedThin || recordContextDominates) };
  },

  // src/mlb.js:598-600 — today's matchup edge is thin and value edge sub-strong.
  thinMatchup(ctx, params) {
    const matchupEdge = absEdge(ctx.item, 'matchupEdge');
    const maxMatchup = toNumber(params.max_matchup_edge, 0.08);
    const strong = toNumber(params.strong_edge, 4.0);
    return { fired: matchupEdge < maxMatchup && ctx.option.edge < strong };
  },

  // src/mlb.js:602-614 — fewer than N model factors agree with the pick.
  factorAgreement(ctx, params) {
    const breakdown = ctx.item.modelBreakdown || {};
    const pickDir = ctx.option.side === 'home' ? 1 : -1;
    const threshold = toNumber(params.agree_threshold, 0.02);
    const components = [
      toNumber(breakdown.matchupEdge, 0),
      toNumber(breakdown.starterEdge, 0),
      toNumber(breakdown.offenseEdge, 0),
      toNumber(breakdown.bullpenEdge, 0),
      toNumber(breakdown.lineupEdge, 0)
    ];
    const agreeing = components.filter((c) => c * pickDir > threshold).length;
    const minAgree = toNumber(params.min_agreeing, 3);
    const strong = toNumber(params.strong_edge, 4.0);
    return { fired: agreeing < minAgree && ctx.option.edge < strong };
  },

  // src/mlb.js:616-632 — evolution-approved weak-edge guardrail.
  auditWeakEdge(ctx, params) {
    const rule = ctx.getEvolutionRule(ctx.evolutionControls, params.evolution_rule_key);
    if (!rule) return { fired: false };
    const rp = rule.parameters || {};
    const matchupEdge = absEdge(ctx.item, 'matchupEdge');
    const maxValueEdge = toNumber(rp.max_value_edge, toNumber(params.default_max_value_edge, 1.0));
    const maxProbEdge = toNumber(rp.max_probability_edge, toNumber(params.default_max_probability_edge, 3.0));
    const maxMatchup = toNumber(rp.max_matchup_edge, toNumber(params.default_max_matchup_edge, 0.05));
    const probEdge = Math.abs(toNumber(ctx.option.modelProbability, 50) - 50);
    const fired = (ctx.option.edge < maxValueEdge || probEdge < maxProbEdge) && matchupEdge < maxMatchup;
    return { fired: Boolean(fired) };
  },

  // src/mlb.js:634-638 — an incomplete lineup with sub-strong value edge.
  lineupIncomplete(ctx, params) {
    const minCount = toNumber(params.min_count, 9);
    const strong = toNumber(params.strong_edge, 4.0);
    const lineups = [ctx.item.lineups?.away, ctx.item.lineups?.home].filter(Boolean);
    const incomplete = lineups.some((l) => !l.confirmed || toNumber(l.count, 0) < minCount);
    return { fired: incomplete && ctx.option.edge < strong };
  },

  // src/mlb.js:640-646 — opener/bulk pitcher with medium+ confidence.
  openerRisk(ctx, params) {
    const confidences = (params.confidences || ['high', 'medium']).map((c) => String(c).toLowerCase());
    const openerTeams = [ctx.item.away, ctx.item.home].filter((t) => t?.openerSituation?.isOpener);
    const risky = openerTeams.some((t) => confidences.includes(String(t.openerSituation?.confidence || '').toLowerCase()));
    return { fired: risky };
  },

  // src/mlb.js:648-651 — a probable pitcher is not yet posted.
  noProbablePitcher(ctx, params) {
    const strong = toNumber(params.strong_edge, 4.0);
    const missing = !ctx.item.away?.starter || !ctx.item.home?.starter;
    return { fired: missing && ctx.option.edge < strong };
  }
};

// Evaluate all JS-scoped rules against ctx and return the deduped, ordered list
// of fired reason strings. Mirrors the old valueSafetyReasons() return value.
// Does NOT short-circuit — collects every fired reason (the NO BET/VALUE label
// is applied by the host in applyMoneylineValueMarket).
export function evaluateMoneyline(ctx) {
  const rules = loadMoneylineRules().rules
    .filter((rule) => rule.engines.includes('js'))
    .sort((a, b) => a.order - b.order);

  const reasons = [];
  for (const rule of rules) {
    const handler = JS_HANDLERS[rule.handler];
    if (!handler) throw new Error(`No JS handler registered for rule ${rule.id} (handler: ${rule.handler})`);
    const result = handler(ctx, rule.params || {});
    if (result?.fired) reasons.push(renderMessage(rule.message, result.tokens, result.override));
  }
  return [...new Set(reasons)];
}
