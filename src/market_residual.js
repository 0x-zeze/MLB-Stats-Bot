import { clamp, toNumber } from './utils.js';
import { loadConfig } from './config.js';

const DEFAULT_MARKET_RESIDUAL_WEIGHT = 0.0;
const MIN_MARKET_PROBABILITY = 0.03;
const MAX_MARKET_PROBABILITY = 0.97;

function americanImpliedProbability(odds) {
  const parsed = toNumber(odds, Number.NaN);
  if (!Number.isFinite(parsed) || parsed === 0) return null;
  return parsed > 0 ? 100 / (parsed + 100) : Math.abs(parsed) / (Math.abs(parsed) + 100);
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
  const total = home + away;
  if (!(total > 0)) return null;
  return {
    home: clamp((home / total) * 100, MIN_MARKET_PROBABILITY * 100, MAX_MARKET_PROBABILITY * 100),
    away: clamp((away / total) * 100, MIN_MARKET_PROBABILITY * 100, MAX_MARKET_PROBABILITY * 100)
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
  if (!Number.isFinite(Number(modelHomeProbability)) || !Number.isFinite(Number(modelAwayProbability))) {
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
