/**
 * Rolling average CLV gate + pure statistical summary & probation recovery helpers.
 *
 * Reporting always uses settled rows with a non-null CLV.
 * Gating (optional) protects against sustained negative CLV without whipsawing
 * on small-sample noise or permanently deadlocking real betting:
 *
 *   1. One-sided t-statistic against minAvgClv separates real degradation from
 *      small-sample noise (n >= minSample).
 *   2. Continuous stake throttling steps Kelly stakes down smoothly
 *      (1.0x -> 0.5x -> 0.25x -> 0x full block) as negative evidence grows.
 *   3. When a full block is active, a chronological combined tail of recent
 *      settled real + shadow_ledger rows provides smooth automatic probation
 *      recovery (re-entering cautiously at 0.5x stake without re-locking after
 *      the first successful probation real bet, while ignoring stale shadow
 *      bets from before the slump and re-blocking immediately if probation
 *      bets turn negative).
 */

export const DEFAULT_CLV_GATE = {
  enabled: true,
  minSample: 20,
  // Block/throttle reference floor (percent-implied units).
  minAvgClv: 0,
  // Look at most this many most-recent settled moneyline CLV rows.
  lookback: 50,
  // One-sided t-stat thresholds (negative = below minAvgClv).
  throttleHalfTStat: -0.75,
  throttleQuarterTStat: -1.25,
  blockTStat: -1.65,
  // Shadow-ledger probation recovery prevents permanent deadlock after a block.
  recoveryMinSample: 10,
  recoveryMinAvgClv: 0,
  recoveryThrottleMultiplier: 0.5
};

function num(value, fallback = null) {
  // Number(null) === 0 — reject null/undefined/''/boolean so missing CLV stays missing.
  if (value == null || value === '' || typeof value === 'boolean') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function rowTimestampMs(row) {
  const iso = row?.settled_at || row?.recommended_at || null;
  if (iso) {
    const ms = Date.parse(String(iso));
    if (Number.isFinite(ms)) return { ms, dateOnly: false };
  }
  const ymd = row?.date_ymd || null;
  if (ymd && /^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) {
    const ms = Date.parse(`${ymd}T00:00:00Z`);
    if (Number.isFinite(ms)) return { ms, dateOnly: true };
  }
  return null;
}

function filterSettledClvRows(rows, market) {
  const all = Array.isArray(rows) ? rows : [];
  return all.filter(
    (r) =>
      String(r?.status || '') === 'settled' &&
      (market == null || String(r?.market || 'moneyline') === market) &&
      num(r?.clv, null) != null
  );
}

/**
 * Summarize CLV from ledger-like rows, including sample stddev, standard error,
 * and one-sample t-statistic against referenceClv (default 0).
 * @param {Array<{status?:string, market?:string, clv?:number|null}>} rows
 * @param {{market?:string, lookback?:number, referenceClv?:number}} [opts]
 */
export function summarizeClv(rows, opts = {}) {
  const market = opts.market === undefined ? 'moneyline' : opts.market;
  const lookback = Math.max(1, Number(opts.lookback) || DEFAULT_CLV_GATE.lookback);
  const referenceClv = num(opts.referenceClv, 0) ?? 0;
  const settled = filterSettledClvRows(rows, market);
  // Prefer most-recent when rows carry recommended_at / settled_at ordering;
  // callers should pass already-ordered newest-last or we take the tail.
  const window = settled.slice(-lookback);
  const sample = window.length;
  const values = window.map((r) => num(r.clv, 0));
  const rawAvg = sample > 0 ? values.reduce((sum, v) => sum + v, 0) / sample : null;
  const avgClv = rawAvg == null ? null : round3(rawAvg);
  const positive = values.filter((v) => v > 0).length;
  const negative = values.filter((v) => v < 0).length;

  let stdClv = null;
  let seClv = null;
  let tStat = null;
  if (sample >= 2 && rawAvg != null) {
    const variance =
      values.reduce((sum, v) => sum + (v - rawAvg) ** 2, 0) / (sample - 1);
    const std = Math.sqrt(Math.max(0, variance));
    const se = std / Math.sqrt(sample);
    // Keep full floating-point precision on stdClv/seClv so tiny non-zero
    // standard errors are not prematurely rounded to 0 (which would force -Infinity).
    stdClv = std;
    seClv = se;
    if (se > 0) {
      tStat = round3((rawAvg - referenceClv) / se);
    } else if (rawAvg < referenceClv) {
      tStat = -Infinity;
    } else if (rawAvg > referenceClv) {
      tStat = Infinity;
    } else {
      tStat = 0;
    }
  }

  let latestSettledMs = null;
  let latestDateOnly = false;
  for (const row of window) {
    const ts = rowTimestampMs(row);
    if (ts && (latestSettledMs == null || ts.ms > latestSettledMs)) {
      latestSettledMs = ts.ms;
      latestDateOnly = ts.dateOnly;
    }
  }

  return {
    market,
    sample,
    coverage: sample,
    avgClv,
    rawAvgClv: rawAvg,
    stdClv,
    seClv,
    tStat,
    positive,
    negative,
    lookback,
    latestSettledMs,
    latestDateOnly
  };
}

/**
 * Summarize rows eligible for post-block probation recovery.
 *
 * Uses a chronological combined tail of recent settled real + shadow rows
 * (size `recoveryMinSample`) provided at least one shadow row occurred within
 * the recent `lookback` combined window:
 *   - No shadow rows / only stale shadow rows outside the recent window -> sample 0.
 *   - Stale shadow rows older than the blocking real slump -> tail is dominated by
 *     the negative real slump -> stays blocked.
 *   - Fresh post-block shadow rows with positive CLV -> unlocks probation.
 *   - Subsequent positive probation real bets remain part of the combined tail so
 *     probation stays open smoothly until the full real window lifts (no 1-bet re-lock).
 *   - Negative probation real bets quickly drag the tail < 0 -> re-blocks promptly.
 */
export function summarizeShadowRecoveryClv(realRows, shadowRows, opts = {}) {
  const market = opts.market === undefined ? 'moneyline' : opts.market;
  const lookback = Math.max(1, Number(opts.lookback) || DEFAULT_CLV_GATE.lookback);
  const recoveryWindowSize = Math.max(
    1,
    Number(opts.recoveryMinSample) || DEFAULT_CLV_GATE.recoveryMinSample
  );

  const settledReal = filterSettledClvRows(realRows, market);
  const settledShadow = filterSettledClvRows(shadowRows, market);
  if (settledShadow.length === 0) {
    return summarizeClv([], { ...opts, market, lookback: recoveryWindowSize });
  }

  const realTimed = settledReal.map((row, idx) => ({ row, isShadow: false, ts: rowTimestampMs(row), idx }));
  const shadowTimed = settledShadow.map((row, idx) => ({ row, isShadow: true, ts: rowTimestampMs(row), idx }));
  const hasRealTs = realTimed.some((entry) => entry.ts != null);
  const hasShadowTs = shadowTimed.some((entry) => entry.ts != null);

  if (!hasRealTs || !hasShadowTs) {
    return summarizeClv(settledShadow, { ...opts, market, lookback: recoveryWindowSize });
  }

  const combined = [...realTimed, ...shadowTimed]
    .filter((entry) => entry.ts != null)
    .sort((a, b) => {
      if (a.ts.ms !== b.ts.ms) return a.ts.ms - b.ts.ms;
      // On identical timestamp (e.g. same-day date-only), order shadow after real
      // so post-block same-day shadow rows appear at the tail.
      if (a.isShadow !== b.isShadow) return a.isShadow ? 1 : -1;
      return a.idx - b.idx;
    });

  const recentLookback = combined.slice(-Math.max(lookback, recoveryWindowSize));
  const hasRecentShadow = recentLookback.some((entry) => entry.isShadow);
  if (!hasRecentShadow) {
    return summarizeClv([], { ...opts, market, lookback: recoveryWindowSize });
  }

  const tail = recentLookback.slice(-recoveryWindowSize);
  const summary = summarizeClv(
    tail.map((entry) => entry.row),
    { ...opts, market, lookback: recoveryWindowSize }
  );
  return {
    ...summary,
    shadowCountInTail: tail.filter((entry) => entry.isShadow).length,
    realCountInTail: tail.filter((entry) => !entry.isShadow).length
  };
}

/**
 * Evaluate the rolling CLV gate with statistical significance (t-stat),
 * continuous stake throttling, and optional shadow-ledger probation recovery.
 */
export function evaluateClvGate(summary, config = {}, shadowSummary = null) {
  const cfg = { ...DEFAULT_CLV_GATE, ...(config || {}) };
  const enabled = cfg.enabled !== false && cfg.enabled !== 0 && cfg.enabled !== '0';
  if (!enabled) {
    return {
      status: 'open',
      blocked: false,
      stakeMultiplier: 1.0,
      recoveredViaShadow: false,
      tStat: null,
      reason: null,
      note: null
    };
  }

  const minSample = Math.max(1, Number(cfg.minSample) || DEFAULT_CLV_GATE.minSample);
  const minAvgClv = num(cfg.minAvgClv, DEFAULT_CLV_GATE.minAvgClv);
  if (minAvgClv == null) {
    return {
      status: 'open',
      blocked: false,
      stakeMultiplier: 1.0,
      recoveredViaShadow: false,
      tStat: null,
      reason: null,
      note: null
    };
  }

  const sample = Number(summary?.sample) || 0;
  const avgClv = num(summary?.rawAvgClv ?? summary?.avgClv, null);
  const displayAvgClv = num(summary?.avgClv, avgClv);
  if (sample < minSample || avgClv == null || avgClv >= minAvgClv) {
    return {
      status: 'open',
      blocked: false,
      stakeMultiplier: 1.0,
      recoveredViaShadow: false,
      tStat: summary?.tStat ?? null,
      reason: null,
      note: null
    };
  }

  // Compute effective one-sided t-stat against minAvgClv when variance info is present.
  // If a minimal synthetic summary ({ sample, avgClv }) without seClv/tStat is passed,
  // default to strict block for backward compatibility.
  let effectiveTStat = null;
  const seClv = num(summary?.seClv, null);
  if (seClv != null) {
    effectiveTStat = seClv > 0 ? round3((avgClv - minAvgClv) / seClv) : -Infinity;
  } else if (summary?.tStat === -Infinity || summary?.tStat === Infinity) {
    effectiveTStat = summary.tStat;
  } else if (num(summary?.tStat, null) != null) {
    effectiveTStat = num(summary.tStat, null);
  }

  const throttleHalfT = num(cfg.throttleHalfTStat, DEFAULT_CLV_GATE.throttleHalfTStat);
  const throttleQuarterT = num(cfg.throttleQuarterTStat, DEFAULT_CLV_GATE.throttleQuarterTStat);
  const blockT = num(cfg.blockTStat, DEFAULT_CLV_GATE.blockTStat);

  const avgText = `${displayAvgClv > 0 ? '+' : ''}${displayAvgClv.toFixed(2)}`;
  const floorText = `${minAvgClv > 0 ? '+' : ''}${Number(minAvgClv).toFixed(2)}`;
  const tSuffix =
    effectiveTStat != null && Number.isFinite(effectiveTStat)
      ? `, t=${effectiveTStat.toFixed(2)}`
      : '';

  // When statistical spread is known, ignore statistically indistinguishable noise.
  if (effectiveTStat != null && effectiveTStat > throttleHalfT) {
    return {
      status: 'open',
      blocked: false,
      stakeMultiplier: 1.0,
      recoveredViaShadow: false,
      tStat: effectiveTStat,
      reason: null,
      note: `rolling avg CLV ${avgText} within noise band (n=${sample}${tSuffix})`
    };
  }

  // Continuous throttling tiers before full block.
  if (effectiveTStat != null && effectiveTStat > blockT) {
    const stakeMultiplier = effectiveTStat > throttleQuarterT ? 0.5 : 0.25;
    return {
      status: 'throttled',
      blocked: false,
      stakeMultiplier,
      recoveredViaShadow: false,
      tStat: effectiveTStat,
      reason: null,
      note: `rolling CLV throttle ${stakeMultiplier}x: avg ${avgText} < ${floorText} (n=${sample}${tSuffix})`
    };
  }

  // Full block threshold reached — check shadow_ledger probation recovery so
  // real betting cannot deadlock permanently once CLV turns positive again.
  const recoveryMinSample = Math.max(
    1,
    Number(cfg.recoveryMinSample) || DEFAULT_CLV_GATE.recoveryMinSample
  );
  const recoveryMinAvgClv = num(cfg.recoveryMinAvgClv, DEFAULT_CLV_GATE.recoveryMinAvgClv) ?? 0;
  const rawRecoveryMult = num(
    cfg.recoveryThrottleMultiplier,
    DEFAULT_CLV_GATE.recoveryThrottleMultiplier
  );
  const recoveryMult = clamp(
    rawRecoveryMult != null ? rawRecoveryMult : DEFAULT_CLV_GATE.recoveryThrottleMultiplier,
    0.1,
    1.0
  );

  const shadowSample = Number(shadowSummary?.sample) || 0;
  const shadowAvg = num(shadowSummary?.rawAvgClv ?? shadowSummary?.avgClv, null);
  const displayShadowAvg = num(shadowSummary?.avgClv, shadowAvg);
  if (shadowSample >= recoveryMinSample && shadowAvg != null && shadowAvg >= recoveryMinAvgClv) {
    const shadowText = `${displayShadowAvg > 0 ? '+' : ''}${displayShadowAvg.toFixed(2)}`;
    return {
      status: 'probation_recovery',
      blocked: false,
      stakeMultiplier: recoveryMult,
      recoveredViaShadow: true,
      tStat: effectiveTStat,
      reason: null,
      note: `CLV gate probation recovery (${recoveryMult}x stake): recent recovery avg CLV ${shadowText} (n=${shadowSample})`
    };
  }

  return {
    status: 'blocked',
    blocked: true,
    stakeMultiplier: 0,
    recoveredViaShadow: false,
    tStat: effectiveTStat,
    reason: `rolling avg CLV ${avgText} < ${floorText} (n=${sample}${tSuffix})`,
    note: null
  };
}

/**
 * Decide whether rolling CLV should block new VALUE bets.
 * Returns null when gate is inactive / insufficient sample / open / throttled / recovered.
 * Returns a reason string when VALUE should be downgraded to NO BET.
 */
export function clvGateReason(summary, config = {}, shadowSummary = null) {
  const evaluation = evaluateClvGate(summary, config, shadowSummary);
  return evaluation.blocked ? evaluation.reason : null;
}

/**
 * Apply CLV gate onto a prediction already run through applyMoneylineValueMarket.
 * Idempotent: repeated calls always scale from the preserved unthrottled
 * `originalStakePercent` and restore it cleanly if the gate returns to `open`.
 * Never changes model probabilities / edge math / pick identity.
 */
export function applyClvGateToPrediction(prediction, summary, config = {}, shadowSummary = null) {
  if (!prediction?.betDecision) return prediction;
  if (prediction.betDecision.status !== 'VALUE') return prediction;

  const priorGate = prediction.betDecision.clvGate;
  const priorSlateCap = prediction.betDecision.slateExposureCap;
  const baseStake =
    num(priorGate?.originalStakePercent, null) ??
    num(priorSlateCap?.originalStakePercent, null) ??
    num(prediction.valuePick?.kellyStakePercent, null) ??
    num(prediction.betDecision?.kellyStakePercent, null);

  const evaluation = evaluateClvGate(summary, config, shadowSummary);

  if (evaluation.blocked) {
    const reason = evaluation.reason;
    const reasons = Array.isArray(prediction.betDecision.reasons)
      ? [...prediction.betDecision.reasons]
      : [];
    if (!reasons.includes(reason)) reasons.unshift(reason);

    // Preserve unthrottled stake on valuePick so shadow_ledger records true simulated stake.
    if (prediction.valuePick && baseStake != null) {
      prediction.valuePick = {
        ...prediction.valuePick,
        kellyStakePercent: baseStake
      };
    }

    const nextDecision = {
      ...prediction.betDecision,
      ...(prediction.betDecision.kellyStakePercent != null && baseStake != null
        ? { kellyStakePercent: baseStake }
        : {}),
      status: 'NO BET',
      reason,
      reasons,
      clvGate: {
        blocked: true,
        status: 'blocked',
        stakeMultiplier: 0,
        recoveredViaShadow: false,
        originalStakePercent: baseStake,
        adjustedStakePercent: 0,
        avgClv: summary?.avgClv ?? null,
        sample: summary?.sample ?? 0,
        tStat: evaluation.tStat,
        shadowAvgClv: shadowSummary?.avgClv ?? null,
        shadowSample: shadowSummary?.sample ?? 0,
        reason
      }
    };
    delete nextDecision.slateExposureCap;
    prediction.betDecision = nextDecision;
    return prediction;
  }

  if (evaluation.stakeMultiplier < 1.0) {
    const mult = evaluation.stakeMultiplier;
    const scaledStake =
      baseStake != null && baseStake > 0 ? Math.max(0.1, round1(baseStake * mult)) : baseStake;

    if (prediction.valuePick && baseStake != null) {
      prediction.valuePick = {
        ...prediction.valuePick,
        kellyStakePercent: scaledStake
      };
    }

    const nextDecision = {
      ...prediction.betDecision,
      ...(prediction.betDecision.kellyStakePercent != null ? { kellyStakePercent: scaledStake } : {}),
      clvGate: {
        blocked: false,
        status: evaluation.status,
        stakeMultiplier: mult,
        recoveredViaShadow: evaluation.recoveredViaShadow,
        originalStakePercent: baseStake,
        adjustedStakePercent: scaledStake,
        avgClv: summary?.avgClv ?? null,
        sample: summary?.sample ?? 0,
        tStat: evaluation.tStat,
        shadowAvgClv: shadowSummary?.avgClv ?? null,
        shadowSample: shadowSummary?.sample ?? 0,
        note: evaluation.note
      }
    };
    // Clear stale pre-throttle slate cap so applyDailySlateExposureCap recomputes
    // against the freshly throttled stake rather than resurrecting the old pre-CLV stake.
    delete nextDecision.slateExposureCap;
    prediction.betDecision = nextDecision;
    return prediction;
  }

  // Gate is open (1.0x): if a previous call had throttled this prediction, restore baseStake.
  if (priorGate && priorGate.originalStakePercent != null) {
    if (prediction.valuePick && baseStake != null) {
      prediction.valuePick = {
        ...prediction.valuePick,
        kellyStakePercent: baseStake
      };
    }
    const nextDecision = {
      ...prediction.betDecision,
      ...(prediction.betDecision.kellyStakePercent != null && baseStake != null
        ? { kellyStakePercent: baseStake }
        : {}),
      clvGate: {
        blocked: false,
        status: 'open',
        stakeMultiplier: 1.0,
        recoveredViaShadow: false,
        originalStakePercent: baseStake,
        adjustedStakePercent: baseStake,
        avgClv: summary?.avgClv ?? null,
        sample: summary?.sample ?? 0,
        tStat: evaluation.tStat,
        shadowAvgClv: shadowSummary?.avgClv ?? null,
        shadowSample: shadowSummary?.sample ?? 0,
        note: evaluation.note
      }
    };
    delete nextDecision.slateExposureCap;
    prediction.betDecision = nextDecision;
  }

  return prediction;
}
