import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MONEYLINE_WEIGHTS = {
  starting_pitcher: 0.24,
  offense: 0.22,
  bullpen: 0.14,
  home_advantage: 0.08,
  recent_form: 0.1,
  market_odds: 0.12,
  data_quality: 0.1
};

function evolutionDataDir() {
  const override = process.env.MLB_EVOLUTION_DATA_DIR || process.env.EVOLUTION_DATA_DIR;
  if (override) return resolve(override);
  return fileURLToPath(new URL('../data/evolution', import.meta.url));
}

function readJsonFile(fileName, fallback) {
  const path = resolve(evolutionDataDir(), fileName);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function candidateFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return entry.candidate && typeof entry.candidate === 'object' ? entry.candidate : entry;
}

function normalizeRules(approvedRules) {
  const source = [
    ...(Array.isArray(approvedRules?.active_controls) ? approvedRules.active_controls : []),
    ...(Array.isArray(approvedRules?.approved) ? approvedRules.approved : [])
  ];
  const deduped = new Map();

  for (const entry of source) {
    const candidate = candidateFromEntry(entry);
    if (!candidate) continue;
    const key = candidate.rule_key || candidate.candidate_id;
    if (!key) continue;
    const status = String(candidate.status || entry?.decision?.status || 'active').toLowerCase();
    const productionAllowed = candidate.production_update_allowed !== false;
    const isApproved = status === 'active' || status === 'approved' || String(candidate.promotion_status || '').startsWith('approved');
    if (productionAllowed && isApproved) {
      deduped.set(String(key), candidate);
    }
  }

  return [...deduped.values()];
}

function activeWeightVersion(weightStore) {
  const versions = Array.isArray(weightStore?.versions) ? weightStore.versions : [];
  const activeVersion = weightStore?.active_version;
  return versions.find((version) => version.version === activeVersion) || versions.find((version) => version.status === 'active') || null;
}

export function loadEvolutionControls() {
  const approvedRules = readJsonFile('approved_rules.json', {
    active_rule_version: 'rules-v1.0',
    approved: []
  });
  const weightStore = readJsonFile('weight_versions.json', {
    active_version: 'weights-v1.0',
    versions: [{ version: 'weights-v1.0', status: 'active', weights: { moneyline: DEFAULT_MONEYLINE_WEIGHTS } }]
  });
  const memory = readJsonFile('audit_memory.json', {
    version: 'audit-memory-v1.0',
    mistake_patterns: [],
    next_game_cautions: [],
    production_authority: 'advisory_memory_only'
  });
  const activeWeights = activeWeightVersion(weightStore);

  return {
    activeRuleVersion: approvedRules.active_rule_version || 'rules-v1.0',
    rules: normalizeRules(approvedRules),
    activeWeightVersion: weightStore.active_version || activeWeights?.version || 'weights-v1.0',
    weights: activeWeights?.weights || { moneyline: DEFAULT_MONEYLINE_WEIGHTS },
    memory
  };
}

export function getEvolutionRule(controls, ruleKey) {
  return (controls?.rules || []).find((rule) => rule.rule_key === ruleKey || rule.candidate_id === ruleKey) || null;
}

export function moneylineWeightMultiplier(controls, factor) {
  const active = controls?.weights?.moneyline || DEFAULT_MONEYLINE_WEIGHTS;
  const current = Number(active[factor]);
  const baseline = Number(DEFAULT_MONEYLINE_WEIGHTS[factor]);
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline <= 0) return 1;
  return current / baseline;
}
