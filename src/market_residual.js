import { clamp, isFiniteNumber, toNumber } from './utils.js';
import { loadConfig } from './config.js';

const DEFAULT_MARKET_RESIDUAL_WEIGHT = 0.0;
const MIN_MARKET_PROBABILITY = 0.03;
const MAX_MARKET_PROBABILITY = 0.97;

function americanImpliedProbability(odds) {
  const parsed = toNumber(odds, Number.NaN);
  if (!Number.isFinite(parsed) || Math.abs(parsed) < 100) return null;
  return parsed > 0 ? 100 / (parsed + 100) : Math.abs(parsed) / (Math.abs(parsed) + 100);
}

/**
 * Two-outcome Power De-vig solver.
 *
 * Solves p1^k + p2^k = 1 for exponent k > 0 where p1, p2 in (0, 1) are raw
 * implied probabilities (decimal scale). Compared to naive proportional
 * normalization (p_i / (p1 + p2)), Power De-vig accounts for favorite-longshot
 * bias by removing proportionally more vig from the underdog than the favorite.
 *
 * Returns { probA, probB, exponent, method } on the 0..1 scale, or null if
 * inputs are invalid.
 */
export function powerDevigProbabilities(probA, probB) {
  const a = toNumber(probA, Number.NaN);
  const b = toNumber(probB, Number.NaN);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !(a > 0 && a < 1) || !(b > 0 && b < 1)) {
    return null;
  }

  const total = a + b;
  if (Math.abs(total - 1) <= 1e-9) {
    return { probA: a, probB: b, exponent: 1, method: 'power' };
  }

  // f(k) = a^k + b^k - 1 is strictly decreasing on (0, +inf).
  const f = (k) => a ** k + b ** k - 1;
  const lnA = Math.log(a);
  const lnB = Math.log(b);

  let lo;
  let hi;
  if (total > 1) {
    lo = 1;
    hi = 2;
    while (f(hi) > 0 && hi < 1024) hi *= 2;
  } else {
    hi = 1;
    lo = 0.5;
    while (f(lo) < 0 && lo > 1e-6) lo /= 2;
  }

  if (f(lo) < 0 || f(hi) > 0) {
    // Extreme degenerate fallback: proportional normalization.
    return { probA: a / total, probB: b / total, exponent: null, method: 'proportional_fallback' };
  }

  let k = 0.5 * (lo + hi);
  for (let iter = 0; iter < 50; iter += 1) {
    const aK = a ** k;
    const bK = b ** k;
    const val = aK + bK - 1;
    if (Math.abs(val) < 1e-11) break;
    if (val > 0) lo = k;
    else hi = k;
    const deriv = aK * lnA + bK * lnB;
    const newton = deriv !== 0 ? k - val / deriv : Number.NaN;
    k = Number.isFinite(newton) && newton > lo && newton < hi ? newton : 0.5 * (lo + hi);
  }

  const fairA = a ** k;
  const fairB = b ** k;
  const sum = fairA + fairB;
  if (!Number.isFinite(sum) || !(sum > 0)) {
    return { probA: a / total, probB: b / total, exponent: null, method: 'proportional_fallback' };
  }
  return {
    probA: fairA / sum,
    probB: fairB / sum,
    exponent: k,
    method: 'power'
  };
}

export function marketResidualWeight() {
  const configured = toNumber(
    loadConfig().moneylineMarketResidualWeight,
    DEFAULT_MARKET_RESIDUAL_WEIGHT
  );
  return clamp(configured, 0, 0.5);
}

export function noVigMarketProbabilities({ homeMoneyline, awayMoneyline } = {}) {
  const home = americanImpliedProbability(homeMoneyline);
  const away = americanImpliedProbability(awayMoneyline);
  if (home === null || away === null) return null;
  const devigged = powerDevigProbabilities(home, away);
  if (!devigged) return null;
  return {
    home: clamp(devigged.probA * 100, MIN_MARKET_PROBABILITY * 100, MAX_MARKET_PROBABILITY * 100),
    away: clamp(devigged.probB * 100, MIN_MARKET_PROBABILITY * 100, MAX_MARKET_PROBABILITY * 100)
  };
}

export function marketAnchoredProbabilities({
  modelHomeProbability,
  modelAwayProbability,
  homeMoneyline,
  awayMoneyline,
  weight = marketResidualWeight()
} = {}) {
  const market = noVigMarketProbabilities({ homeMoneyline, awayMoneyline });
  if (!market) return null;
  const w = clamp(toNumber(weight, 0), 0, 0.5);
  if (!(w > 0)) return null;
  if (!isFiniteNumber(modelHomeProbability) || !isFiniteNumber(modelAwayProbability)) {
    return null;
  }
  const home = clamp(
    Number(modelHomeProbability) * (1 - w) + market.home * w,
    MIN_MARKET_PROBABILITY * 100,
    MAX_MARKET_PROBABILITY * 100
  );
  return {
    home,
    away: 100 - home,
    marketHome: market.home,
    marketAway: market.away,
    weight: w
  };
}
