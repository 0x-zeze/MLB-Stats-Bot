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
 */
export function calibrateProbability(rawProbability, market = 'moneyline') {
  const marketKey = String(market).trim().toLowerCase();
  if (usesLowSampleShrinkage(marketKey)) {
    return clamp(shrinkTowardHalf(rawProbability, marketKey), 0.05, 0.95);
  }

  const mapping = loadCalibrationMaps()[marketKey];
  if (!mapping || mapping.length === 0) return rawProbability;
  const calibrated = interpolate(mapping, rawProbability);
  return clamp(calibrated, 0.05, 0.95);
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
  const mapping = loadCalibrationMaps()[String(market).trim().toLowerCase()];
  return Array.isArray(mapping) && mapping.length > 0;
}
