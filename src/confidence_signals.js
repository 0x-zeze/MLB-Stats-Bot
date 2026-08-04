/**
 * Multi-factor confidence signals for moneyline picks.
 *
 * Uses existing modelBreakdown + context fields already computed by the pure
 * core (SP season/recent, form, H2H, lineup, injury, bullpen, platoon, fatigue).
 * No paid APIs. Each factor returns { score, label, direction } where score is
 * -1..+1 aligned with the pick side (positive = supports pick).
 *
 * Aggregate confidence: low / medium / high / elite based on supporting factors,
 * opposing factors, and data completeness.
 */

import { toNumber } from './utils.js';

const FACTOR_WEIGHTS = {
  starter: 0.28,
  starterRecent: 0.12,
  offense: 0.12,
  form: 0.10,
  bullpen: 0.08,
  lineup: 0.08,
  injury: 0.08,
  h2h: 0.05,
  platoon: 0.05,
  fatigue: 0.04
};

function pickDirection(side) {
  return side === 'home' ? 1 : -1;
}

function signed(edge, side) {
  return toNumber(edge, 0) * pickDirection(side);
}

function factor(name, score, label, weight) {
  return {
    name,
    score: Math.max(-1, Math.min(1, score)),
    label,
    weight,
    supports: score > 0.02,
    opposes: score < -0.02
  };
}

function starterFactor(mb, side) {
  const edge = signed(mb.starterEdge, side);
  const recent = signed(mb.starterRecentEdge, side);
  const season = signed(mb.starterSeasonEdge, side);
  // Prefer combined starterEdge; fall back to season/recent if present.
  const primary = Math.abs(edge) >= 0.01 ? edge : season * 0.55 + recent * 0.45;
  const score = Math.max(-1, Math.min(1, primary / 0.5));
  let label = 'SP matchup netral';
  if (score >= 0.25) label = 'SP pick unggul (season+recent)';
  else if (score >= 0.08) label = 'SP pick sedikit unggul';
  else if (score <= -0.25) label = 'SP lawan unggul';
  else if (score <= -0.08) label = 'SP lawan sedikit unggul';
  return factor('starter', score, label, FACTOR_WEIGHTS.starter);
}

function starterRecentFactor(mb, side) {
  const recent = signed(mb.starterRecentEdge, side);
  const score = Math.max(-1, Math.min(1, recent / 0.4));
  let label = 'SP recent netral / sample kecil';
  if (score >= 0.2) label = 'SP pick on fire (recent starts)';
  else if (score >= 0.08) label = 'SP pick recent bagus';
  else if (score <= -0.2) label = 'SP lawan on fire (recent)';
  else if (score <= -0.08) label = 'SP lawan recent lebih baik';
  return factor('starterRecent', score, label, FACTOR_WEIGHTS.starterRecent);
}

function offenseFactor(mb, side) {
  const edge = signed(mb.offenseEdge, side);
  const score = Math.max(-1, Math.min(1, edge / 0.4));
  let label = 'Offense netral';
  if (score >= 0.2) label = 'Offense pick lebih kuat';
  else if (score <= -0.2) label = 'Offense lawan lebih kuat';
  return factor('offense', score, label, FACTOR_WEIGHTS.offense);
}

function formFactor(mb, side) {
  const edge = signed(mb.formEdge ?? mb.rollingOffenseEdge, side);
  const score = Math.max(-1, Math.min(1, edge / 0.25));
  let label = 'Form L10/L21 netral';
  if (score >= 0.2) label = 'Pick on fire (recent form)';
  else if (score >= 0.08) label = 'Form pick lebih baik';
  else if (score <= -0.2) label = 'Lawan on fire (recent form)';
  else if (score <= -0.08) label = 'Form lawan lebih baik';
  return factor('form', score, label, FACTOR_WEIGHTS.form);
}

function bullpenFactor(mb, side) {
  const edge = signed(mb.bullpenEdge, side);
  const score = Math.max(-1, Math.min(1, edge / 0.15));
  let label = 'Bullpen netral';
  if (score >= 0.15) label = 'Bullpen pick lebih fresh';
  else if (score <= -0.15) label = 'Bullpen pick lebih lelah';
  return factor('bullpen', score, label, FACTOR_WEIGHTS.bullpen);
}

function lineupFactor(mb, item, side) {
  const edge = signed(mb.lineupEdge, side);
  const confirmed = Boolean(
    item?.lineups?.away?.confirmed &&
      item?.lineups?.home?.confirmed &&
      (item?.lineups?.away?.count || 0) >= 9 &&
      (item?.lineups?.home?.count || 0) >= 9
  );
  let score = Math.max(-1, Math.min(1, edge / 0.12));
  // Incomplete lineup reduces confidence in the pick side.
  if (!confirmed) score = Math.min(score, 0) - 0.15;
  let label = confirmed ? 'Lineup confirmed' : 'Lineup belum confirmed penuh';
  if (score >= 0.15) label = 'Lineup pick lebih kuat (confirmed)';
  else if (score <= -0.2) label = confirmed ? 'Lineup lawan lebih kuat' : 'Lineup incomplete / lawan lebih kuat';
  return factor('lineup', score, label, FACTOR_WEIGHTS.lineup);
}

function injuryFactor(item, side) {
  // Injuries: count hitters IL on each side from injury arrays or injury line.
  const homeInj = Array.isArray(item?.injuries?.home)
    ? item.injuries.home.filter((i) => i?.position !== 'P').length
    : 0;
  const awayInj = Array.isArray(item?.injuries?.away)
    ? item.injuries.away.filter((i) => i?.position !== 'P').length
    : 0;
  // Positive score when pick side has FEWER key injuries than opponent.
  const delta = side === 'home' ? awayInj - homeInj : homeInj - awayInj;
  const score = Math.max(-1, Math.min(1, delta * 0.25));
  let label = 'Injury load seimbang / unknown';
  if (delta >= 2) label = `Pick lebih sehat (+${delta} hitter IL lawan)`;
  else if (delta === 1) label = 'Pick sedikit lebih sehat (injury)';
  else if (delta <= -2) label = `Pick lebih terpukul injury (${Math.abs(delta)} hitter IL)`;
  else if (delta === -1) label = 'Pick punya 1 hitter IL lebih banyak';
  return factor('injury', score, label, FACTOR_WEIGHTS.injury);
}

function h2hFactor(mb, item, side) {
  const edge = signed(mb.h2hEdge, side);
  const games = toNumber(item?.headToHead?.games, 0);
  // Small samples barely move confidence.
  const sampleWeight = Math.min(1, games / 8);
  const score = Math.max(-1, Math.min(1, (edge / 0.15) * sampleWeight));
  let label = games < 3 ? 'H2H sample kecil (diabaikan)' : 'H2H netral';
  if (games >= 3 && score >= 0.15) label = `H2H mendukung pick (n=${games})`;
  else if (games >= 3 && score <= -0.15) label = `H2H mendukung lawan (n=${games})`;
  return factor('h2h', score, label, FACTOR_WEIGHTS.h2h);
}

function platoonFactor(mb, side) {
  const edge = signed(mb.platoonEdge, side);
  const score = Math.max(-1, Math.min(1, edge / 0.15));
  let label = 'Platoon netral / unknown';
  if (score >= 0.12) label = 'Platoon advantage ke pick';
  else if (score <= -0.12) label = 'Platoon disadvantage ke pick';
  return factor('platoon', score, label, FACTOR_WEIGHTS.platoon);
}

function fatigueFactor(mb, side) {
  const edge = signed(mb.fatigueEdge, side);
  const score = Math.max(-1, Math.min(1, edge / 0.12));
  let label = 'Schedule fatigue netral';
  if (score >= 0.12) label = 'Pick lebih rest / lawan lelah';
  else if (score <= -0.12) label = 'Pick lebih lelah (travel/rest)';
  return factor('fatigue', score, label, FACTOR_WEIGHTS.fatigue);
}

/**
 * Build multi-factor confidence for a moneyline pick side.
 * @param {object} item prediction object after modelBreakdown is attached
 * @param {'home'|'away'} side pick side
 * @returns {object} confidence report
 */
export function buildPickConfidence(item, side) {
  if (!item || (side !== 'home' && side !== 'away')) {
    return {
      level: 'rendah',
      score: 0,
      supporting: 0,
      opposing: 0,
      factors: [],
      summary: 'data incomplete'
    };
  }

  const mb = item.modelBreakdown || {};
  const factors = [
    starterFactor(mb, side),
    starterRecentFactor(mb, side),
    offenseFactor(mb, side),
    formFactor(mb, side),
    bullpenFactor(mb, side),
    lineupFactor(mb, item, side),
    injuryFactor(item, side),
    h2hFactor(mb, item, side),
    platoonFactor(mb, side),
    fatigueFactor(mb, side)
  ];

  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0) || 1;
  const weightedScore = factors.reduce((sum, f) => sum + f.score * f.weight, 0) / totalWeight;
  const supporting = factors.filter((f) => f.supports).length;
  const opposing = factors.filter((f) => f.opposes).length;

  // Level mapping: elite only when many factors agree and weighted score high.
  let level = 'rendah';
  if (weightedScore >= 0.28 && supporting >= 5 && opposing <= 2) level = 'elite';
  else if (weightedScore >= 0.15 && supporting >= 4 && opposing <= 3) level = 'tinggi';
  else if (weightedScore >= 0.05 && supporting >= 3) level = 'sedang';
  else if (weightedScore <= -0.1 || opposing >= 5) level = 'rendah';
  else level = weightedScore >= 0 ? 'sedang' : 'rendah';

  // Record-dominated picks cannot be elite.
  if (mb.recordDominated && level === 'elite') level = 'tinggi';

  const topSupport = factors
    .filter((f) => f.supports)
    .sort((a, b) => b.score * b.weight - a.score * a.weight)
    .slice(0, 3)
    .map((f) => f.label);
  const topOppose = factors
    .filter((f) => f.opposes)
    .sort((a, b) => a.score * a.weight - b.score * b.weight)
    .slice(0, 2)
    .map((f) => f.label);

  const summaryParts = [];
  if (topSupport.length) summaryParts.push(`+ ${topSupport.join('; ')}`);
  if (topOppose.length) summaryParts.push(`- ${topOppose.join('; ')}`);
  if (!summaryParts.length) summaryParts.push('faktor seimbang / tipis');

  return {
    level,
    score: Math.round(weightedScore * 1000) / 1000,
    supporting,
    opposing,
    factors,
    summary: summaryParts.join(' | '),
    // Stake multiplier for VALUE sizing (1.0 baseline; elite up to 1.25; low down to 0.75)
    stakeMultiplier:
      level === 'elite' ? 1.25 : level === 'tinggi' ? 1.1 : level === 'sedang' ? 1.0 : 0.75
  };
}

/**
 * Attach multi-factor confidence onto a prediction item (mutates lightly).
 * Call after modelBreakdown is present; uses model favored side if no value pick.
 */
export function attachPickConfidence(item) {
  if (!item) return item;
  const homeProb = toNumber(
    item.home?.pureModelProbability ?? item.modelBreakdown?.pureHomeProbability ?? item.home?.winProbability,
    50
  );
  const awayProb = 100 - homeProb;
  const side = homeProb >= awayProb ? 'home' : 'away';
  const confidence = buildPickConfidence(item, side);
  item.pickConfidence = {
    side,
    teamName: side === 'home' ? item.home?.name : item.away?.name,
    ...confidence
  };
  // Also compute for the value side if different (edge-based pick).
  const valueSide = item.betDecision?.status === 'VALUE' ? item.betDecision?.teamId : null;
  if (valueSide != null) {
    const homeId = item.home?.id;
    const valuePickSide = String(valueSide) === String(homeId) ? 'home' : 'away';
    if (valuePickSide !== side) {
      item.valueConfidence = buildPickConfidence(item, valuePickSide);
    } else {
      item.valueConfidence = item.pickConfidence;
    }
  } else {
    item.valueConfidence = null;
  }
  return item;
}
