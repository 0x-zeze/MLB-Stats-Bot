/**
 * Hard temporal data wall for historical evaluation.
 *
 * Every feature used in a promotion-eligible prediction must carry explicit
 * provenance. This module enforces, for each feature:
 *
 *   observedAt  — when the underlying event/statistic occurred
 *   availableAt — when the information became available to the system
 *   fetchedAt   — when the system retrieved it
 *   asOf        — the maximum permitted information timestamp for the prediction
 *
 * Rule: feature.availableAt <= predictionTimestamp (with a small clock-skew
 * allowance). A violation is a TemporalLeakageError, never a silent pass.
 *
 * Distinctions produced:
 *   - live_safe:            fresh, timestamped, usable for live prediction
 *   - promotion_safe:       additionally has full provenance for backtest
 *   - historical_unverified: value exists but availability cannot be proven
 *   - future / invalid:     timestamp after the allowed cutoff -> rejected
 */

import { parseUtcMs } from '../temporal_contract.js';

export const TEMPORAL_CLOCK_SKEW_MS = 2 * 60 * 1000;

export class TemporalLeakageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TemporalLeakageError';
    this.code = details.code || 'temporal_leakage';
    this.feature = details.feature || null;
    this.availableAt = details.availableAt ?? null;
    this.predictionTimestamp = details.predictionTimestamp ?? null;
    this.details = details;
  }
}

/** Machine-readable temporal error codes. */
export const TEMPORAL_CODES = {
  FUTURE_FEATURE: 'future_feature',
  AVAILABLE_AFTER_PREDICTION: 'available_after_prediction',
  MISSING_TIMESTAMP: 'missing_timestamp',
  INFERRED_TIMESTAMP: 'inferred_timestamp',
  UNVERIFIED_HISTORICAL: 'unverified_historical',
  MISSING_AS_OF: 'missing_as_of',
  AS_OF_AFTER_FIRST_PITCH: 'as_of_after_first_pitch'
};

function ms(value) {
  return parseUtcMs(value);
}

/**
 * Classify one feature's temporal provenance.
 * @param {object} feature { value, source, observedAt, availableAt, fetchedAt, inferred? }
 * @param {number|string|Date} predictionTimestamp
 * @param {object} [opts] { clockSkewMs, strict }
 * @returns {object} { status, liveSafe, promotionSafe, code|null }
 */
export function classifyFeatureProvenance(feature, predictionTimestamp, opts = {}) {
  const skew = Number.isFinite(opts.clockSkewMs) ? opts.clockSkewMs : TEMPORAL_CLOCK_SKEW_MS;
  const predMs = ms(predictionTimestamp);
  if (predMs == null) {
    return { status: 'invalid', liveSafe: false, promotionSafe: false, code: TEMPORAL_CODES.MISSING_TIMESTAMP };
  }

  const availableMs = ms(feature?.availableAt ?? feature?.fetchedAt ?? feature?.observedAt);
  const observedMs = ms(feature?.observedAt);
  const fetchedMs = ms(feature?.fetchedAt);
  const hasAnyTimestamp = availableMs != null || observedMs != null || fetchedMs != null;

  if (!hasAnyTimestamp) {
    return {
      status: 'missing_timestamp',
      liveSafe: false,
      promotionSafe: false,
      code: TEMPORAL_CODES.MISSING_TIMESTAMP
    };
  }

  const effectiveAvailable = availableMs ?? observedMs ?? fetchedMs;
  if (effectiveAvailable - predMs > skew) {
    return {
      status: 'future',
      liveSafe: false,
      promotionSafe: false,
      code: TEMPORAL_CODES.FUTURE_FEATURE
    };
  }

  const inferred = Boolean(feature?.inferred);
  const hasExplicitAvailable = ms(feature?.availableAt) != null;

  if (inferred) {
    return {
      status: 'inferred_timestamp',
      liveSafe: true,
      promotionSafe: false,
      code: TEMPORAL_CODES.INFERRED_TIMESTAMP
    };
  }

  // Promotion-safe requires an explicit availability timestamp, not just an
  // observed/fetched time (a boxscore 'observed' at game time is not proof the
  // lineup was available pre-game).
  const promotionSafe = hasExplicitAvailable;
  return {
    status: promotionSafe ? 'verified' : 'historical_unverified',
    liveSafe: true,
    promotionSafe,
    code: promotionSafe ? null : TEMPORAL_CODES.UNVERIFIED_HISTORICAL
  };
}

/**
 * Validate a whole snapshot's feature provenance against its prediction
 * timestamp. Throws TemporalLeakageError on a hard future violation; collects
 * non-fatal issues (missing/unverified/inferred) into a machine-readable list.
 *
 * @param {object} snapshot
 * @param {number|string|Date} [predictionTimestamp] defaults to snapshot.predictionTimestampUtc || asOfUtc
 * @param {object} [opts] { strict, clockSkewMs, featurePaths }
 * @returns {object} { ok, liveSafe, promotionEligible, errors, issues }
 */
export function validateTemporalSnapshot(snapshot, predictionTimestamp = null, opts = {}) {
  const predTs = predictionTimestamp ?? snapshot?.predictionTimestampUtc ?? snapshot?.asOfUtc;
  const predMs = ms(predTs);
  const errors = [];
  const issues = [];

  if (predMs == null) {
    issues.push({ code: TEMPORAL_CODES.MISSING_AS_OF, feature: null, message: 'no prediction timestamp / as_of' });
    return { ok: false, liveSafe: false, promotionEligible: false, errors, issues };
  }

  const firstPitchMs = ms(snapshot?.firstPitchUtc);
  if (firstPitchMs != null && predMs - firstPitchMs > (opts.clockSkewMs ?? TEMPORAL_CLOCK_SKEW_MS)) {
    issues.push({
      code: TEMPORAL_CODES.AS_OF_AFTER_FIRST_PITCH,
      feature: null,
      message: 'prediction timestamp is after first pitch'
    });
  }

  // Gather features: snapshot.features can be a map of name -> provenance
  // object, or coreInputs sub-objects. Only entries that look like provenance
  // records ({ observedAt/availableAt/fetchedAt }) are validated.
  const featureSources = [];
  const collect = (obj, prefix) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const looksTemporal =
          'observedAt' in value || 'availableAt' in value || 'fetchedAt' in value || 'inferred' in value;
        if (looksTemporal) {
          featureSources.push({ path, feature: value });
        } else if (Object.keys(value).length > 0 && path.split('.').length < 3) {
          collect(value, path);
        }
      }
    }
  };
  collect(snapshot?.features, 'features');

  let liveSafe = true;
  let promotionEligible = true;

  for (const { path, feature } of featureSources) {
    const result = classifyFeatureProvenance(feature, predTs, opts);
    if (result.code === TEMPORAL_CODES.FUTURE_FEATURE) {
      const err = new TemporalLeakageError(`future feature rejected: ${path}`, {
        code: result.code,
        feature: path,
        availableAt: feature.availableAt ?? feature.fetchedAt ?? feature.observedAt,
        predictionTimestamp: new Date(predMs).toISOString()
      });
      if (opts.strict) {
        throw err;
      }
      errors.push({ code: result.code, feature: path, message: err.message });
      liveSafe = false;
      promotionEligible = false;
    } else if (result.code) {
      issues.push({ code: result.code, feature: path, message: `${path}: ${result.status}` });
      if (!result.liveSafe) liveSafe = false;
      if (!result.promotionSafe) promotionEligible = false;
    }
  }

  return {
    ok: errors.length === 0,
    liveSafe,
    promotionEligible: promotionEligible && errors.length === 0,
    errors,
    issues,
    featureCount: featureSources.length
  };
}
