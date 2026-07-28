import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clamp } from './utils.js';

// JS port of src/probability_calibrator.py so the live JS prediction path
// (/picks, recaps) applies the same per-market calibration policy the Python
// evolution pipeline trains. Without this, /picks shows raw model probabilities
// that the audit has already shown to be over/under-confident.

function dataDir() {
  return fileURLToPath(new URL('../data', import.meta.url));
}

const MIN_ISOTONIC_SAMPLES_FOR_TRUST = {
  moneyline: 150,
  yrfi: 40,
};

const SHRINKAGE_FACTOR = {
  moneyline: 0.5,
};

let cachedMaps = null;
let cachedMeta = null;
/** @type {Map<string, object>} */
let cachedArtifacts = new Map();

function loadCalibrationMeta() {
  if (cachedMeta !== null) return cachedMeta;
  const metaPath = resolve(dataDir(), 'calibration_meta.json');
  let meta = {};
  if (existsSync(metaPath)) {
    try {
      const raw = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) meta = raw;
    } catch {
      // Missing or malformed metadata preserves existing calibration behavior.
    }
  }
  cachedMeta = meta;
  return meta;
}

function loadCalibrationMaps() {
  if (cachedMaps !== null) return cachedMaps;
  const maps = {};
  const perMarketPath = resolve(dataDir(), 'calibration_maps.json');
  const legacyPath = resolve(dataDir(), 'calibration_map.json');
  if (existsSync(perMarketPath)) {
    try {
      const raw = JSON.parse(readFileSync(perMarketPath, 'utf8'));
      for (const [market, pairs] of Object.entries(raw)) {
        if (Array.isArray(pairs)) {
          maps[market] = pairs.map((p) => [Number(p[0]), Number(p[1])]);
        }
      }
    } catch {
      // fall through to legacy / empty
    }
  }
  if (!maps.moneyline && existsSync(legacyPath)) {
    try {
      const raw = JSON.parse(readFileSync(legacyPath, 'utf8'));
      if (Array.isArray(raw)) maps.moneyline = raw.map((p) => [Number(p[0]), Number(p[1])]);
    } catch {
      // ignore
    }
  }
  cachedMaps = maps;
  return maps;
}

// Test/refresh hook: clear memoized calibration files so next call re-reads disk.
export function resetCalibrationCache() {
  cachedMaps = null;
  cachedMeta = null;
  cachedArtifacts = new Map();
}

/**
 * Explicit runtime calibration artifact identity.
 * Never pretends calibrated when maps are missing while meta claims success.
 */
export function getCalibrationArtifact(market = 'moneyline') {
  const marketKey = String(market).trim().toLowerCase();
  if (cachedArtifacts.has(marketKey)) return cachedArtifacts.get(marketKey);

  const maps = loadCalibrationMaps();
  const meta = loadCalibrationMeta();
  const mapping = maps[marketKey] || [];
  const marketMeta = meta?.markets?.[marketKey] || {};
  const mapPresent = Array.isArray(mapping) && mapping.length > 0;
  const metaSuccess = String(marketMeta.status || '').toLowerCase() === 'success';
  const samples = Number(marketMeta.samples);
  const minSamples = MIN_ISOTONIC_SAMPLES_FOR_TRUST[marketKey];
  const lowSample =
    Number.isFinite(samples) && Number.isFinite(minSamples) && samples < minSamples;

  let mode = 'identity';
  const warnings = [];
  if (mapPresent && !lowSample) {
    mode = 'map';
  } else if (mapPresent && lowSample) {
    mode = 'map_low_sample_shrink';
    warnings.push('low_sample_map');
  } else if (!mapPresent && usesLowSampleShrinkage(marketKey)) {
    mode = 'shrink_toward_50';
    warnings.push('missing_map_using_shrinkage');
  } else {
    mode = 'identity';
    if (metaSuccess) {
      warnings.push('meta_claims_success_but_map_missing_or_unusable');
    }
    if (!mapPresent) warnings.push('missing_calibration_map');
  }

  const hashSource = {
    market: marketKey,
    mapping,
    meta: {
      status: marketMeta.status || null,
      samples: Number.isFinite(samples) ? samples : null,
      map_points: marketMeta.map_points ?? mapping.length,
      version: meta?.version ?? null,
      source: meta?.source ?? null
    },
    mode
  };
  const artifactHash = createHash('sha256')
    .update(JSON.stringify(hashSource))
    .digest('hex')
    .slice(0, 24);

  const artifact = {
    market: marketKey,
    mode,
    applied: mode !== 'identity',
    mapPresent,
    mapPoints: mapping.length,
    metaSuccess,
    samples: Number.isFinite(samples) ? samples : null,
    artifactHash,
    calibrationVersion: `cal-${marketKey}-${artifactHash}`,
    warnings,
    source: meta?.source || (mapPresent ? 'calibration_maps.json' : null)
  };
  cachedArtifacts.set(marketKey, artifact);
  return artifact;
}

function shrinkTowardHalf(raw, market) {
  const factor = SHRINKAGE_FACTOR[market] ?? 0.5;
  return 0.5 + (raw - 0.5) * (1 - factor);
}

function usesLowSampleShrinkage(market) {
  const threshold = MIN_ISOTONIC_SAMPLES_FOR_TRUST[market];
  if (threshold === undefined || SHRINKAGE_FACTOR[market] === undefined) return false;
  const samples = Number(loadCalibrationMeta()?.markets?.[market]?.samples);
  return Number.isFinite(samples) && samples < threshold;
}

function interpolate(mapping, raw) {
  if (!mapping || mapping.length === 0) return raw;
  const xs = mapping.map((p) => p[0]);
  const ys = mapping.map((p) => p[1]);
  if (raw <= xs[0]) return ys[0];
  if (raw >= xs[xs.length - 1]) return ys[ys.length - 1];

  // First index whose x is >= raw (bisect_left equivalent).
  let idx = xs.findIndex((x) => x >= raw);
  if (idx <= 0) return ys[0];
  const x0 = xs[idx - 1];
  const x1 = xs[idx];
  const y0 = ys[idx - 1];
  const y1 = ys[idx];
  if (x1 === x0) return y0;
  const t = (raw - x0) / (x1 - x0);
  return y0 + t * (y1 - y0);
}

/**
 * Map a raw model probability (0-1) to a calibrated probability for a market.
 * Low-sample moneyline metadata uses shrinkage even without a trusted map;
 * otherwise markets fall back to the raw probability when no map exists.
 * Call getCalibrationArtifact() to know whether identity fallback was silent.
 */
export function calibrateProbability(rawProbability, market = 'moneyline') {
  const marketKey = String(market).trim().toLowerCase();
  const artifact = getCalibrationArtifact(marketKey);

  if (artifact.mode === 'shrink_toward_50' || artifact.mode === 'map_low_sample_shrink') {
    // Prefer map when present even under low-sample shrink path: interpolate then
    // shrink residual toward 50 so sparse maps don't overfit.
    const mapping = loadCalibrationMaps()[marketKey];
    let base = rawProbability;
    if (mapping && mapping.length > 0) {
      base = interpolate(mapping, rawProbability);
    }
    if (artifact.mode === 'shrink_toward_50' || usesLowSampleShrinkage(marketKey)) {
      base = shrinkTowardHalf(base, marketKey);
    }
    return clamp(base, 0.05, 0.95);
  }

  if (artifact.mode === 'map') {
    const mapping = loadCalibrationMaps()[marketKey];
    const calibrated = interpolate(mapping, rawProbability);
    return clamp(calibrated, 0.05, 0.95);
  }

  // Identity — explicit, not silent success.
  return rawProbability;
}

/**
 * Convenience wrapper for the percent scale (0-100) used across the JS path.
 * `rawPercent` is the model win probability for the picked side. Returns the
 * calibrated percent for that same side.
 */
export function calibratePercent(rawPercent, market = 'moneyline') {
  const raw = Number(rawPercent);
  if (!Number.isFinite(raw)) return rawPercent;
  const side = raw > 1 ? raw / 100 : raw;
  const calibrated = calibrateProbability(side, market);
  return Math.round(calibrated * 1000) / 10;
}

/** True when a usable calibration map exists for the market. */
export function hasCalibrationMap(market = 'moneyline') {
  const artifact = getCalibrationArtifact(market);
  return artifact.mapPresent && artifact.mode !== 'identity';
}

/**
 * Pure calibration from an explicit frozen artifact — no filesystem, no cache.
 * Used by snapshot replay so the exact historical calibration is applied
 * without silently substituting the newest on-disk map.
 *
 * @param {number} rawProbability 0-1
 * @param {object} artifact { mode, mapping, shrinkFactor? }
 * @returns {number} calibrated probability 0-1
 */
export function calibrateProbabilityWithArtifact(rawProbability, artifact) {
  const raw = Number(rawProbability);
  if (!Number.isFinite(raw)) return rawProbability;
  const mode = String(artifact?.mode || 'identity');
  const mapping = Array.isArray(artifact?.mapping) ? artifact.mapping : null;
  const shrinkFactor = Number.isFinite(Number(artifact?.shrinkFactor))
    ? Number(artifact.shrinkFactor)
    : 0.5;

  const shrink = (p) => 0.5 + (p - 0.5) * (1 - shrinkFactor);

  if (mode === 'map' && mapping && mapping.length > 0) {
    return clamp(interpolate(mapping, raw), 0.05, 0.95);
  }
  if (mode === 'map_low_sample_shrink') {
    let base = mapping && mapping.length > 0 ? interpolate(mapping, raw) : raw;
    base = shrink(base);
    return clamp(base, 0.05, 0.95);
  }
  if (mode === 'shrink_toward_50') {
    return clamp(shrink(raw), 0.05, 0.95);
  }
  // identity
  return raw;
}

/**
 * Percent-scale convenience for replay (matches calibratePercent rounding).
 * @param {number} rawPercent 0-100
 * @param {object} artifact
 */
export function calibratePercentWithArtifact(rawPercent, artifact) {
  const raw = Number(rawPercent);
  if (!Number.isFinite(raw)) return rawPercent;
  const side = raw > 1 ? raw / 100 : raw;
  return Math.round(calibrateProbabilityWithArtifact(side, artifact) * 1000) / 10;
}

/** Build a frozen, serializable calibration artifact from the live loader. */
export function freezeCalibrationArtifact(market = 'moneyline') {
  const artifact = getCalibrationArtifact(market);
  const mapping = loadCalibrationMaps()[artifact.market] || null;
  return {
    market: artifact.market,
    mode: artifact.mode,
    mapping: mapping ? mapping.map((p) => [Number(p[0]), Number(p[1])]) : null,
    shrinkFactor: SHRINKAGE_FACTOR[artifact.market] ?? null,
    artifactHash: artifact.artifactHash,
    calibrationVersion: artifact.calibrationVersion
  };
}

/** Attach artifact identity onto a prediction object (mutates lightly). */
export function attachCalibrationIdentity(prediction, market = 'moneyline') {
  if (!prediction || typeof prediction !== 'object') return prediction;
  const artifact = getCalibrationArtifact(market);
  prediction.calibrationArtifact = artifact;
  prediction.calibrationVersion = artifact.calibrationVersion;
  if (!prediction.versions) prediction.versions = {};
  prediction.versions.calibration = artifact.calibrationVersion;
  return prediction;
}
