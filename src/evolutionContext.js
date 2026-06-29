import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function readJsonlFile(fileName) {
  const path = resolve(evolutionDataDir(), `${fileName}.jsonl`);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

export function readPredictionOutcomes() {
  const path = resolve(evolutionDataDir(), 'prediction_outcomes.csv');
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    if (raw.length < 2) return [];
    const header = parseCsvLine(raw[0]);
    const rows = [];
    for (let i = 1; i < raw.length; i++) {
      const values = parseCsvLine(raw[i]);
      const record = Object.fromEntries(header.map((name, index) => [name, values[index] ?? '']));
      const extras = values.slice(header.length);
      if (extras.length && header.includes('evaluation_json')) {
        record.evaluation_json = extras[extras.length - 1];
        if (extras.length >= 2) record.calibration_bucket = extras[extras.length - 2];
      }
      let evaluation = {};
      try { evaluation = JSON.parse(record.evaluation_json || '{}'); } catch {}
      rows.push({
        game_id: record.game_id,
        date: record.date,
        market: record.market,
        prediction: record.prediction,
        confidence: record.confidence,
        result: record.result,
        actual_score: record.actual_score,
        actual_total: Number(record.actual_total) || 0,
        profit_loss: Number(record.profit_loss) || 0,
        clv: record.clv ? Number(record.clv) : null,
        brier_score: record.brier_score ? Number(record.brier_score) : null,
        calibration_bucket: record.calibration_bucket,
        evaluation
      });
    }
    return rows;
  } catch {
    return [];
  }
}

let _cache = null;
let _cacheMtimes = {};

function getFileMtime(fileName) {
  const path = resolve(evolutionDataDir(), fileName);
  if (!existsSync(path)) return 0;
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

function isCacheValid() {
  if (!_cache) return false;
  const files = ['prediction_outcomes.csv', 'lessons.jsonl', 'language_losses.jsonl', 'audit_memory.json', 'weight_versions.json', 'approved_rules.json'];
  for (const f of files) {
    if (getFileMtime(f) !== (_cacheMtimes[f] || 0)) return false;
  }
  return true;
}

function saveMtimes() {
  const files = ['prediction_outcomes.csv', 'lessons.jsonl', 'language_losses.jsonl', 'audit_memory.json', 'weight_versions.json', 'approved_rules.json'];
  for (const f of files) {
    _cacheMtimes[f] = getFileMtime(f);
  }
}

function loadCalibrationSummary(outcomes, auditMemory) {
  const buckets = [];
  const seen = new Set();

  // Read calibration from approved_rules.json confidence_cap rules (use active_controls only to avoid duplicates)
  const approved = readJsonFile('approved_rules.json', { active_controls: [] });
  for (const rule of (approved.active_controls || [])) {
    const target = String(rule.target || rule.parameters?.probability_bucket || '');
    if (!target.startsWith('probability:')) continue;
    if (seen.has(target)) continue;
    const evidence = rule.evidence || {};
    if (!evidence.sample_size) continue;
    seen.add(target);
    buckets.push({
      bucket: target,
      sampleSize: evidence.sample_size || 0,
      wins: evidence.wins || 0,
      losses: evidence.losses || 0,
      avgPredicted: evidence.avg_predicted_probability ? Math.round(evidence.avg_predicted_probability * 10) / 10 : null,
      observedWinRate: evidence.observed_win_rate ? Math.round(evidence.observed_win_rate * 10) / 10 : null,
      error: evidence.calibration_error ? Math.round(evidence.calibration_error * 10) / 10 : null,
      verdict: evidence.verdict || 'unknown'
    });
  }

  // Also read from audit_memory segment patterns
  const patterns = auditMemory?.mistake_patterns || [];
  for (const p of patterns) {
    if (p.segment && p.segment.segment && p.segment.segment.startsWith('probability:')) {
      const seg = p.segment;
      const exists = buckets.some((b) => b.bucket === seg.segment);
      if (!exists) {
        buckets.push({
          bucket: seg.segment,
          sampleSize: seg.sample_size || 0,
          wins: seg.wins || 0,
          losses: seg.losses || 0,
          avgPredicted: null,
          observedWinRate: seg.accuracy ? Math.round(seg.accuracy * 10) / 10 : null,
          error: null,
          verdict: seg.verdict || 'unknown'
        });
      }
    }
  }

  // Edge-based analysis from outcomes
  const edgeBuckets = { 'edge:weak <2': { wins: 0, losses: 0 }, 'edge:moderate 2-4': { wins: 0, losses: 0 }, 'edge:strong >=4': { wins: 0, losses: 0 } };
  for (const row of outcomes) {
    const edge = row.evaluation?.edge ?? 0;
    let bucket = 'edge:strong >=4';
    if (edge < 2) bucket = 'edge:weak <2';
    else if (edge < 4) bucket = 'edge:moderate 2-4';
    if (row.result === 'win') edgeBuckets[bucket].wins += 1;
    else edgeBuckets[bucket].losses += 1;
  }
  for (const [label, data] of Object.entries(edgeBuckets)) {
    const total = data.wins + data.losses;
    if (total >= 3) {
      buckets.push({
        bucket: label,
        sampleSize: total,
        wins: data.wins,
        losses: data.losses,
        avgPredicted: null,
        observedWinRate: Math.round((data.wins / total) * 100 * 10) / 10,
        error: null,
        verdict: data.wins / total < 0.45 ? 'underperforming' : 'ok'
      });
    }
  }

  const overconfident = buckets.filter((b) => b.verdict === 'overconfident');
  const summary = overconfident.length > 0
    ? `Overconfident: ${overconfident.map((b) => `${b.bucket} (${b.observedWinRate}% actual, n=${b.sampleSize})`).join('; ')}.`
    : buckets.length > 0
      ? 'Model calibration data available from audit system.'
      : 'No calibration data available yet.';

  return { buckets, summary };
}

const FACTOR_KEYWORDS = {
  starting_pitcher: ['sp', 'starter', 'pitcher', 'era', 'whip', 'k-bb', 'hr/9'],
  offense: ['offense', 'ops', 'iso', 'r/g', 'run creation', 'bat', 'hitter'],
  bullpen: ['bullpen', 'reliever', 'late-game', 'back-to-back', 'fatigue'],
  lineup: ['lineup', 'confirmed', 'projected', 'batting order'],
  market_edge: ['market', 'odds', 'value', 'implied', 'edge', 'clv', 'line movement'],
  record_context: ['record', 'h2h', 'l10', 'recent', 'streak', 'form', 'series'],
  weather: ['weather', 'wind', 'temperature', 'roof'],
  park_factor: ['park', 'venue', 'ballpark'],
  data_quality: ['quality', 'missing', 'stale', 'unavailable']
};

function loadFactorReliability(outcomes, losses, rawPatterns) {
  const factorStats = {};

  // Read factor reliability from audit_memory.json mistake_patterns with reason_quality
  const patterns = rawPatterns || [];
  for (const p of patterns) {
    if (p.reason_quality && p.reason_quality.factor) {
      const rq = p.reason_quality;
      factorStats[rq.factor] = {
        factor: rq.factor,
        sampleSize: rq.sample_size || 0,
        wins: rq.wins || 0,
        losses: rq.losses || 0,
        lossMentions: rq.loss_mentions || 0,
        accuracy: rq.accuracy || 0,
        verdict: rq.verdict || 'unknown'
      };
    }
  }

  // Also extract from outcomes using main_factors if available
  for (const row of outcomes) {
    const mainFactors = row.evaluation?.main_factors || [];
    for (const mf of mainFactors) {
      const mfLower = String(mf).toLowerCase();
      for (const [factor, keywords] of Object.entries(FACTOR_KEYWORDS)) {
        if (keywords.some((kw) => mfLower.includes(kw))) {
          if (!factorStats[factor]) {
            factorStats[factor] = { factor, sampleSize: 0, wins: 0, losses: 0, lossMentions: 0, accuracy: 0, verdict: 'unknown' };
          }
          factorStats[factor].sampleSize += 1;
          if (row.result === 'win') factorStats[factor].wins += 1;
          else factorStats[factor].losses += 1;
        }
      }
    }
  }

  // Recalculate accuracy for factors derived from outcomes
  for (const f of Object.values(factorStats)) {
    if (f.sampleSize > 0 && f.accuracy === 0) {
      f.accuracy = Math.round((f.wins / f.sampleSize) * 100 * 10) / 10;
    }
    if (f.verdict === 'unknown' && f.sampleSize >= 3) {
      if (f.accuracy < 45) f.verdict = 'weak_signal';
      else if (f.accuracy < 55) f.verdict = 'needs_review';
      else f.verdict = 'useful_signal';
    }
  }

  const factors = Object.values(factorStats)
    .filter((f) => f.sampleSize >= 3)
    .sort((a, b) => a.accuracy - b.accuracy);

  const weak = factors.filter((f) => f.verdict !== 'useful_signal' && f.verdict !== 'unknown');
  const summary = weak.length > 0
    ? `Weakest factors: ${weak.map((f) => `${f.factor} ${f.accuracy}% (n=${f.sampleSize})`).join(', ')}.`
    : factors.length > 0
      ? 'All tracked factors show useful signal.'
      : 'No factor reliability data available yet.';

  return { factors, summary };
}

function loadRecentLessons(allLessons, limit = 5) {
  const recent = allLessons.slice(-limit).reverse();
  return {
    lessons: recent.map((l) => ({
      gameId: l.game_id,
      lessonType: l.lesson_type,
      prediction: l.prediction,
      result: l.result,
      summary: l.summary,
      suggestedAdjustment: l.suggested_adjustment,
      supportingData: l.supporting_data || {},
      keyQuestions: (l.self_questions || []).map((q) => q.question).slice(0, 3)
    }))
  };
}

function loadAuditMemoryContext() {
  const memory = readJsonFile('audit_memory.json', {
    mistake_patterns: [],
    next_game_cautions: []
  });

  const rawPatterns = memory.mistake_patterns || [];
  return {
    cautions: Array.isArray(memory.next_game_cautions) ? memory.next_game_cautions : [],
    mistakePatterns: rawPatterns.map((p) => ({
      patternId: p.pattern_id,
      type: p.type,
      factor: p.factor,
      caution: p.caution,
      count: p.count,
      severity: p.severity,
      accuracy: p.reason_quality?.accuracy ?? null,
      sampleSize: p.reason_quality?.sample_size ?? p.segment?.sample_size ?? p.count,
      verdict: p.reason_quality?.verdict ?? p.segment?.verdict ?? null
    })),
    _rawPatterns: rawPatterns,
    sampleSize: memory.sample || {}
  };
}

function loadSegmentWarnings(outcomes) {
  const segments = {};

  for (const row of outcomes) {
    const confidence = row.confidence || 'unknown';
    const edge = row.evaluation?.edge ?? 0;
    let edgeBucket = 'edge:strong >=4';
    if (edge < 2) edgeBucket = 'edge:weak <2';
    else if (edge < 4) edgeBucket = 'edge:moderate 2-4';

    for (const segKey of [`confidence:${confidence}`, edgeBucket]) {
      if (!segments[segKey]) {
        segments[segKey] = { segment: segKey, sampleSize: 0, wins: 0, losses: 0 };
      }
      segments[segKey].sampleSize += 1;
      if (row.result === 'win') segments[segKey].wins += 1;
      else segments[segKey].losses += 1;
    }
  }

  const weakSegments = Object.values(segments)
    .filter((s) => s.sampleSize >= 3)
    .map((s) => ({
      ...s,
      lossRate: Math.round((s.losses / s.sampleSize) * 100 * 10) / 10,
      accuracy: Math.round((s.wins / s.sampleSize) * 100 * 10) / 10
    }))
    .filter((s) => s.lossRate >= 55)
    .sort((a, b) => b.lossRate - a.lossRate);

  return { weakSegments };
}

function loadModelVersion() {
  const approved = readJsonFile('approved_rules.json', { active_rule_version: 'rules-v1.0' });
  const weights = readJsonFile('weight_versions.json', { active_version: 'weights-v1.0' });
  return {
    activeRuleVersion: approved.active_rule_version || 'rules-v1.0',
    activeWeightVersion: weights.active_version || 'weights-v1.0'
  };
}

function buildEvolutionSummary(calibration, factorReliability, lessons, sampleSize) {
  const parts = [];
  if (sampleSize.totalEvaluated > 0) {
    parts.push(`${sampleSize.totalEvaluated} predictions evaluated.`);
  }
  const overconfident = calibration.buckets.filter((b) => b.verdict === 'overconfident');
  if (overconfident.length > 0) {
    parts.push(`Overconfident at ${overconfident.map((b) => b.bucket).join(', ')}.`);
  }
  const weakFactors = factorReliability.factors.filter((f) => f.verdict !== 'useful_signal');
  if (weakFactors.length > 0) {
    parts.push(`Weak factors: ${weakFactors.map((f) => f.factor).join(', ')}.`);
  }
  const recentWrong = lessons.lessons.filter((l) => l.lessonType === 'wrong_pick').length;
  if (recentWrong > 0) {
    parts.push(`${recentWrong}/${lessons.lessons.length} recent picks were wrong.`);
  }
  return parts.join(' ') || 'No evolution data available yet.';
}

export function buildEvolutionContext() {
  if (isCacheValid()) return _cache;

  const activeMarket = 'moneyline';
  const activeMarkets = new Set(['moneyline', 'yrfi']);
  const allOutcomes = readPredictionOutcomes().filter((row) => activeMarkets.has(String(row.market || 'moneyline').toLowerCase()));
  const outcomes = allOutcomes.filter((row) => String(row.market || 'moneyline').toLowerCase() === activeMarket);
  const losses = readJsonlFile('language_losses').filter((row) => String(row.market || 'moneyline').toLowerCase() === activeMarket);
  const allLessons = readJsonlFile('lessons').filter((row) => String(row.market || 'moneyline').toLowerCase() === activeMarket);
  const lessons = loadRecentLessons(allLessons, 5);
  const auditMemory = loadAuditMemoryContext();
  const calibration = loadCalibrationSummary(outcomes, auditMemory);
  const factorReliability = loadFactorReliability(outcomes, losses, auditMemory._rawPatterns);
  const segmentWarnings = loadSegmentWarnings(outcomes);
  const modelVersion = loadModelVersion();

  const sampleSize = {
    totalEvaluated: outcomes.length,
    activeMarkets: ['moneyline', 'yrfi'],
    contextMarket: activeMarket,
    totalLessons: allLessons.length,
    totalLosses: losses.length
  };

  const evolutionSummary = buildEvolutionSummary(calibration, factorReliability, lessons, sampleSize);

  const { _rawPatterns: _, ...auditMemoryClean } = auditMemory;
  _cache = {
    calibration,
    factorReliability,
    recentLessons: lessons,
    auditMemory: auditMemoryClean,
    segmentWarnings,
    modelVersion,
    sampleSize,
    evolutionSummary,
    calibrationForProbability(prob) {
      if (!prob || prob < 50) return null;
      const bucket = calibration.buckets.find((b) => {
        if (b.avgPredicted != null) {
          return prob >= (b.avgPredicted - 3) && prob < (b.avgPredicted + 5);
        }
        const match = (b.bucket || '').match(/probability:(\d+)\+?/);
        if (match) return prob >= Number(match[1]);
        return false;
      });
      return bucket && bucket.verdict !== 'calibrated' ? bucket : null;
    },
    factorWarningsForBreakdown(breakdown) {
      if (!breakdown) return [];
      const presentFactors = new Set(
        Object.keys(breakdown).map((k) => k.replace(/Edge$|Factor$/, '').toLowerCase())
      );
      return factorReliability.factors
        .filter((f) => f.verdict !== 'useful_signal')
        .filter((f) => presentFactors.has(f.factor) || presentFactors.has(f.factor.replace('_', '')))
        .map((f) => ({
          factor: f.factor,
          accuracy: f.accuracy,
          sampleSize: f.sampleSize,
          verdict: f.verdict,
          caution: `${f.factor} factor: ${f.accuracy}% accuracy in ${f.sampleSize} games (${f.verdict}).`
        }));
    },
    segmentWarningForGame(item) {
      if (!item) return null;
      const prob = item.winner?.winProbability || 0;
      const edge = item.modelBreakdown?.modelProbabilityEdge || 0;
      const warnings = [];
      for (const seg of segmentWarnings.weakSegments) {
        if (seg.segment.startsWith('confidence:') && prob >= 60 && prob < 70) {
          warnings.push(seg);
        }
        if (seg.segment.startsWith('edge:') && edge < 4) {
          warnings.push(seg);
        }
      }
      return warnings.length > 0 ? warnings : null;
    }
  };

  saveMtimes();
  return _cache;
}
