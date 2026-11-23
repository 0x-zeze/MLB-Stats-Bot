import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildFeatureVector,
  buildFeatureVectorV2,
  flattenFeatureVector,
  FEATURE_VECTOR_SCHEMA_VERSION,
  FEATURE_VECTOR_V2_SCHEMA_VERSION,
  FEATURE_VECTOR_V1_FEATURE_NAMES,
  FEATURE_VECTOR_V2_EXTRA_FEATURE_NAMES,
  FEATURE_VECTOR_V2_FEATURE_NAMES
} from '../src/core/feature_vector.js';
import {
  MARKET_RESIDUAL_V2_MODEL_ID,
  MARKET_RESIDUAL_V2_IMPL_VERSION,
  MARKET_RESIDUAL_GBDT_V2_MODEL_ID,
  MARKET_RESIDUAL_GBDT_V2_IMPL_VERSION
} from '../src/core/model_ids.js';
import {
  verifyMarketResidualV2Artifact,
  hashArtifactContent as hashLinearArtifact
} from '../src/core/market_residual_v2.js';
import {
  verifyMarketResidualGbdtV2Artifact,
  scoreMarketResidualGbdtV2,
  hashGbdtArtifactContent,
  MARKET_RESIDUAL_GBDT_V2_ARTIFACT_MANIFEST_VERSION,
  MARKET_OFFSET_COEFFICIENT
} from '../src/core/market_residual_gbdt_v2.js';
import { scoreShadowChallengers } from '../src/core/model_registry.js';
import {
  evaluateMoneyline,
  listRetiredRulesForProfile,
  resolveRuleProfile
} from '../src/rule_engine.js';

function richCoreInputs() {
  return {
    game: {
      gamePk: 778899,
      officialDate: '2026-08-15',
      gameDate: '2026-08-15T23:10:00Z',
      venue: { id: 19, name: 'Coors Field' },
      weather: { temp: '84', wind: '12 mph, Out to CF' },
      teams: {
        away: { team: { id: 119 }, probablePitcher: { id: 600001, pitchHand: { code: 'R' } } },
        home: { team: { id: 115 }, probablePitcher: { id: 600002, pitchHand: { code: 'L' } } }
      }
    },
    teamStats: {
      '119': { hitting: { gamesPlayed: 110, runs: 550, ops: '0.780' }, pitching: { era: '3.60', whip: '1.18' } },
      '115': { hitting: { gamesPlayed: 110, runs: 528, ops: '0.750' }, pitching: { era: '5.04', whip: '1.42' } }
    },
    standings: {
      '119': {
        leagueRecord: { wins: 68, losses: 42 },
        gamesPlayed: 110,
        runDifferential: 130,
        records: { splitRecords: [{ type: 'lastTen', pct: 0.7 }, { type: 'left', pct: 0.64 }, { type: 'right', pct: 0.61 }] }
      },
      '115': {
        leagueRecord: { wins: 45, losses: 65 },
        gamesPlayed: 110,
        runDifferential: -120,
        records: { splitRecords: [{ type: 'lastTen', pct: 0.4 }, { type: 'left', pct: 0.38 }, { type: 'right', pct: 0.42 }] }
      }
    },
    pitcherStats: {
      '600001': {
        era: '3.15', whip: '1.08', strikeoutsMinusWalksPercentage: 0.19, homeRunsPer9: 0.82,
        inningsPitched: '132.1', gamesStarted: 21,
        priorSeason: { inningsPitched: '185.0', gamesStarted: 30 }
      },
      '600002': {
        era: '4.85', whip: '1.38', strikeoutsMinusWalksPercentage: 0.09, homeRunsPer9: 1.55,
        inningsPitched: '96.0', gamesStarted: 19
      }
    },
    pitcherRecentStarts: {
      '600001': { games: 3, innings: 19.0, era: '2.84', whip: '1.00', restDays: 5 },
      '600002': { games: 3, innings: 14.0, era: '5.14', whip: '1.45', restDays: 5 }
    },
    bullpenProfiles: {
      '119': { fatigueScore: 1.2, backToBackRelievers: 0, reliefEra: 3.25, reliefWhip: 1.12 },
      '115': { fatigueScore: 3.4, backToBackRelievers: 2, reliefEra: 4.95, reliefWhip: 1.44 }
    },
    scheduleFatigueProfiles: {
      '119': { restDays: 1, roadStreak: 4, travelMiles: 1050, timezoneShiftHours: 1, fatigueScore: 0.42 },
      '115': { restDays: 0, roadStreak: 0, travelMiles: 0, timezoneShiftHours: 0, fatigueScore: 0.10 }
    },
    lineupProfiles: {
      away: {
        confirmed: true, count: 9, qualityScore: 0.08,
        platoonOps: 0.790, platoonWoba: 0.342,
        platoonOpsDelta: 0.025, platoonWobaDelta: 0.012,
        topOrderOps: 0.855
      },
      home: {
        confirmed: true, count: 9, qualityScore: -0.02,
        platoonOps: 0.715, platoonWoba: 0.308,
        platoonOpsDelta: -0.018, platoonWobaDelta: -0.008,
        topOrderOps: 0.760
      }
    },
    statcast: {
      teams: {
        '119': { xwoba: 0.348, barrelRate: 0.102 },
        '115': { xwoba: 0.301, barrelRate: 0.071 }
      },
      pitchers: {
        '600001': { xera: 3.05 },
        '600002': { xera: 4.92 }
      }
    },
    parkFactorBaselines: [
      { id: 19, value: { runFactor: 1.24, homeRunFactor: 1.18 } },
      { id: 115, value: { runFactor: 1.24, homeRunFactor: 1.18 } },
      { id: 119, value: { runFactor: 0.96, homeRunFactor: 1.02 } }
    ],
    headToHead: { games: 5, homeProbability: 40.0 },
    injuryProfiles: { '119': [{ position: 'OF' }], '115': [{ position: 'SS' }, { position: '1B' }] },
    rollingTeamStats: {}
  };
}

function makeSampleGbdtArtifact(schemaVersion = FEATURE_VECTOR_V2_SCHEMA_VERSION) {
  const artifact = {
    artifact_manifest_version: MARKET_RESIDUAL_GBDT_V2_ARTIFACT_MANIFEST_VERSION,
    model_id: MARKET_RESIDUAL_GBDT_V2_MODEL_ID,
    model_impl_version: MARKET_RESIDUAL_GBDT_V2_IMPL_VERSION,
    feature_schema_version: schemaVersion,
    feature_names:
      schemaVersion === FEATURE_VECTOR_V2_SCHEMA_VERSION
        ? FEATURE_VECTOR_V2_FEATURE_NAMES
        : FEATURE_VECTOR_V1_FEATURE_NAMES,
    market_offset_coefficient: MARKET_OFFSET_COEFFICIENT,
    base_score: -0.05,
    learning_rate: 0.1,
    max_depth: 2,
    l2_leaf: 10.0,
    min_child_hessian: 3.0,
    min_gain: 0.05,
    monotone_constraints: { platoonDeltaDiff: 1 },
    tree_count: 2,
    trees: [
      {
        nodes: [
          {
            leaf: false,
            feature: 'platoonDeltaDiff',
            threshold: 0.0,
            left: 1,
            right: 2,
            missing_dir: 'left'
          },
          { leaf: true, value: -0.4 },
          { leaf: true, value: 0.5 }
        ]
      },
      {
        nodes: [
          {
            leaf: false,
            feature: 'awayStarterHr9',
            threshold: 1.1,
            left: 1,
            right: 2,
            missing_dir: 'right'
          },
          { leaf: true, value: -0.2 },
          {
            leaf: false,
            feature: 'windHittingOut',
            threshold: 0.5,
            left: 3,
            right: 4,
            missing_dir: 'left'
          },
          { leaf: true, value: 0.1 },
          { leaf: true, value: 0.6 }
        ]
      }
    ]
  };
  artifact.artifact_hash = hashGbdtArtifactContent(artifact);
  return artifact;
}

// ============================================================================
// 4.1 Feature Vector v2.0 Tests
// ============================================================================

test('4.1 buildFeatureVector (v1.0) remains intact while buildFeatureVectorV2 emits v2.0 contract', () => {
  const inputs = richCoreInputs();
  const v1 = buildFeatureVector(inputs);
  const v2 = buildFeatureVectorV2(inputs, {
    asOfUtc: '2026-08-15T20:10:00Z',
    firstPitchUtc: '2026-08-15T23:10:00Z'
  });

  assert.equal(v1.schemaVersion, FEATURE_VECTOR_SCHEMA_VERSION);
  assert.equal(v2.schemaVersion, FEATURE_VECTOR_V2_SCHEMA_VERSION);
  assert.equal(FEATURE_VECTOR_V1_FEATURE_NAMES.length, 62);
  assert.equal(FEATURE_VECTOR_V2_EXTRA_FEATURE_NAMES.length, 45);
  assert.equal(FEATURE_VECTOR_V2_FEATURE_NAMES.length, 107);
  assert.notEqual(v1.featureVectorHash, v2.featureVectorHash);

  // Lead-time = 180 minutes pregame.
  assert.equal(v2.leadTimeMinutes.value, 180);
  assert.equal(v2.leadTimeMinutes.missing, 0);

  // Park factors & Coors Field deflation: home effRun = (1 + 1.24)/2 = 1.12.
  assert.equal(v2.gameParkRunFactor.value, 1.24);
  assert.equal(v2.gameParkHrFactor.value, 1.18);
  assert.ok(Math.abs(v2.homeHomeParkEffRunFactor.value - 1.12) < 1e-12);
  // Raw home RPG = 528/110 = 4.80; park-adjusted = 4.80 / 1.12 = 4.2857...
  assert.ok(Math.abs(v2.homeParkAdjRpg.value - 4.8 / 1.12) < 1e-12);
  assert.ok(Math.abs(v2.homeParkAdjEra.value - 5.04 / 1.12) < 1e-12);

  // Lineup platoon deltas & interaction diff: -0.008 - 0.012 = -0.020
  assert.ok(Math.abs(v2.platoonDeltaDiff.value - (-0.02)) < 1e-12);

  // Projected starter IP & shares: ace > struggling starter.
  assert.ok(v2.awayStarterProjectedIp.value > v2.homeStarterProjectedIp.value);
  assert.ok(v2.awayStarterShare.value > 0.65);

  // Bullpen relief quality, Statcast, travel & flyball x park/wind interaction.
  assert.equal(v2.awayBullpenReliefEra.value, 3.25);
  assert.equal(v2.awayTeamXwoba.value, 0.348);
  assert.equal(v2.awayTravelMiles.value, 1050);
  // flyballParkWindIndex = (0.82 - 1.55) * ((1.18 - 1.0) + 0.12) = -0.73 * 0.30 = -0.219
  assert.ok(Math.abs(v2.flyballParkWindIndex.value - (-0.219)) < 1e-12);

  // Flatten expands all 107 features + missing flags.
  const flat = flattenFeatureVector(v2);
  for (const fname of FEATURE_VECTOR_V2_FEATURE_NAMES) {
    assert.ok(Object.prototype.hasOwnProperty.call(flat, fname), `missing flat key ${fname}`);
    assert.ok(Object.prototype.hasOwnProperty.call(flat, `missing_${fname}`), `missing flag missing_${fname}`);
  }
});

test('4.1 buildFeatureVectorV2 fixes south-wind bug and enforces observed-only missingness', () => {
  const inputs = richCoreInputs();
  inputs.game.weather = { temp: '72', wind: '10 mph, south' };
  delete inputs.teamStats['115']; // missing raw stats must NOT fabricate park-adjusted stats!
  inputs.openerSituations = { away: { isOpener: true } };

  const v2 = buildFeatureVectorV2(inputs, {
    asOfUtc: '2026-08-15T23:30:00Z', // post-pitch -> leadTimeMinutes must be null!
    firstPitchUtc: '2026-08-15T23:10:00Z'
  });

  // Word-boundary fix: "south" must NOT trigger windHittingOut = 1.
  assert.equal(v2.windHittingOut.value, 0);
  assert.equal(v2.leadTimeMinutes.value, null);
  assert.equal(v2.leadTimeMinutes.missing, 1);

  // Observed-only guard: home park factor exists (1.12), but raw stats absent -> park-adj MUST be null!
  assert.equal(v2.homeHomeParkEffRunFactor.missing, 0);
  assert.equal(v2.homeParkAdjRpg.value, null);
  assert.equal(v2.homeParkAdjRpg.missing, 1);
  assert.equal(v2.homeParkAdjEra.value, null);
  assert.equal(v2.homeParkAdjOps.value, null);

  // Opener projects 1.75 IP continuously.
  assert.equal(v2.awayStarterProjectedIp.value, 1.75);
});

// ============================================================================
// 4.3 Shallow Monotone GBDT Verification & Inference Tests
// ============================================================================

test('4.3 verifyMarketResidualGbdtV2Artifact validates integrity and rejects tampering or depth violations', () => {
  const valid = makeSampleGbdtArtifact();
  assert.equal(verifyMarketResidualGbdtV2Artifact(valid).ok, true);

  // Reject tampered leaf value.
  const tampered = structuredClone(valid);
  tampered.trees[0].nodes[1].value = 9.9;
  const vTamper = verifyMarketResidualGbdtV2Artifact(tampered);
  assert.equal(vTamper.ok, false);
  assert.ok(vTamper.reasons.includes('artifact_hash_mismatch'));

  // Reject non-fixed market offset coefficient.
  const badOffset = structuredClone(valid);
  badOffset.market_offset_coefficient = 0.8;
  badOffset.artifact_hash = hashGbdtArtifactContent(badOffset);
  const vOffset = verifyMarketResidualGbdtV2Artifact(badOffset);
  assert.equal(vOffset.ok, false);
  assert.ok(vOffset.reasons.some((r) => r.includes('market_offset_coefficient_not_fixed_1')));

  // Reject max_depth > 3.
  const tooDeep = structuredClone(valid);
  tooDeep.max_depth = 4;
  tooDeep.artifact_hash = hashGbdtArtifactContent(tooDeep);
  const vDeep = verifyMarketResidualGbdtV2Artifact(tooDeep);
  assert.equal(vDeep.ok, false);
  assert.ok(vDeep.reasons.some((r) => r.includes('max_depth_invalid')));

  // Reject unknown feature in tree split.
  const badFeat = structuredClone(valid);
  badFeat.trees[0].nodes[0].feature = 'unknownFutureLeakFeature';
  badFeat.artifact_hash = hashGbdtArtifactContent(badFeat);
  const vFeat = verifyMarketResidualGbdtV2Artifact(badFeat);
  assert.equal(vFeat.ok, false);
  assert.ok(vFeat.reasons.some((r) => r.includes('unknown_feature')));
});

test('4.3 scoreMarketResidualGbdtV2 applies fixed market offset and native missing_dir routing', () => {
  const artifact = makeSampleGbdtArtifact();
  const flat = flattenFeatureVector(
    buildFeatureVectorV2(richCoreInputs(), {
      asOfUtc: '2026-08-15T20:10:00Z',
      firstPitchUtc: '2026-08-15T23:10:00Z'
    })
  );

  // Missing market -> unavailable (never fabricates).
  const noMkt = scoreMarketResidualGbdtV2(artifact, flat, null);
  assert.equal(noMkt.available, false);
  assert.equal(noMkt.homeProbability, null);

  // Present values: platoonDeltaDiff = -0.02 (<= 0 -> -0.4), awayStarterHr9 = 0.82 (<= 1.1 -> -0.2)
  // residual = -0.05 + 0.1 * (-0.4 + -0.2) = -0.11
  const pMkt = 0.55;
  const scored = scoreMarketResidualGbdtV2(artifact, flat, pMkt);
  assert.equal(scored.available, true);
  assert.equal(scored.treesEvaluated, 2);
  const expectedResidual = -0.05 + 0.1 * (-0.4 - 0.2);
  const expectedZ = Math.log(pMkt / (1 - pMkt)) + expectedResidual;
  const expectedProb = 1 / (1 + Math.exp(-expectedZ));
  assert.ok(Math.abs(scored.residualLogit - expectedResidual) < 1e-12);
  assert.ok(Math.abs(scored.homeProbability - expectedProb) < 1e-12);

  // Native missing_dir test: set awayStarterHr9 missing -> routes RIGHT (missing_dir='right'),
  // then windHittingOut = 1 (> 0.5) -> leaf 4 (+0.6)!
  const flatMissing = { ...flat, awayStarterHr9: null, missing_awayStarterHr9: 1 };
  const scoredMissing = scoreMarketResidualGbdtV2(artifact, flatMissing, pMkt);
  const expectedMissingResidual = -0.05 + 0.1 * (-0.4 + 0.6);
  assert.equal(scoredMissing.available, true);
  assert.ok(Math.abs(scoredMissing.residualLogit - expectedMissingResidual) < 1e-12);
});

// ============================================================================
// 4.2 Shadow Registry Orchestration Tests (v2.0 Linear + GBDT)
// ============================================================================

test('4.2 scoreShadowChallengers scores market_residual_gbdt_v2 when artifact present without mutating control', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'p4-shadow-gbdt-'));
  const gbdtArt = makeSampleGbdtArtifact(FEATURE_VECTOR_V2_SCHEMA_VERSION);
  writeFileSync(
    join(tempDir, 'market_residual_gbdt_v2-trained.json'),
    JSON.stringify({ status: 'trained', artifact: gbdtArt, artifact_hash: gbdtArt.artifact_hash })
  );

  // Also test market_residual_v2 accepting mlb-feature-vector-v2.0!
  const linearV2 = {
    artifact_manifest_version: 'market-residual-v2-artifact-v1',
    model_id: MARKET_RESIDUAL_V2_MODEL_ID,
    model_impl_version: MARKET_RESIDUAL_V2_IMPL_VERSION,
    feature_schema_version: FEATURE_VECTOR_V2_SCHEMA_VERSION,
    feature_names: ['platoonDeltaDiff'],
    coefficients: { platoonDeltaDiff: 0.5 },
    intercept: 0.0,
    imputation: { platoonDeltaDiff: 0.0 },
    feature_mean: { platoonDeltaDiff: 0.0 },
    feature_std: { platoonDeltaDiff: 1.0 },
    market_offset_coefficient: 1.0
  };
  linearV2.artifact_hash = hashLinearArtifact(linearV2);
  assert.equal(verifyMarketResidualV2Artifact(linearV2).ok, true);
  writeFileSync(
    join(tempDir, 'market_residual_v2-trained.json'),
    JSON.stringify({ status: 'trained', artifact: linearV2, artifact_hash: linearV2.artifact_hash })
  );

  process.env.MLB_SHADOW_MODE = 'true';
  try {
    const prediction = {
      coreInputs: richCoreInputs(),
      runId: 'run-778899-test',
      gamePk: 778899,
      dateYmd: '2026-08-15',
      asOfUtc: '2026-08-15T20:10:00Z',
      startTime: '2026-08-15T23:10:00Z',
      home: { id: 115 },
      away: { id: 119 },
      winner: 'LAD',
      winProbability: 62.5,
      currentOdds: { homeMoneyline: 135, awayMoneyline: -155, moneylineBook: 'pinnacle' }
    };

    const results = scoreShadowChallengers(prediction, { artifactsDir: tempDir });
    assert.equal(results.length, 3);

    const gbdtRes = results.find((r) => r.modelId === MARKET_RESIDUAL_GBDT_V2_MODEL_ID);
    assert.ok(gbdtRes?.entry, `expected GBDT entry, got reason: ${gbdtRes?.reason}`);
    assert.equal(gbdtRes.entry.status, 'SHADOW');
    assert.equal(gbdtRes.entry.promotionEligible, false);
    assert.equal(gbdtRes.entry.displayHomeProbability, null);
    assert.equal(gbdtRes.entry.featureSchemaVersion, FEATURE_VECTOR_V2_SCHEMA_VERSION);
    assert.equal(gbdtRes.entry.payload.treesEvaluated, 2);

    const linRes = results.find((r) => r.modelId === MARKET_RESIDUAL_V2_MODEL_ID);
    assert.ok(linRes?.entry, `expected linear v2 entry, got reason: ${linRes?.reason}`);
    assert.equal(linRes.entry.featureSchemaVersion, FEATURE_VECTOR_V2_SCHEMA_VERSION);

    // Control prediction untouched.
    assert.equal(prediction.winner, 'LAD');
    assert.equal(prediction.winProbability, 62.5);
  } finally {
    delete process.env.MLB_SHADOW_MODE;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 4.4 Gated Hard-Rule Simplification Profile Tests
// ============================================================================

test('4.4 simplified_challenger profile retires heuristic band-aid rules while preserving structural safety gates', () => {
  assert.equal(resolveRuleProfile({}), 'default');
  assert.equal(resolveRuleProfile({ ruleProfile: 'nonexistent_profile' }), 'default');
  assert.equal(resolveRuleProfile({ ruleProfile: 'simplified_challenger' }), 'simplified_challenger');
  assert.deepEqual(listRetiredRulesForProfile('default'), []);

  const retired = listRetiredRulesForProfile('simplified_challenger');
  assert.ok(retired.includes('js.team_quality'));
  assert.ok(retired.includes('js.away_underdog'));
  assert.ok(retired.includes('js.away_weak_conviction'));
  assert.ok(retired.includes('js.thin_matchup'));
  assert.ok(retired.includes('js.factor_agreement'));
  assert.ok(!retired.includes('js.stale_odds'));
  assert.ok(!retired.includes('js.ev_floor'));
  assert.ok(!retired.includes('js.cross_book_synthetic'));
  assert.ok(!retired.includes('js.adverse_selection_high_edge'));

  const baseCtx = {
    oddsFreshnessReason: null,
    edgeThreshold: 2.0,
    evThreshold: 2.0,
    disagreementAwayBypass: false,
    pickedTeamWinPct: 0.44, // triggers js.team_quality under default
    modelFavoredSide: 'away',
    evolutionControls: {},
    getEvolutionRule: () => null,
    option: {
      side: 'away',
      odds: 145, // triggers js.away_underdog under default
      edge: 3.2,
      expectedValuePct: 4.5,
      modelProbability: 54.0, // triggers js.away_weak_conviction under default
      sameBookDevig: true,
      confidenceLevel: 'rendah', // triggers js.factor_confidence under default
      confidenceSummary: 'mixed'
    },
    item: {
      away: { starter: 'Ace', openerSituation: { isOpener: false } },
      home: { starter: 'Starter', openerSituation: { isOpener: false } },
      currentOdds: { awayMoneylineBook: 'pinnacle', homeMoneylineBook: 'pinnacle' },
      lineups: { away: { confirmed: true, count: 9 }, home: { confirmed: true, count: 9 } },
      modelBreakdown: {
        matchupEdge: 0.03, // triggers js.thin_matchup & js.factor_agreement under default
        starterEdge: 0.0,
        offenseEdge: 0.0,
        bullpenEdge: 0.0,
        lineupEdge: 0.0,
        recordContextEdge: 0.12 // triggers js.record_dominance under default
      }
    }
  };

  // Under default profile: multiple heuristic patch rules fire.
  const defaultReasons = evaluateMoneyline(baseCtx);
  assert.ok(defaultReasons.length >= 5, `expected >=5 default reasons, got: ${defaultReasons.join(' | ')}`);

  // Under simplified_challenger profile: clean EV/edge/lineup/odds passes with ZERO blocks!
  const simplifiedReasons = evaluateMoneyline({ ...baseCtx, ruleProfile: 'simplified_challenger' });
  assert.deepEqual(simplifiedReasons, []);

  // Structural safety gates MUST still fire under simplified_challenger!
  const structuralFailure = evaluateMoneyline({
    ...baseCtx,
    ruleProfile: 'simplified_challenger',
    oddsFreshnessReason: 'odds moneyline stale 25m > 10m',
    option: { ...baseCtx.option, expectedValuePct: -1.5, sameBookDevig: false },
    item: {
      ...baseCtx.item,
      currentOdds: { awayMoneylineBook: 'draftkings', homeMoneylineBook: 'fanduel' }
    }
  });
  assert.ok(structuralFailure.some((r) => r.includes('stale')));
  assert.ok(structuralFailure.some((r) => r.includes('net executable EV')));
  assert.ok(structuralFailure.some((r) => r.includes('cross-book synthetic pair')));
});

// ============================================================================
// Phase 4 Deep Audit Regression Tests (Temuan #2, #4, #5)
// ============================================================================

test('Audit #4: buildFeatureVectorV2 detects live opener ratio/notes, derives restDays from lastStartDate, and rejects naive timestamps', () => {
  const inputs = richCoreInputs();
  // Live opener via career start ratio (no openerSituations field in snapshot).
  inputs.pitcherStats['600001'] = {
    era: '3.20', whip: '1.10', gamesStarted: 2, gamesPitched: 24,
    inningsPitched: '30.0'
  };
  // Home pitcher has lastStartDate = 2026-08-11 (officialDate 2026-08-15 => 3 rest days => -0.55 IP).
  // Also include a non-pitcher "Home opener" team note that MUST NOT trigger opener=1.75.
  inputs.game.teams.home.note = 'Home opener celebration at Coors Field';
  inputs.pitcherRecentStarts['600002'] = {
    games: 3, innings: 18.0, era: '4.10', whip: '1.30', lastStartDate: '2026-08-11'
  };
  const vShortRest = buildFeatureVectorV2(inputs, {
    asOfUtc: '2026-08-15T20:10:00', // naive timestamp without TZ -> rejected!
    firstPitchUtc: '2026-08-15T23:10:00Z'
  });
  assert.equal(vShortRest.awayStarterProjectedIp.value, 1.75);
  assert.equal(vShortRest.leadTimeMinutes.value, null);
  assert.equal(vShortRest.leadTimeMinutes.missing, 1);

  // Compare home projected IP on normal rest (lastStartDate 2026-08-10 => 4 rest days) vs short rest (3d).
  const normalInputs = structuredClone(inputs);
  normalInputs.pitcherRecentStarts['600002'].lastStartDate = '2026-08-10';
  const vNormalRest = buildFeatureVectorV2(normalInputs, {
    asOfUtc: '2026-08-15T20:10:00+00:00',
    firstPitchUtc: '2026-08-15T23:10:00Z'
  });
  assert.equal(vNormalRest.leadTimeMinutes.value, 180);
  assert.ok(
    Math.abs((vNormalRest.homeStarterProjectedIp.value - vShortRest.homeStarterProjectedIp.value) - 0.55) < 0.02,
    `expected ~0.55 IP drop for 3d short rest, got normal=${vNormalRest.homeStarterProjectedIp.value} vs short=${vShortRest.homeStarterProjectedIp.value}`
  );
});

test('Audit #2: simplified_challenger neutralizes disagreementAwayBypass so structural edge/EV/conviction floors hold', () => {
  const ctx = {
    oddsFreshnessReason: null,
    edgeThreshold: 2.0,
    evThreshold: 2.0,
    disagreementAwayBypass: true, // Host passed bypass=true
    pickedTeamWinPct: 0.6,
    modelFavoredSide: 'away',
    evolutionControls: {},
    getEvolutionRule: () => null,
    option: {
      side: 'away',
      odds: -105,
      edge: 0.8, // below 2.0% edge floor
      expectedValuePct: 0.6, // positive (>0%) but below 2.0% EV floor
      modelProbability: 49.0, // below 50% conviction floor
      sameBookDevig: true,
      confidenceLevel: 'tinggi',
      confidenceSummary: 'strong'
    },
    item: {
      away: { starter: 'A', openerSituation: { isOpener: false } },
      home: { starter: 'B', openerSituation: { isOpener: false } },
      currentOdds: { awayMoneylineBook: 'pinnacle', homeMoneylineBook: 'pinnacle' },
      lineups: { away: { confirmed: true, count: 9 }, home: { confirmed: true, count: 9 } },
      modelBreakdown: { matchupEdge: 0.25, starterEdge: -0.2, offenseEdge: -0.1, bullpenEdge: -0.1, lineupEdge: -0.1 }
    }
  };

  // Under default profile: disagreementAwayBypass relaxes edge/EV/conviction floors.
  const defaultReasons = evaluateMoneyline({ ...ctx, ruleProfile: 'default' });
  assert.ok(!defaultReasons.some((r) => r.includes('value edge hanya')));
  assert.ok(!defaultReasons.some((r) => r.includes('net executable EV')));
  assert.ok(!defaultReasons.some((r) => r.includes('model conviction')));

  // Under simplified_challenger: js.disagreement_away is retired -> bypass MUST be neutralized!
  const simplifiedReasons = evaluateMoneyline({ ...ctx, ruleProfile: 'simplified_challenger' });
  assert.ok(simplifiedReasons.some((r) => r.includes('value edge hanya')));
  assert.ok(simplifiedReasons.some((r) => r.includes('net executable EV')));
  assert.ok(simplifiedReasons.some((r) => r.includes('model conviction')));
});

test('Audit #5b: verifyMarketResidualGbdtV2Artifact rejects missing hash, tree_count mismatch, orphan nodes, and bad constraints', () => {
  const base = makeSampleGbdtArtifact();

  // Missing artifact_hash -> fail-closed!
  const noHash = structuredClone(base);
  delete noHash.artifact_hash;
  const rNoHash = verifyMarketResidualGbdtV2Artifact(noHash);
  assert.equal(rNoHash.ok, false);
  assert.ok(rNoHash.reasons.includes('artifact_hash_missing_or_invalid'));

  // tree_count mismatch -> rejected!
  const badCount = structuredClone(base);
  badCount.tree_count = 99;
  badCount.artifact_hash = hashGbdtArtifactContent(badCount);
  const rCount = verifyMarketResidualGbdtV2Artifact(badCount);
  assert.equal(rCount.ok, false);
  assert.ok(rCount.reasons.some((r) => r.includes('tree_count_mismatch')));

  // Orphan unreachable node -> rejected!
  const orphan = structuredClone(base);
  orphan.trees[0].nodes.push({ leaf: true, value: 0.0 });
  orphan.artifact_hash = hashGbdtArtifactContent(orphan);
  const rOrphan = verifyMarketResidualGbdtV2Artifact(orphan);
  assert.equal(rOrphan.ok, false);
  assert.ok(rOrphan.reasons.some((r) => r.includes('unreachable_orphan_nodes')));

  // Invalid monotone constraint direction -> rejected!
  const badMono = structuredClone(base);
  badMono.monotone_constraints = { platoonDeltaDiff: 2 };
  badMono.artifact_hash = hashGbdtArtifactContent(badMono);
  const rMono = verifyMarketResidualGbdtV2Artifact(badMono);
  assert.equal(rMono.ok, false);
  assert.ok(rMono.reasons.some((r) => r.includes('monotone_constraint_invalid_direction')));
});

