/**
 * Deterministic pure-JS inference for the market_residual_gbdt_v2 challenger
 * (Shallow Monotone GBDT + Fixed Market-Logit Offset).
 *
 * Model equation:
 *
 *   logit(P_home) = 1.0 * logit(P_market_no_vig_home)
 *                   + base_score
 *                   + learning_rate * sum_{m=1..M} Tree_m(X)
 *
 * Design invariants:
 *  - Market-offset coefficient is FIXED at exactly 1.0 (never fit).
 *  - Trees are shallow (max_depth <= 3) to capture genuine baseball non-linear
 *    interactions (Starter Hand x Lineup, Flyball x Park/Wind, SP IP x Bullpen)
 *    without overfitting small-to-medium MLB seasons.
 *  - Native missingness routing: every split node declares `missing_dir`
 *    ('left' | 'right'), avoiding naive median-imputation distortion.
 *  - Missing / stale / unpaired market probability => `unavailable` (never
 *    fabricates a default probability).
 *  - Zero Python subprocesses, zero network calls, bit-exact JS <-> Python
 *    parity (< 1e-12).
 */

import { createHash } from 'node:crypto';
import {
  MARKET_RESIDUAL_GBDT_V2_MODEL_ID,
  MARKET_RESIDUAL_GBDT_V2_IMPL_VERSION
} from './model_ids.js';

export const MARKET_RESIDUAL_GBDT_V2_FEATURE_SCHEMA_VERSION = 'mlb-feature-vector-v2.0';
export const MARKET_RESIDUAL_GBDT_V2_SUPPORTED_SCHEMAS = [
  'mlb-feature-vector-v1.0',
  'mlb-feature-vector-v2.0'
];
export const MARKET_RESIDUAL_GBDT_V2_ARTIFACT_MANIFEST_VERSION =
  'market-residual-gbdt-v2-artifact-v1';
export const MARKET_OFFSET_COEFFICIENT = 1.0;
export const MAX_ALLOWED_TREE_DEPTH = 3;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validate a single serialized flat-array tree against max_depth and feature set.
 */
function validateTree(tree, treeIndex, featureSet, maxDepth, reasons) {
  if (!tree || typeof tree !== 'object' || !Array.isArray(tree.nodes) || tree.nodes.length === 0) {
    reasons.push(`tree_${treeIndex}_missing_or_empty_nodes`);
    return;
  }
  const nodes = tree.nodes;
  const visited = new Set();

  const walk = (idx, depth) => {
    if (!Number.isInteger(idx) || idx < 0 || idx >= nodes.length) {
      reasons.push(`tree_${treeIndex}_node_index_out_of_bounds (${idx})`);
      return;
    }
    if (visited.has(idx)) {
      reasons.push(`tree_${treeIndex}_cycle_detected_at_${idx}`);
      return;
    }
    visited.add(idx);

    const node = nodes[idx];
    if (!node || typeof node !== 'object') {
      reasons.push(`tree_${treeIndex}_node_${idx}_invalid`);
      return;
    }
    if (node.leaf === true) {
      if (!isFiniteNum(node.value)) {
        reasons.push(`tree_${treeIndex}_leaf_${idx}_nonfinite_value`);
      }
      return;
    }
    if (depth >= maxDepth) {
      reasons.push(`tree_${treeIndex}_exceeds_max_depth_${maxDepth}`);
      return;
    }
    if (typeof node.feature !== 'string' || !featureSet.has(node.feature)) {
      reasons.push(`tree_${treeIndex}_node_${idx}_unknown_feature (${node.feature})`);
    }
    if (!isFiniteNum(node.threshold)) {
      reasons.push(`tree_${treeIndex}_node_${idx}_nonfinite_threshold`);
    }
    if (node.missing_dir !== 'left' && node.missing_dir !== 'right') {
      reasons.push(`tree_${treeIndex}_node_${idx}_invalid_missing_dir (${node.missing_dir})`);
    }
    walk(node.left, depth + 1);
    walk(node.right, depth + 1);
  };

  walk(0, 0);
  if (visited.size !== nodes.length) {
    reasons.push(`tree_${treeIndex}_unreachable_orphan_nodes (${nodes.length - visited.size})`);
  }
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

/**
 * Verify a market_residual_gbdt_v2 artifact before shadow inference.
 */
export function verifyMarketResidualGbdtV2Artifact(artifact) {
  const reasons = [];
  if (!artifact || typeof artifact !== 'object') {
    return { ok: false, reasons: ['artifact_missing'] };
  }
  if (artifact.model_id !== MARKET_RESIDUAL_GBDT_V2_MODEL_ID) {
    reasons.push(`model_id_mismatch (got ${artifact.model_id})`);
  }
  if (artifact.model_impl_version !== MARKET_RESIDUAL_GBDT_V2_IMPL_VERSION) {
    reasons.push(`impl_version_mismatch (got ${artifact.model_impl_version})`);
  }
  if (!MARKET_RESIDUAL_GBDT_V2_SUPPORTED_SCHEMAS.includes(artifact.feature_schema_version)) {
    reasons.push(`feature_schema_mismatch (got ${artifact.feature_schema_version})`);
  }
  if (artifact.artifact_manifest_version !== MARKET_RESIDUAL_GBDT_V2_ARTIFACT_MANIFEST_VERSION) {
    reasons.push(`manifest_version_mismatch (got ${artifact.artifact_manifest_version})`);
  }
  if (artifact.market_offset_coefficient !== MARKET_OFFSET_COEFFICIENT) {
    reasons.push(
      `market_offset_coefficient_not_fixed_1 (got ${artifact.market_offset_coefficient})`
    );
  }
  if (!isFiniteNum(artifact.base_score)) {
    reasons.push('base_score_missing_or_nonfinite');
  }
  if (!isFiniteNum(artifact.learning_rate) || artifact.learning_rate <= 0 || artifact.learning_rate > 1) {
    reasons.push(`learning_rate_invalid (got ${artifact.learning_rate})`);
  }
  if (
    !Number.isInteger(artifact.max_depth) ||
    artifact.max_depth < 1 ||
    artifact.max_depth > MAX_ALLOWED_TREE_DEPTH
  ) {
    reasons.push(`max_depth_invalid (got ${artifact.max_depth}, max ${MAX_ALLOWED_TREE_DEPTH})`);
  }
  if (!Array.isArray(artifact.feature_names) || artifact.feature_names.length === 0) {
    reasons.push('feature_names_missing_or_empty');
  }
  if (!Array.isArray(artifact.trees)) {
    reasons.push('trees_missing_or_not_array');
  } else if (
    artifact.tree_count !== undefined &&
    artifact.tree_count !== artifact.trees.length
  ) {
    reasons.push(`tree_count_mismatch (declared ${artifact.tree_count}, actual ${artifact.trees.length})`);
  }

  if (reasons.length === 0) {
    const featureSet = new Set(artifact.feature_names);
    if (artifact.monotone_constraints !== undefined) {
      if (
        !artifact.monotone_constraints ||
        typeof artifact.monotone_constraints !== 'object' ||
        Array.isArray(artifact.monotone_constraints)
      ) {
        reasons.push('monotone_constraints_invalid');
      } else {
        for (const [feat, dir] of Object.entries(artifact.monotone_constraints)) {
          if (!featureSet.has(feat)) {
            reasons.push(`monotone_constraint_unknown_feature (${feat})`);
          }
          if (dir !== -1 && dir !== 0 && dir !== 1) {
            reasons.push(`monotone_constraint_invalid_direction (${feat}=${dir})`);
          }
        }
      }
    }
    for (let i = 0; i < artifact.trees.length; i += 1) {
      validateTree(artifact.trees[i], i, featureSet, artifact.max_depth, reasons);
      if (reasons.length > 20) break;
    }
  }

  // Require an explicit, valid SHA-256 artifact_hash (fail-closed against
  // stripped or unsigned artifacts).
  if (typeof artifact.artifact_hash !== 'string' || !SHA256_HEX_RE.test(artifact.artifact_hash)) {
    reasons.push('artifact_hash_missing_or_invalid');
  } else {
    const recomputed = hashGbdtArtifactContent(artifact);
    if (recomputed !== artifact.artifact_hash) {
      reasons.push('artifact_hash_mismatch');
    }
  }

  return { ok: reasons.length === 0, reasons };
}

function evaluateTree(tree, flatVector) {
  const nodes = tree.nodes;
  let idx = 0;
  let steps = 0;
  const maxSteps = nodes.length + 1;
  while (steps < maxSteps) {
    const node = nodes[idx];
    if (!node) return NaN;
    if (node.leaf === true) {
      return node.value;
    }
    const rawVal = flatVector[node.feature];
    const missingFlag = flatVector[`missing_${node.feature}`];
    const isMissing =
      rawVal == null ||
      (typeof rawVal === 'number' && !Number.isFinite(rawVal)) ||
      missingFlag === 1;

    if (isMissing) {
      idx = node.missing_dir === 'left' ? node.left : node.right;
    } else {
      const numericVal = typeof rawVal === 'number' ? rawVal : Number(rawVal);
      if (!Number.isFinite(numericVal)) {
        idx = node.missing_dir === 'left' ? node.left : node.right;
      } else {
        idx = numericVal <= node.threshold ? node.left : node.right;
      }
    }
    steps += 1;
  }
  return NaN;
}

/**
 * Score a frozen flattened feature vector + same-book no-vig market home prob.
 */
export function scoreMarketResidualGbdtV2(artifact, flatVector, marketNoVigHomeProb) {
  if (!flatVector || typeof flatVector !== 'object') {
    return {
      available: false,
      homeProbability: null,
      awayProbability: null,
      marketLogit: null,
      residualLogit: null,
      marketNoVigProbability: null,
      treesEvaluated: 0,
      reasons: ['flat_vector_missing']
    };
  }
  if (!isFiniteNum(marketNoVigHomeProb)) {
    return {
      available: false,
      homeProbability: null,
      awayProbability: null,
      marketLogit: null,
      residualLogit: null,
      marketNoVigProbability: null,
      treesEvaluated: 0,
      reasons: ['market_no_vig_home_prob_missing']
    };
  }
  if (marketNoVigHomeProb <= 0 || marketNoVigHomeProb >= 1) {
    return {
      available: false,
      homeProbability: null,
      awayProbability: null,
      marketLogit: null,
      residualLogit: null,
      marketNoVigProbability: null,
      treesEvaluated: 0,
      reasons: [`market_no_vig_home_prob_out_of_range (${marketNoVigHomeProb})`]
    };
  }

  const verify = verifyMarketResidualGbdtV2Artifact(artifact);
  if (!verify.ok) {
    return {
      available: false,
      homeProbability: null,
      awayProbability: null,
      marketLogit: null,
      residualLogit: null,
      marketNoVigProbability: marketNoVigHomeProb,
      treesEvaluated: 0,
      reasons: verify.reasons
    };
  }

  const marketLogit = Math.log(marketNoVigHomeProb / (1 - marketNoVigHomeProb));
  let treeSum = 0;
  for (let m = 0; m < artifact.trees.length; m += 1) {
    const leafVal = evaluateTree(artifact.trees[m], flatVector);
    if (!Number.isFinite(leafVal)) {
      return {
        available: false,
        homeProbability: null,
        awayProbability: null,
        marketLogit,
        residualLogit: null,
        marketNoVigProbability: marketNoVigHomeProb,
        treesEvaluated: m,
        reasons: [`tree_${m}_evaluation_failed`]
      };
    }
    treeSum += leafVal;
  }

  const residualLogit = artifact.base_score + artifact.learning_rate * treeSum;
  const z = marketLogit + residualLogit;
  const homeProbability = sigmoid(z);

  return {
    available: true,
    homeProbability,
    awayProbability: 1 - homeProbability,
    marketLogit,
    residualLogit,
    marketNoVigProbability: marketNoVigHomeProb,
    treesEvaluated: artifact.trees.length,
    reasons: []
  };
}

function sigmoid(z) {
  if (z >= 35) return 1;
  if (z <= -35) return 0;
  return 1 / (1 + Math.exp(-z));
}

export function hashGbdtArtifactContent(artifact) {
  const { artifact_hash: _omit, ...body } = artifact;
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
