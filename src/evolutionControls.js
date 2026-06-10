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
    const decisionStatus = String(entry?.decision?.status || '').toLowerCase();
    // Skip guardrails that have been released by the calibration-driven removal mechanism
    if (decisionStatus === 'released' || decisionStatus === 'removed') continue;
    const status = String(candidate.status || decisionStatus || 'active').toLowerCase();
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

export function getCalibrationPenalty(probability, controls) {
  if (!controls) controls = loadEvolutionControls();
  const patterns = Array.isArray(controls?.memory?.mistake_patterns)
    ? controls.memory.mistake_patterns
    : [];

  let penalty = 0;
  for (const pattern of patterns) {
    const segment = pattern.segment || {};
    const segmentName = String(segment.segment || pattern.type || '');
    if (!segmentName.startsWith('segment-probability') && !segmentName.includes('probability')) continue;

    const match = segmentName.match(/(\d+)-(\d+)/);
    if (!match) continue;
    const low = Number(match[1]);
    const high = Number(match[2]);
    if (probability >= low && probability < high) {
      const accuracy = Number(segment.accuracy || pattern.reason_quality?.accuracy || 100);
      if (accuracy < 45) penalty -= 2;
      else if (accuracy < 50) penalty -= 1;
    }
  }

  const memory = controls?.memory || {};
  const cautions = Array.isArray(memory.next_game_cautions) ? memory.next_game_cautions : [];
  // Note: the old 60-65% caution penalty was removed because the model has
  // improved (now 56.5% accuracy in that range). Re-enable if accuracy drops.

  return Math.max(-2, penalty);
}
