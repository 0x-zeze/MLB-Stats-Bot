/**
 * Immutable prediction snapshot helpers.
 *
 * A snapshot freezes the inputs needed to replay a deterministic decision
 * without network or wall-clock access. Schema is intentionally small so
 * live capture can grow field-by-field without breaking hash stability.
 */

import { createHash } from 'node:crypto';

export const SNAPSHOT_SCHEMA_VERSION = 1;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

export function hashPayload(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * Build a canonical snapshot object from a live prediction + context.
 * Does not mutate the prediction.
 */
export function buildPredictionSnapshot({
  prediction,
  dateYmd = null,
  asOfUtc = null,
  predictionTimestampUtc = null,
  firstPitchUtc = null,
  versions = {},
  features = null,
  quotes = null,
  config = null
} = {}) {
  if (!prediction?.gamePk) {
    throw new Error('buildPredictionSnapshot requires prediction.gamePk');
  }

  const body = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    gamePk: String(prediction.gamePk),
    dateYmd: dateYmd || prediction.dateYmd || null,
    asOfUtc: asOfUtc || prediction.asOfUtc || predictionTimestampUtc || null,
    predictionTimestampUtc:
      predictionTimestampUtc || prediction.predictionTimestampUtc || asOfUtc || null,
    firstPitchUtc:
      firstPitchUtc || prediction.startTime || prediction.firstPitchUtc || null,
    teams: {
      away: {
        id: prediction.away?.id ?? null,
        name: prediction.away?.name ?? null,
        abbreviation: prediction.away?.abbreviation ?? null
      },
      home: {
        id: prediction.home?.id ?? null,
        name: prediction.home?.name ?? null,
        abbreviation: prediction.home?.abbreviation ?? null
      }
    },
    features: features || prediction.featureSnapshot || null,
    quotes: quotes || {
      currentOdds: prediction.currentOdds || null,
      openingOdds: prediction.openingOdds || null
    },
    modelInputs: {
      pureAwayProbability:
        prediction.away?.pureModelProbability ??
        prediction.modelBreakdown?.pureAwayProbability ??
        null,
      pureHomeProbability:
        prediction.home?.pureModelProbability ??
        prediction.modelBreakdown?.pureHomeProbability ??
        null,
      modelBreakdown: prediction.modelBreakdown || null
    },
    decisionInputs: {
      valuePick: prediction.valuePick || null,
      betDecision: prediction.betDecision || null,
      moneylineValueOptions: prediction.moneylineValueOptions || []
    },
    versions: {
      modelVersion: versions.modelVersion || prediction.modelVersion || null,
      featureVersion: versions.featureVersion || prediction.featureVersion || null,
      calibrationVersion:
        versions.calibrationVersion || prediction.calibrationVersion || null,
      betPolicyVersion: versions.betPolicyVersion || prediction.betPolicyVersion || null
    },
    config: config || null
  };

  const snapshotHash = hashPayload(body);
  return {
    ...body,
    snapshotHash
  };
}

/**
 * Minimal deterministic decision projection for parity checks.
 * Replay of full predictGame is Phase 3 full extraction; this projects
 * already-computed decision fields from a frozen snapshot.
 */
export function projectDecisionFromSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('unsupported snapshot schema');
  }
  const value = snapshot.decisionInputs?.valuePick || null;
  const decision = snapshot.decisionInputs?.betDecision || null;
  const pureAway = snapshot.modelInputs?.pureAwayProbability;
  const pureHome = snapshot.modelInputs?.pureHomeProbability;

  return {
    gamePk: snapshot.gamePk,
    snapshotHash: snapshot.snapshotHash,
    pureAwayProbability: pureAway,
    pureHomeProbability: pureHome,
    valueSide: value?.side ?? null,
    valueTeamId: value?.teamId ?? null,
    valueTeamName: value?.teamName ?? null,
    modelProbability: value?.modelProbability ?? null,
    fairProbability: value?.fairProbability ?? null,
    edge: value?.edge ?? null,
    odds: value?.odds ?? null,
    book: value?.book ?? null,
    status: decision?.status ?? null,
    stake: value?.kellyStakePercent ?? null,
    versions: snapshot.versions || {},
    asOfUtc: snapshot.asOfUtc,
    firstPitchUtc: snapshot.firstPitchUtc
  };
}

export function assertReplayParity(left, right, fields = null) {
  const keys =
    fields ||
    [
      'gamePk',
      'snapshotHash',
      'pureAwayProbability',
      'pureHomeProbability',
      'valueSide',
      'valueTeamId',
      'modelProbability',
      'fairProbability',
      'edge',
      'odds',
      'status',
      'stake'
    ];
  const mismatches = [];
  for (const key of keys) {
    const a = left?.[key];
    const b = right?.[key];
    if (a !== b && !(Number.isFinite(a) && Number.isFinite(b) && Number(a) === Number(b))) {
      mismatches.push({ key, left: a, right: b });
    }
  }
  return {
    ok: mismatches.length === 0,
    mismatches
  };
}
