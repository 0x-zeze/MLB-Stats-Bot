import { clamp, toNumber } from './utils.js';
import {
  ANALYST_INTERACTIVE_PROMPT,
  ANALYST_SKILL_VERSION,
  ANALYST_SYSTEM_PROMPT
} from './analystSkill.js';
import { uiKV, uiTitle } from './telegramFormat.js';
import { getCalibrationPenalty, loadEvolutionControls } from './evolutionControls.js';
import { calibratePercent, hasCalibrationMap } from './calibration.js';

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function llmBaseUrl(config) {
  if (config.openai.baseUrl) return trimSlash(config.openai.baseUrl);

  const keyLooksLikeGateway = config.openai.apiKey.startsWith('sk-or-');
  const modelLooksLikeGateway = config.openai.model.includes('/');
  if (keyLooksLikeGateway || modelLooksLikeGateway) {
    return 'https://openrouter.ai/api/v1';
  }

  return 'https://api.openai.com/v1';
}

function useChatCompletions(config) {
  const baseUrl = llmBaseUrl(config);
  return baseUrl !== 'https://api.openai.com/v1' || config.openai.model.includes('/');
}

function extractJson(text) {
  if (!text) return null;

  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

async function callLlm(config, { system, user, maxTokens = 900, timeoutMs = 45000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const baseUrl = llmBaseUrl(config);

  try {
    if (useChatCompletions(config)) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.openai.apiKey}`
        },
        body: JSON.stringify({
          model: config.openai.model,
          temperature: 0.2,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        })
      });

      if (!response.ok) return null;
      const data = await response.json();
      return data.choices?.[0]?.message?.content?.trim() || null;
    }

    const response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openai.apiKey}`
      },
      body: JSON.stringify({
        model: config.openai.model,
        store: false,
        temperature: 0.2,
        max_output_tokens: maxTokens,
        instructions: system,
        input: user
      })
    });

    if (!response.ok) return null;
    const data = await response.json();
    if (data.output_text) return data.output_text.trim();

    return (
      data.output
        ?.flatMap((item) => item.content || [])
        ?.filter((item) => item.type === 'output_text' && item.text)
        ?.map((item) => item.text)
        ?.join('\n')
        ?.trim() || null
    );
  } finally {
    clearTimeout(timer);
  }
}

function compactGameForAgent(item, evolutionData) {
  return {
    gamePk: item.gamePk,
    matchup: `${item.away.name} @ ${item.home.name}`,
    start: item.start,
    venue: item.venue,
    away: {
      id: item.away.id,
      name: item.away.name,
      abbreviation: item.away.abbreviation,
      baselineProbability: Math.round(item.away.winProbability)
    },
    home: {
      id: item.home.id,
      name: item.home.name,
      abbreviation: item.home.abbreviation,
      baselineProbability: Math.round(item.home.winProbability)
    },
    baselinePick: item.winner.name,
    deterministicPipeline: {
      numericAuthority: 'model_only',
      pickTeamId: item.winner.id,
      pickTeamName: item.winner.name,
      awayProbability: Math.round(item.away.winProbability),
      homeProbability: Math.round(item.home.winProbability),
      totalRuns: item.totalRuns,
      modelBreakdown: item.modelBreakdown,
      modelBreakdownLine: item.modelBreakdownLine,
      currentOdds: item.currentOdds,
      valuePick: item.valuePick,
      betDecision: item.betDecision,
      auditMemoryNotes: item.auditMemoryNotes,
      rule: 'LLM may explain and flag risk, but must not invent probabilities or totals.'
    },
    signalPriority: {
      tier1: ['probable pitchers', 'confirmed lineup/player availability', 'team offense', 'bullpen usage', 'park factor', 'market odds/value'],
      tier2: ['weather', 'platoon splits', 'recent form', 'Pythagorean/Log5'],
      tier3: ['team record', 'previous series winner', 'head-to-head trends', 'public betting percentage']
    },
    headToHead: {
      games: item.headToHead?.games || 0,
      awayWins: item.headToHead?.awayWins || 0,
      homeWins: item.headToHead?.homeWins || 0,
      awayProbability: Math.round(item.headToHead?.awayProbability || 50),
      homeProbability: Math.round(item.headToHead?.homeProbability || 50)
    },
    starters: {
      away: item.away.starterLine,
      home: item.home.starterLine
    },
    context: item.contextLine,
    matchupSplits: item.matchupSplitLine,
    bullpen: item.bullpenLine,
    bullpenDetail: item.bullpen,
    injuries: item.injuries,
    injurySummary: item.injuryLine,
    injuryDetails: item.injuryDetailLines,
    lineupSummary: item.lineupLine,
    lineups: item.lineups,
    pitcherRecent: item.pitcherRecentLine,
    pitcherRecentDetail: item.pitcherRecent,
    advanced: item.advancedLine,
    modelReference: item.modelReference,
    modelReferenceLine: item.modelReferenceLine,
    modelReferenceLines: item.modelReferenceLines,
    modelBreakdown: item.modelBreakdown,
    modelBreakdownLine: item.modelBreakdownLine,
    currentOdds: item.currentOdds,
    valuePick: item.valuePick,
    moneylineValueOptions: item.moneylineValueOptions,
    betDecision: item.betDecision,
    auditMemoryNotes: item.auditMemoryNotes,
    totalRuns: item.totalRuns,
    baselineReasons: item.reasons,
    firstInning: item.firstInning
      ? {
          baselinePick: item.firstInning.baselinePick,
          baselineProbability: Math.round(item.firstInning.baselineProbability),
          topRate: Math.round(item.firstInning.topRate),
          bottomRate: Math.round(item.firstInning.bottomRate),
          h2h: item.firstInning.h2h,
          awayProfileLine: item.firstInning.awayProfileLine,
          homeProfileLine: item.firstInning.homeProfileLine,
          baselineReasons: item.firstInning.reasons
        }
      : null,
    memoryAdjustment: item.memoryAdjustment,
    matchupMemory: item.matchupMemory
      ? {
          games: item.matchupMemory.games,
          edgeTeam: item.matchupMemory.edgeTeam,
          edge: item.matchupMemory.edge,
          note: item.matchupMemory.note,
          currentStreak: item.matchupMemory.currentStreak,
          alternating: item.matchupMemory.alternating,
          averageMargin: item.matchupMemory.averageMargin,
          pickStats: item.matchupMemory.pickStats,
          recentGames: item.matchupMemory.recentGames
        }
      : null,
    agentAnalysis: item.agentAnalysis
      ? {
          pickTeamName: item.agentAnalysis.pickTeamName,
          awayProbability: item.agentAnalysis.awayProbability,
          homeProbability: item.agentAnalysis.homeProbability,
          confidence: item.agentAnalysis.confidence,
          reasons: item.agentAnalysis.reasons,
          risk: item.agentAnalysis.risk,
          memoryNote: item.agentAnalysis.memoryNote
        }
      : null,
    weatherDetail: item.weather || null,
    travelFatigue: item.scheduleFatigue || null,
    sharpMoneyDetail: item.modelBreakdown?.sharpMoney || null,
    dataQualityIndicators: {
      pitchersConfirmed: Boolean(item.away?.starter && item.home?.starter),
      lineupsConfirmed: Boolean(item.lineups?.away?.confirmed && item.lineups?.home?.confirmed),
      weatherAvailable: item.totalRuns?.detail?.weather !== undefined,
      oddsAvailable: Boolean(item.currentOdds?.awayMoneyline || item.currentOdds?.homeMoneyline)
    },
    evolutionContext: evolutionData && typeof evolutionData.calibrationForProbability === 'function'
      ? {
          calibrationWarning: evolutionData.calibrationForProbability(item.winner?.winProbability),
          factorWarnings: evolutionData.factorWarningsForBreakdown(item.modelBreakdown),
          segmentCaution: evolutionData.segmentWarningForGame(item)
        }
      : null
  };
}

function normalizeProbability(value, fallback) {
  return clamp(Math.round(toNumber(value, fallback)), 20, 80);
}

function deterministicConfidenceFromProbability(value) {
  const probability = normalizeProbability(value, 50);
  const edge = Math.abs(probability - 50);
  if (edge >= 12) return 'high';
  if (edge >= 6) return 'medium';
  return 'low';
}

function confidenceRank(label) {
  return { low: 1, medium: 2, high: 3 }[String(label || '').toLowerCase()] || 1;
}

function capConfidence(label, cap) {
  return confidenceRank(label) <= confidenceRank(cap) ? label : cap;
}

function deterministicConfidenceFromPrediction(prediction, value) {
  return multiFactorConfidence(prediction, value);
}

function multiFactorConfidence(prediction, probability, evolutionControls) {
  if (!evolutionControls) evolutionControls = loadEvolutionControls();
  let score = 0;
  const edge = Math.abs(normalizeProbability(probability, 50) - 50);
  const breakdown = prediction.modelBreakdown || {};

  score += edge >= 12 ? 4 : edge >= 8 ? 3 : edge >= 5 ? 2 : edge >= 3 ? 1 : 0;

  const pickDirection = normalizeProbability(probability, 50) >= 50 ? 1 : -1;
  const components = [
    toNumber(breakdown.matchupEdge, 0),
    toNumber(breakdown.starterEdge, 0),
    toNumber(breakdown.offenseEdge, 0),
    toNumber(breakdown.bullpenEdge, 0),
    toNumber(breakdown.lineupEdge, 0)
  ];
  const agreeing = components.filter(c => c * pickDirection > 0.02).length;
  score += agreeing >= 4 ? 3 : agreeing >= 3 ? 2 : agreeing >= 2 ? 1 : 0;

  const lineups = [prediction.lineups?.away, prediction.lineups?.home].filter(Boolean);
  const bothConfirmed = lineups.length === 2 && lineups.every(l => l.confirmed && toNumber(l.count, 0) >= 9);
  const hasPitchers = Boolean(prediction.away?.starter && prediction.home?.starter);
  score += (bothConfirmed ? 1 : 0) + (hasPitchers ? 1 : 0);

  const sharp = breakdown.sharpMoney;
  if (sharp?.direction === 'toward_model') score += 1;
  if (sharp?.direction === 'against_model' && toNumber(sharp?.magnitude, 0) >= 15) score -= 1;

  const calibrationPenalty = getCalibrationPenalty(normalizeProbability(probability, 50), evolutionControls);
  score += calibrationPenalty;

  if (breakdown.recordDominated) score -= 2;

  if (edge >= 5 && edge < 8 && agreeing <= 1) return 'low';

  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

function resolveTeamId(value, prediction) {
  const numeric = Number(value);
  if (numeric === prediction.away.id || numeric === prediction.home.id) return numeric;

  const text = String(value || '').toLowerCase();
  if (!text) return null;

  const awayTokens = [prediction.away.name, prediction.away.abbreviation]
    .filter(Boolean)
    .map((item) => item.toLowerCase());
  const homeTokens = [prediction.home.name, prediction.home.abbreviation]
    .filter(Boolean)
    .map((item) => item.toLowerCase());

  if (awayTokens.some((token) => text === token || text.includes(token))) return prediction.away.id;
  if (homeTokens.some((token) => text === token || text.includes(token))) return prediction.home.id;

  return null;
}

function probabilityFromObject(raw, prediction, side) {
  const team = side === 'away' ? prediction.away : prediction.home;
  const containers = [
    raw?.probability,
    raw?.probabilities,
    raw?.winProbability,
    raw?.winProbabilities,
    raw?.agentProbability,
    raw?.agentProbabilities
  ].filter(Boolean);

  for (const container of containers) {
    const value =
      container[side] ??
      container[team.name] ??
      container[team.abbreviation] ??
      container[team.id] ??
      container[String(team.id)];

    if (value !== undefined) return value;
  }

  return undefined;
}

function normalizeYesNo(value, fallback = 'NO') {
  const text = String(value || fallback).toLowerCase();
  if (['yes', 'yrfi', 'y', 'run', 'ada', 'over'].some((token) => text.includes(token))) {
    return 'YES';
  }
  if (['no', 'nrfi', 'n', 'tidak', 'under'].some((token) => text.includes(token))) {
    return 'NO';
  }
  return fallback;
}

function sanitizeFirstInningAnalysis(prediction, raw) {
  const source =
    raw?.firstInning ??
    raw?.first_inning ??
    raw?.yrfiNrfi ??
    raw?.yrfi_nrfi ??
    raw?.firstInningRun ??
    null;

  const baseline = prediction.firstInning || {};
  const deterministicPick = baseline.baselinePick || 'NO';
  const deterministicProbability = clamp(
    Math.round(toNumber(baseline.baselineProbability, 50)),
    20,
    80
  );
  if (!source || typeof source !== 'object') {
    return {
      pick: deterministicPick,
      probability: deterministicProbability,
      confidence: deterministicConfidenceFromProbability(deterministicProbability),
      reasons: baseline.reasons || []
    };
  }

  const reasons = Array.isArray(source.reasons)
    ? source.reasons.map((item) => String(item).trim()).filter(Boolean).slice(0, 3)
    : baseline.reasons || [];

  return {
    pick: deterministicPick,
    probability: deterministicProbability,
    confidence: deterministicConfidenceFromProbability(deterministicProbability),
    reasons,
    risk: String(source.risk || '').slice(0, 180)
  };
}

function applyAgentProbabilityShift(deterministicAway, deterministicHome, raw, prediction) {
  const adjustment = raw?.probabilityAdjustment;
  if (!adjustment || typeof adjustment !== 'object') {
    return { awayProbability: deterministicAway, homeProbability: deterministicHome, shift: 0, reason: null, applied: false };
  }

  const rawShift = clamp(toNumber(adjustment.shift, 0), -5, 5);
  const reason = String(adjustment.reason || '').trim();

  if (Math.abs(rawShift) < 0.5 || reason.length < 15) {
    return { awayProbability: deterministicAway, homeProbability: deterministicHome, shift: 0, reason: reason || null, applied: false };
  }

  const pickTeamId = prediction.winner.id;
  const pickIsHome = pickTeamId === prediction.home.id;
  const pickProbability = pickIsHome ? deterministicHome : deterministicAway;
  const adjustedPick = clamp(pickProbability + rawShift, 20, 80);

  if ((pickProbability >= 50 && adjustedPick < 50) || (pickProbability < 50 && adjustedPick >= 50)) {
    return { awayProbability: deterministicAway, homeProbability: deterministicHome, shift: 0, reason: 'rejected: would flip winner', applied: false };
  }

  const adjustedAway = pickIsHome ? 100 - adjustedPick : adjustedPick;
  const adjustedHome = pickIsHome ? adjustedPick : 100 - adjustedPick;

  return {
    awayProbability: clamp(Math.round(adjustedAway), 20, 80),
    homeProbability: clamp(Math.round(adjustedHome), 20, 80),
    shift: rawShift,
    reason,
    applied: true
  };
}

function applyAgentBetOverride(prediction, raw, analysis) {
  const override = raw?.betOverride;
  if (!override || typeof override !== 'object') return null;

  const action = String(override.action || '').toLowerCase();
  const reason = String(override.reason || '').trim();
  if (!reason || reason.length < 10) return null;

  const currentDecision = prediction.betDecision || {};
  const currentStatus = String(currentDecision.status || 'LEAN ONLY').toUpperCase();

  if (action === 'downgrade_to_no_bet') {
    return {
      type: 'downgrade',
      accepted: true,
      previousStatus: currentStatus,
      newStatus: 'NO BET',
      reason
    };
  }

  if (action === 'upgrade_to_value') {
    const edge = toNumber(currentDecision.edge ?? prediction.valuePick?.edge, 0);
    const confidence = analysis?.confidence || 'low';
    const existingReasons = currentDecision.reasons || [];
    const shiftApplied = analysis?.probabilityShift?.applied || false;
    const shiftPositive = toNumber(analysis?.probabilityShift?.shift, 0) >= 0;

    if (edge < 1.5) return { type: 'upgrade', accepted: false, reason: 'rejected: model edge < 1.5%' };
    if (confidenceRank(confidence) < 2) return { type: 'upgrade', accepted: false, reason: 'rejected: confidence too low' };
    if (existingReasons.length > 1) return { type: 'upgrade', accepted: false, reason: 'rejected: too many safety reasons active' };
    if (shiftApplied && !shiftPositive) return { type: 'upgrade', accepted: false, reason: 'rejected: agent shift is negative' };

    return {
      type: 'upgrade',
      accepted: true,
      previousStatus: currentStatus,
      newStatus: 'VALUE',
      reason
    };
  }

  return null;
}

function sanitizeAnalysis(prediction, raw) {
  const awayId = prediction.away.id;
  const homeId = prediction.home.id;
  const pickTeamId = prediction.winner.id === awayId ? awayId : homeId;
  const awayProbability = normalizeProbability(prediction.away.winProbability, 50);
  const homeProbability = normalizeProbability(prediction.home.winProbability, 50);
  const total = awayProbability + homeProbability;
  const normalizedAwayProbability =
    total > 0 && total !== 100 ? Math.round((awayProbability / total) * 100) : awayProbability;
  const normalizedHomeProbability =
    total > 0 && total !== 100 ? 100 - normalizedAwayProbability : homeProbability;

  const probabilityShift = applyAgentProbabilityShift(normalizedAwayProbability, normalizedHomeProbability, raw, prediction);
  const finalAwayProbability = probabilityShift.awayProbability;
  const finalHomeProbability = probabilityShift.homeProbability;
  const pickProbability = pickTeamId === awayId ? finalAwayProbability : finalHomeProbability;

  const reasons = Array.isArray(raw?.reasons)
    ? raw.reasons.map((item) => String(item).trim()).filter(Boolean).slice(0, 3)
    : [];

  return {
    gamePk: prediction.gamePk,
    pickTeamId,
    pickTeamName: pickTeamId === awayId ? prediction.away.name : prediction.home.name,
    awayProbability: finalAwayProbability,
    homeProbability: finalHomeProbability,
    confidence: deterministicConfidenceFromPrediction(prediction, pickProbability),
    reasons: reasons.length > 0 ? reasons : prediction.reasons.slice(0, 3),
    risk: String(raw?.risk || 'Tidak ada risk khusus yang dominan.').slice(0, 220),
    memoryNote: String(raw?.memoryNote || 'Memory dipakai sebagai sinyal kecil.').slice(0, 220),
    probabilityShift: {
      applied: probabilityShift.applied,
      shift: probabilityShift.shift,
      reason: probabilityShift.reason,
      // Pre-LLM baseline so post-game eval can compare model-only vs
      // model+LLM accuracy (paired Brier). See P4 measurement.
      baselineAwayProbability: normalizedAwayProbability,
      baselineHomeProbability: normalizedHomeProbability
    },
    betOverride: applyAgentBetOverride(prediction, raw, {
      confidence: deterministicConfidenceFromPrediction(prediction, pickProbability),
      probabilityShift
    }),
    firstInning: sanitizeFirstInningAnalysis(prediction, raw),
    source: 'analyst-agent'
  };
}

function sanitizeAnalyses(predictions, rawAnalyses) {
  if (!Array.isArray(rawAnalyses)) return [];

  const byGamePk = new Map(predictions.map((item) => [item.gamePk, item]));
  const analyses = [];

  for (const raw of rawAnalyses) {
    const gamePk = Number(raw?.gamePk);
    const prediction = byGamePk.get(gamePk);
    if (!prediction) continue;

    const sanitized = sanitizeAnalysis(prediction, raw);
    if (sanitized) analyses.push(sanitized);
  }

  return analyses;
}

function findAnalysisArray(value, depth = 0) {
  if (!value || depth > 5) return null;

  if (Array.isArray(value)) {
    return value.some((item) => item && typeof item === 'object' && item.gamePk !== undefined)
      ? value
      : null;
  }

  if (typeof value !== 'object') return null;

  for (const child of Object.values(value)) {
    const found = findAnalysisArray(child, depth + 1);
    if (found) return found;
  }

  return null;
}

export function stripHiddenReasoning(text) {
  if (!text) return null;

  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/^\s*<think>[\s\S]*$/i, '')
    .trim();
}

export function normalizeInteractiveAnswer(text) {
  const cleaned = stripHiddenReasoning(text);
  if (!cleaned) return null;

  const trimmed = cleaned.trim();
  const parsed = extractJson(trimmed);
  if (!parsed) return trimmed;

  if (typeof parsed.answer === 'string') return stripHiddenReasoning(parsed.answer);
  if (typeof parsed.text === 'string') return stripHiddenReasoning(parsed.text);
  if (typeof parsed.message === 'string') return stripHiddenReasoning(parsed.message);

  const lines = [];
  if (parsed.bestGame) lines.push(`Pilihan terkuat: ${parsed.bestGame}`);
  if (parsed.edge) lines.push(`Edge: ${parsed.edge}`);
  if (Array.isArray(parsed.reasons) && parsed.reasons.length > 0) {
    lines.push('Alasan:');
    lines.push(...parsed.reasons.slice(0, 3).map((reason) => `• ${reason}`));
  }
  if (parsed.risk) lines.push(`Risk: ${parsed.risk}`);

  return lines.length > 0 ? lines.join('\n') : trimmed;
}

function asksForTopPicks(question) {
  const text = String(question || '').toLowerCase();
  const pickIntent =
    /\b(best|top|strongest|terkuat|terbaik)\b/.test(text) &&
    /\b(pick|picks|pilihan|lean|rekomendasi)\b/.test(text);
  const fiveIntent = /\b(5|five|lima)\b/.test(text);
  return pickIntent && fiveIntent;
}

function confidenceScore(label) {
  return { high: 3, medium: 1.5, low: 0 }[String(label || '').toLowerCase()] || 0;
}

function teamSideForPick(prediction) {
  const pickId = prediction.agentAnalysis?.pickTeamId ?? prediction.winner?.id;
  if (String(pickId) === String(prediction.away?.id)) return 'away';
  if (String(pickId) === String(prediction.home?.id)) return 'home';
  return toNumber(prediction.home?.winProbability, 50) >= toNumber(prediction.away?.winProbability, 50)
    ? 'home'
    : 'away';
}

// Human-readable labels for the modelBreakdown components, keyed by the field
// name. Used to surface the strongest factors behind a pick.
const FACTOR_LABELS = {
  starterEdge: 'starting pitcher',
  matchupEdge: 'matchup',
  offenseEdge: 'offense',
  preventionEdge: 'run prevention',
  bullpenEdge: 'bullpen',
  lineupEdge: 'lineup',
  formEdge: 'recent form',
  pythagoreanEdge: 'pythag record',
  log5Edge: 'log5 strength',
  homeFieldEdge: 'home field',
  fatigueEdge: 'rest/fatigue',
  h2hEdge: 'head-to-head',
  memoryEdge: 'matchup memory'
};

// Components ranked from strongest to weakest evidence that agree with the
// pick direction. Returns up to `limit` readable labels.
function supportingFactors(prediction, side, limit = 3) {
  const breakdown = prediction.modelBreakdown || {};
  // Positive breakdown edge favors the home side; flip for an away pick.
  const direction = side === 'home' ? 1 : -1;
  return Object.entries(FACTOR_LABELS)
    .map(([key, label]) => ({ label, value: toNumber(breakdown[key], 0) * direction }))
    .filter((item) => item.value > 0.02)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
    .map((item) => item.label);
}

// Returns the model-vs-market edge for the picked side recomputed against the
// CALIBRATED probability, plus the odds context, when a price is available.
function calibratedEdge(prediction, calibratedProbability) {
  const decision = prediction.betDecision || {};
  const implied = toNumber(decision.impliedProbability, NaN);
  if (!Number.isFinite(implied)) return null;
  return {
    edge: Math.round((calibratedProbability - implied) * 10) / 10,
    implied: Math.round(implied * 10) / 10,
    odds: decision.odds,
    book: decision.book
  };
}

function topPickCandidate(prediction) {
  const side = teamSideForPick(prediction);
  const pick = side === 'away' ? prediction.away : prediction.home;
  const opponent = side === 'away' ? prediction.home : prediction.away;
  const rawProbability = normalizeProbability(
    side === 'away'
      ? prediction.agentAnalysis?.awayProbability ?? prediction.away?.winProbability
      : prediction.agentAnalysis?.homeProbability ?? prediction.home?.winProbability,
    50
  );
  // Apply the per-market isotonic calibration the evolution pipeline trains, so
  // the displayed probability reflects observed win rates, not the raw model.
  const calibrated = hasCalibrationMap('moneyline')
    ? calibratePercent(rawProbability, 'moneyline')
    : rawProbability;
  // Calibration can flip the favorite when the raw edge was an artifact; keep
  // the pick on the side the calibrated probability actually favors.
  const probability = calibrated;
  // Confidence reflects model conviction + factor agreement, so feed it the raw
  // model probability (the calibration map compresses the scale and would mute
  // genuine conviction); the displayed probability stays calibrated.
  const confidence = prediction.agentAnalysis?.confidence || deterministicConfidenceFromPrediction(prediction, rawProbability);
  const calibratedEdgeInfo = calibratedEdge(prediction, probability);
  // Prefer the calibrated edge; fall back to the stored raw edge when no odds.
  const edge = calibratedEdgeInfo
    ? calibratedEdgeInfo.edge
    : toNumber(prediction.betDecision?.edge ?? prediction.valuePick?.edge, 0);
  const matchupEdge = Math.abs(toNumber(prediction.modelBreakdown?.matchupEdge, 0)) * 10;
  const status = String(prediction.betDecision?.status || 'LEAN ONLY').toUpperCase();
  const statusBoost = status === 'VALUE' ? 5 : status === 'NO BET' ? -4 : 0;
  const warnings = topPickWarnings(prediction);
  const lineupPenalty = (prediction.lineups?.away?.confirmed && prediction.lineups?.home?.confirmed) ? 0 : -3;
  const factors = supportingFactors(prediction, side);
  const score = probability - 50 + Math.max(edge, 0) * 0.8 + confidenceScore(confidence) + matchupEdge + statusBoost - warnings.length * 2.5 + lineupPenalty;

  return {
    prediction,
    side,
    pick,
    opponent,
    probability,
    rawProbability,
    confidence,
    edge,
    edgeInfo: calibratedEdgeInfo,
    factors,
    score,
    status,
    warnings
  };
}

function topPickWarnings(prediction) {
  const warnings = [];
  const lineups = [prediction.lineups?.away, prediction.lineups?.home].filter(Boolean);
  if (lineups.length < 2 || lineups.some((lineup) => !lineup.confirmed || toNumber(lineup.count, 0) < 9)) {
    warnings.push('lineup belum confirmed');
  }
  if ([prediction.away, prediction.home].some((team) => team?.openerSituation?.isOpener)) {
    warnings.push('opener/bulk pitcher');
  }
  if ([prediction.away, prediction.home].some((team) => String(team?.starterLine || '').toLowerCase().includes('tbd'))) {
    warnings.push('probable pitcher TBD');
  }
  if (prediction.betDecision?.status === 'NO BET') {
    warnings.push(prediction.betDecision.reason || 'no-bet filter aktif');
  }
  for (const reason of prediction.auditAdjustments || prediction.betDecision?.auditAdjustments || []) {
    warnings.push(reason);
  }
  for (const note of prediction.auditMemoryNotes || prediction.betDecision?.auditMemoryNotes || []) {
    warnings.push(note);
  }
  return [...new Set(warnings)].slice(0, 3);
}

function pickTier(candidate) {
  if (candidate.status === 'NO BET' || candidate.warnings.length >= 2) return '⛔ No Bet Risk';
  // Calibrated moneyline probabilities compress (the trained map tops out near
  // 60%), so tiering keys off conviction (raw probability + confidence) and,
  // when odds exist, the calibrated market edge — the real value signal.
  const conviction = toNumber(candidate.rawProbability, candidate.probability);
  const hasOdds = Boolean(candidate.edgeInfo);
  const edge = toNumber(candidate.edge, 0);
  const strongEdge = hasOdds ? edge >= 3 : conviction >= 60;
  if (strongEdge && confidenceRank(candidate.confidence) >= 3 && candidate.warnings.length === 0) {
    return '✅ Strong Pick';
  }
  const leanEdge = hasOdds ? edge >= 1 : conviction >= 56;
  if (leanEdge || confidenceRank(candidate.confidence) >= 2) return '🟡 Lean Only';
  return '⚪ Thin Lean';
}

function shortReason(candidate) {
  const { prediction } = candidate;
  const reasons = [
    ...(prediction.agentAnalysis?.reasons || []),
    ...(prediction.reasons || [])
  ]
    .map((reason) => String(reason || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length > 0) {
    return uniqueReasons[0].replace(/\.$/, '');
  }

  const starterLine =
    candidate.side === 'away' ? prediction.away?.starterLine : prediction.home?.starterLine;
  if (starterLine) return String(starterLine).replace(/\.$/, '');
  if (prediction.contextLine) return String(prediction.contextLine).replace(/\.$/, '');
  return 'model memberi edge matchup paling jelas di slate ini';
}

// Short justification for why the confidence label landed where it did, so the
// user can see the analysis is grounded (factor agreement + edge size).
function confidenceReason(candidate) {
  // Conviction band uses the raw model probability (the calibrated value is
  // compressed); edge uses the calibrated market edge shown to the user.
  const conviction = Math.abs(toNumber(candidate.rawProbability, candidate.probability) - 50);
  const factorCount = candidate.factors.length;
  const parts = [`${factorCount} faktor mendukung`];
  if (Number.isFinite(candidate.edge) && candidate.edge !== 0) {
    parts.push(`edge ${candidate.edge > 0 ? '+' : ''}${candidate.edge}%`);
  }
  parts.push(`konviksi ${conviction >= 12 ? 'kuat' : conviction >= 6 ? 'sedang' : 'tipis'}`);
  return parts.join(', ');
}

// Confirmation/maturity signals: lineup, probable pitcher, and sharp-money
// alignment. Returns short readable tags.
function confirmationSignals(prediction) {
  const signals = [];
  const lineups = [prediction.lineups?.away, prediction.lineups?.home].filter(Boolean);
  const bothConfirmed = lineups.length === 2 && lineups.every((l) => l.confirmed && toNumber(l.count, 0) >= 9);
  signals.push(bothConfirmed ? 'lineup ✓' : 'lineup belum');
  const hasPitchers = Boolean(prediction.away?.starter && prediction.home?.starter);
  signals.push(hasPitchers ? 'pitcher ✓' : 'pitcher TBD');
  const sharp = prediction.modelBreakdown?.sharpMoney;
  if (sharp?.direction === 'toward_model') signals.push('sharp searah');
  else if (sharp?.direction === 'against_model' && toNumber(sharp?.magnitude, 0) >= 15) signals.push('sharp lawan');
  return signals;
}

// A pick is worth surfacing only if it carries real signal: not a NO BET, not
// drowning in warnings, and a probability edge above a coinflip. This keeps the
// top list honest instead of always padding to five thin leans.
function isQualityPick(candidate) {
  if (candidate.status === 'NO BET') return false;
  if (candidate.warnings.length >= 2) return false;
  // Require genuine conviction: the raw model favors the pick by a real margin.
  // (The calibrated probability compresses toward 50, so gate on raw here.)
  const conviction = toNumber(candidate.rawProbability, candidate.probability);
  if (conviction < 53) return false;
  // When odds exist, require a non-negative calibrated edge — a negative edge
  // means the market price is better than the model, so it is not a value play.
  if (candidate.edgeInfo && candidate.edge < 0) return false;
  return true;
}

export function buildTopPicksAnswer(predictions, question = '', limit = 5) {
  if (!asksForTopPicks(question) || !Array.isArray(predictions) || predictions.length === 0) {
    return null;
  }

  const ranked = predictions
    .map(topPickCandidate)
    .sort((left, right) => right.score - left.score);

  // Prefer quality picks; if the slate is thin and none qualify, fall back to
  // the best-ranked so the command still answers instead of going silent.
  const quality = ranked.filter(isQualityPick).slice(0, limit);
  const candidates = quality.length > 0 ? quality : ranked.slice(0, 1);

  if (candidates.length === 0) return null;

  const calibrated = hasCalibrationMap('moneyline');
  const lines = [uiTitle('🏆', 'Top Pick Model | Hari Ini'), ''];
  candidates.forEach((candidate, index) => {
    const pickLabel = candidate.pick?.abbreviation || candidate.pick?.name || 'TBD';
    const opponentLabel = candidate.opponent?.abbreviation || candidate.opponent?.name || 'TBD';
    lines.push(`${index + 1}. 🎯 ${pickLabel} ML vs ${opponentLabel}`);
    lines.push(`   ${uiKV('🏷️', 'Tier', pickTier(candidate))}`);
    lines.push(`   ${uiKV('✅', 'Prediksi menang', `${candidate.pick?.name || pickLabel} | ${candidate.probability}%${calibrated ? ' (kalibrasi)' : ''} | ${candidate.confidence}`)}`);
    if (candidate.edgeInfo) {
      const oddsText = candidate.edgeInfo.odds != null ? ` @ ${candidate.edgeInfo.odds}` : '';
      lines.push(`   ${uiKV('📈', 'Edge', `${candidate.edge > 0 ? '+' : ''}${candidate.edge}% vs market ${candidate.edgeInfo.implied}%${oddsText}`)}`);
    }
    if (candidate.factors.length) {
      lines.push(`   ${uiKV('🔬', 'Faktor', candidate.factors.join(', '))}`);
    }
    lines.push(`   ${uiKV('🧠', 'Keyakinan', confidenceReason(candidate))}`);
    lines.push(`   ${uiKV('📋', 'Konfirmasi', confirmationSignals(candidate.prediction).join(' | '))}`);
    lines.push(`   ${uiKV('💡', 'Alasan', `${shortReason(candidate)}.`)}`);
    if (candidate.warnings.length) {
      lines.push(`   ${uiKV('⚠️', 'Risk', candidate.warnings.join(' | '))}`);
    }
  });

  return lines.join('\n');
}

async function analyzeWithExternalAgent(config, predictions, memorySummary, evolutionData) {
  if (!config.analystAgent.url) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.analystAgent.timeoutMs);

  try {
    const response = await fetch(config.analystAgent.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.analystAgent.apiKey
          ? { Authorization: `Bearer ${config.analystAgent.apiKey}` }
          : {})
      },
      body: JSON.stringify({
        task: 'mlb_pre_game_analysis',
        skillVersion: ANALYST_SKILL_VERSION,
        analystPlaybook: ANALYST_SYSTEM_PROMPT,
        memory: memorySummary,
        evolutionContext: evolutionData || null,
        games: predictions.map((p) => compactGameForAgent(p, evolutionData)),
        outputContract: {
          analyses:
            'Array of { gamePk, reasons, risk, memoryNote, firstInning: { reasons, risk } }. Numeric probabilities, totals, confidence, and final pick are deterministic model fields; do not invent them.'
        }
      })
    });

    if (!response.ok) return [];
    const data = await response.json();
    return sanitizeAnalyses(predictions, findAnalysisArray(data));
  } finally {
    clearTimeout(timer);
  }
}

async function analyzeWithLocalAgent(config, predictions, memorySummary, evolutionData) {
  if (!config.openai.apiKey) return [];

  const user = JSON.stringify({
    skillVersion: ANALYST_SKILL_VERSION,
    memory: memorySummary,
    evolutionContext: evolutionData || null,
    games: predictions.map((p) => compactGameForAgent(p, evolutionData)),
    outputContract: {
      analyses: [
        {
          gamePk: 'number',
          pickTeamId: 'optional; if supplied, system may ignore it and keep deterministic model pick',
          awayProbability: 'optional; copy deterministicPipeline.awayProbability exactly if supplied',
          homeProbability: 'optional; copy deterministicPipeline.homeProbability exactly if supplied',
          confidence: 'optional; system confidence comes from deterministic model and quality rules',
          reasons: ['2-3 alasan singkat bahasa Indonesia'],
          risk: 'risiko terbesar pick ini',
          memoryNote: 'bagaimana matchup memory/memory mempengaruhi analisa, atau netral',
          firstInning: {
            required: true,
            pick: 'optional; system will keep deterministic firstInning baseline pick',
            probability: 'optional; copy deterministic baseline if supplied',
            confidence: 'optional; system confidence remains deterministic',
            reasons: ['2-3 alasan singkat dari riwayat first inning, starter, H2H'],
            risk: 'risiko terbesar untuk verdict first inning'
          }
        }
      ]
    }
  });

  const text = await callLlm(config, {
    system: ANALYST_SYSTEM_PROMPT,
    user,
    maxTokens: Math.min(6000, 900 + predictions.length * 450),
    timeoutMs: config.analystAgent.timeoutMs
  });

  const parsed = extractJson(text);
  return sanitizeAnalyses(predictions, findAnalysisArray(parsed));
}

export async function analyzePredictionsWithAgent(config, predictions, memorySummary, evolutionData = null) {
  if (!config.analystAgent.enabled || predictions.length === 0) return [];

  if (config.analystAgent.mode === 'external') {
    return analyzeWithExternalAgent(config, predictions, memorySummary, evolutionData);
  }

  return analyzeWithLocalAgent(config, predictions, memorySummary, evolutionData);
}

async function askExternalAgent(config, { question, dateYmd, predictions, memorySummary }) {
  if (!config.analystAgent.url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.analystAgent.timeoutMs);

  try {
    const response = await fetch(config.analystAgent.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.analystAgent.apiKey
          ? { Authorization: `Bearer ${config.analystAgent.apiKey}` }
          : {})
      },
      body: JSON.stringify({
        task: 'mlb_interactive_question',
        skillVersion: ANALYST_SKILL_VERSION,
        analystPlaybook: ANALYST_SYSTEM_PROMPT,
        dateYmd,
        question,
        memory: memorySummary,
        games: predictions.map((p) => compactGameForAgent(p)),
        outputContract: {
          answer: 'Telegram-ready Indonesian answer, concise, based only on provided data.'
        }
      })
    });

    if (!response.ok) return null;
    const data = await response.json();
    return normalizeInteractiveAnswer(data.answer || data.text || data.message || JSON.stringify(data));
  } finally {
    clearTimeout(timer);
  }
}

async function askLocalAgent(config, { question, dateYmd, predictions, memorySummary, knowledgeContext, conversationHistory }) {
  if (!config.openai.apiKey) return null;

  const systemParts = [ANALYST_INTERACTIVE_PROMPT];
  if (knowledgeContext) {
    systemParts.push('', '--- Knowledge Context ---', knowledgeContext);
  }

  const userPayload = {
    dateYmd,
    question,
    memory: memorySummary,
    games: predictions.map((p) => compactGameForAgent(p))
  };
  if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
    userPayload.conversationHistory = conversationHistory.slice(-8);
  }

  const text = await callLlm(config, {
    system: systemParts.join('\n'),
    user: JSON.stringify(userPayload),
    maxTokens: 1500,
    timeoutMs: config.analystAgent.timeoutMs
  });

  return normalizeInteractiveAnswer(text);
}

export async function answerInteractiveQuestion(config, payload) {
  if (!config.interactiveAgent) return null;

  const deterministicAnswer = buildTopPicksAnswer(payload.predictions, payload.question);
  if (deterministicAnswer) return deterministicAnswer;

  if (config.analystAgent.mode === 'external') {
    return askExternalAgent(config, payload);
  }

  return askLocalAgent(config, payload);
}

