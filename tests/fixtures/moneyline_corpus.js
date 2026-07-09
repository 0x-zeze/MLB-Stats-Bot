// Characterization corpus for the moneyline value engine. Each entry is a named
// builder returning a game object; the parity tests run these through
// applyMoneylineValueMarket and assert {status, reason, reasons} match goldens
// captured from the pre-refactor implementation. Builders are called at
// evaluation time so freshness-sensitive timestamps stay "now".
//
// Covers the 13 default-path JS handlers (the two audit-guardrail handlers only
// fire when an approved evolution rule is present — those are exercised by
// tests/test_moneyline_value_engine.js with a temp MLB_EVOLUTION_DATA_DIR).

function fresh() {
  return new Date().toISOString();
}

function game(overrides = {}) {
  const base = {
    status: 'Scheduled',
    away: {
      id: 1,
      name: 'Away',
      abbreviation: 'AWY',
      winProbability: 45,
      starter: { fullName: 'Away Starter' },
      record: { wins: 40, losses: 35, pct: '.533' }
    },
    home: {
      id: 2,
      name: 'Home',
      abbreviation: 'HOM',
      winProbability: 55,
      starter: { fullName: 'Home Starter' },
      record: { wins: 42, losses: 33, pct: '.560' }
    },
    currentOdds: {
      awayMoneyline: 160,
      homeMoneyline: -150,
      moneylineBook: 'FanDuel',
      oddsFetchedAt: fresh()
    },
    modelBreakdown: {
      matchupEdge: 0.3,
      recordContextEdge: 0.02,
      recordDominated: false
    },
    lineups: {
      away: { confirmed: true, count: 9 },
      home: { confirmed: true, count: 9 }
    }
  };
  return {
    ...base,
    ...overrides,
    away: { ...base.away, ...overrides.away },
    home: { ...base.home, ...overrides.home },
    currentOdds: { ...base.currentOdds, ...overrides.currentOdds },
    modelBreakdown: { ...base.modelBreakdown, ...overrides.modelBreakdown },
    lineups: {
      away: { ...base.lineups.away, ...overrides.lineups?.away },
      home: { ...base.lineups.home, ...overrides.lineups?.home }
    }
  };
}

// A strong, clean home-favorite VALUE pick used as the base for single-rule
// isolation: high conviction, winning record, favored side, fresh close odds.
function cleanHome(overrides = {}) {
  return game({
    away: { winProbability: 36, record: { wins: 30, losses: 45, pct: '.400' } },
    home: { winProbability: 64, record: { wins: 45, losses: 30, pct: '.600' } },
    currentOdds: { awayMoneyline: 150, homeMoneyline: -130, moneylineBook: 'FanDuel', oddsFetchedAt: fresh() },
    modelBreakdown: {
      matchupEdge: 0.3,
      recordContextEdge: 0.02,
      recordDominated: false,
      starterEdge: 0.2,
      offenseEdge: 0.1,
      bullpenEdge: 0.05,
      lineupEdge: 0.05
    },
    ...overrides
  });
}

export const CORPUS = {
  clean_home_value: () => cleanHome(),

  no_odds_at_all: () => game({ currentOdds: { awayMoneyline: undefined, homeMoneyline: undefined } }),

  stale_odds_timestamp_missing: () => cleanHome({
    currentOdds: { awayMoneyline: 150, homeMoneyline: -130, moneylineBook: 'FanDuel', oddsFetchedAt: undefined, fetchedAt: undefined, updatedAt: undefined }
  }),

  stale_odds_old: () => cleanHome({
    currentOdds: { awayMoneyline: 150, homeMoneyline: -130, moneylineBook: 'FanDuel', oddsFetchedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }
  }),

  edge_below_floor: () => cleanHome({
    away: { winProbability: 44, record: { wins: 35, losses: 40, pct: '.467' } },
    home: { winProbability: 56, record: { wins: 45, losses: 30, pct: '.600' } },
    currentOdds: { awayMoneyline: 110, homeMoneyline: -112, moneylineBook: 'FanDuel', oddsFetchedAt: fresh() }
  }),

  edge_exactly_floor: () => cleanHome({
    // Construct edge exactly at threshold (4.0) — must NOT fire (strict <).
    home: { winProbability: 60, record: { wins: 45, losses: 30, pct: '.600' } },
    away: { winProbability: 40, record: { wins: 30, losses: 45, pct: '.400' } },
    currentOdds: { awayMoneyline: 128, homeMoneyline: -128, moneylineBook: 'FanDuel', oddsFetchedAt: fresh() }
  }),

  team_quality_sub_520: () => cleanHome({
    home: { winProbability: 64, record: { wins: 38, losses: 40, pct: '.487' } }
  }),

  away_underdog_over_115: () => game({
    away: { winProbability: 64, record: { wins: 45, losses: 30, pct: '.600' } },
    home: { winProbability: 36, record: { wins: 30, losses: 45, pct: '.400' } },
    currentOdds: { awayMoneyline: 160, homeMoneyline: -150, moneylineBook: 'FanDuel', oddsFetchedAt: fresh() }
  }),

  away_underdog_exactly_115: () => game({
    away: { winProbability: 64, record: { wins: 45, losses: 30, pct: '.600' } },
    home: { winProbability: 36, record: { wins: 30, losses: 45, pct: '.400' } },
    currentOdds: { awayMoneyline: 115, homeMoneyline: -135, moneylineBook: 'FanDuel', oddsFetchedAt: fresh() }
  }),

  conviction_below_52: () => cleanHome({
    home: { winProbability: 51, record: { wins: 45, losses: 30, pct: '.600' } },
    away: { winProbability: 49, record: { wins: 30, losses: 45, pct: '.400' } },
    currentOdds: { awayMoneyline: 200, homeMoneyline: -110, moneylineBook: 'FanDuel', oddsFetchedAt: fresh() }
  }),

  conviction_exactly_52: () => cleanHome({
    home: { winProbability: 52, record: { wins: 45, losses: 30, pct: '.600' } },
    away: { winProbability: 48, record: { wins: 30, losses: 45, pct: '.400' } },
    currentOdds: { awayMoneyline: 200, homeMoneyline: -110, moneylineBook: 'FanDuel', oddsFetchedAt: fresh() }
  }),

  sharp_contra: () => cleanHome({
    modelBreakdown: {
      matchupEdge: 0.3, recordContextEdge: 0.02, recordDominated: false,
      starterEdge: 0.2, offenseEdge: 0.1, bullpenEdge: 0.05, lineupEdge: 0.05,
      sharpMoney: { direction: 'against_model', magnitude: 12 }
    }
  }),

  sharp_contra_exactly_10: () => cleanHome({
    modelBreakdown: {
      matchupEdge: 0.3, recordContextEdge: 0.02, recordDominated: false,
      starterEdge: 0.2, offenseEdge: 0.1, bullpenEdge: 0.05, lineupEdge: 0.05,
      sharpMoney: { direction: 'against_model', magnitude: 10 }
    }
  }),

  record_dominated: () => cleanHome({
    currentOdds: { awayMoneyline: 125, homeMoneyline: -110, moneylineBook: 'FanDuel', oddsFetchedAt: fresh() },
    modelBreakdown: { matchupEdge: 0.04, recordContextEdge: 0.22, recordDominated: true }
  }),

  // The next four handlers are all gated on `option.edge < STRONG_VALUE_EDGE
  // (4.0)`, so in default config they co-fire with the edge floor. Single-sided
  // markets (home odds only) skip de-vig, giving a directly controllable small
  // sub-4% edge so the target handler's fired branch is actually exercised.
  thin_matchup: () => cleanHome({
    home: { winProbability: 56, record: { wins: 45, losses: 30, pct: '.600' } },
    away: { winProbability: 44, record: { wins: 30, losses: 45, pct: '.400' } },
    currentOdds: { awayMoneyline: undefined, homeMoneyline: -140, moneylineBook: 'FanDuel', oddsFetchedAt: fresh() },
    modelBreakdown: { matchupEdge: 0.05, recordContextEdge: 0.02, recordDominated: false, starterEdge: 0.2, offenseEdge: 0.1, bullpenEdge: 0.05, lineupEdge: 0.05 }
  }),

  few_factors_agree: () => cleanHome({
    home: { winProbability: 56, record: { wins: 45, losses: 30, pct: '.600' } },
    away: { winProbability: 44, record: { wins: 30, losses: 45, pct: '.400' } },
    currentOdds: { awayMoneyline: undefined, homeMoneyline: -140, moneylineBook: 'FanDuel', oddsFetchedAt: fresh() },
    modelBreakdown: { matchupEdge: 0.3, recordContextEdge: 0.02, recordDominated: false, starterEdge: 0.2, offenseEdge: -0.1, bullpenEdge: -0.05, lineupEdge: -0.05 }
  }),

  lineup_incomplete: () => cleanHome({
    home: { winProbability: 56, record: { wins: 45, losses: 30, pct: '.600' } },
    away: { winProbability: 44, record: { wins: 30, losses: 45, pct: '.400' } },
    currentOdds: { awayMoneyline: undefined, homeMoneyline: -140, moneylineBook: 'FanDuel', oddsFetchedAt: fresh() },
    lineups: { away: { confirmed: false, count: 4 }, home: { confirmed: true, count: 9 } }
  }),

  opener_situation: () => cleanHome({
    home: { winProbability: 64, record: { wins: 45, losses: 30, pct: '.600' }, openerSituation: { isOpener: true, confidence: 'high' } }
  }),

  no_probable_pitcher: () => cleanHome({
    home: { winProbability: 56, record: { wins: 45, losses: 30, pct: '.600' }, starter: null },
    away: { winProbability: 44, record: { wins: 30, losses: 45, pct: '.400' } },
    currentOdds: { awayMoneyline: undefined, homeMoneyline: -140, moneylineBook: 'FanDuel', oddsFetchedAt: fresh() }
  }),

  multi_reason_stack: () => game({
    // Weak away underdog, sub-.520, low conviction, thin matchup, incomplete
    // lineup, missing pitcher — several reasons fire; ordering must be preserved.
    away: { winProbability: 40, record: { wins: 30, losses: 45, pct: '.400' }, starter: null },
    home: { winProbability: 60, record: { wins: 40, losses: 40, pct: '.500' } },
    currentOdds: { awayMoneyline: 180, homeMoneyline: -200, moneylineBook: 'FanDuel', oddsFetchedAt: fresh() },
    modelBreakdown: { matchupEdge: 0.02, recordContextEdge: 0.3, recordDominated: true },
    lineups: { away: { confirmed: false, count: 3 }, home: { confirmed: false, count: 5 } }
  })
};
