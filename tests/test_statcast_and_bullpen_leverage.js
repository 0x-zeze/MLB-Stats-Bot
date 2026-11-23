import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _clearStatcastCache,
  blendStatcastBundle,
  fetchLiveStatcastBundle,
  parsePitcherStatcastTable,
  parseStatcastCsv,
  parseTeamStatcastTables,
  resolveSavantTeamId,
  sliceGameStatcast
} from '../src/statcast_collector.js';
import {
  buildCoreInputsSnapshot,
  bullpenAvailabilityEdge
} from '../src/core/prediction_core.js';
import { buildFeatureVectorV2 } from '../src/core/feature_vector.js';
import { __mlbTestInternals } from '../src/mlb.js';

const { finalizeBullpenProfile, summarizeBullpenLeverage } = __mlbTestInternals;

// ============================================================================
// Upgrade #1: Baseball Savant Live Statcast Collector Tests
// ============================================================================

test('parseStatcastCsv handles BOM, RFC-4180 quoted commas, and escaped quotes', () => {
  const csv = '\uFEFF"last_name, first_name",player_id,pa,est_woba,xera\n"Ohtani, Shohei",660271,650,0.415,\n"Skubal, Tarik",669373,740,0.242,2.48\n';
  const rows = parseStatcastCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['last_name, first_name'], 'Ohtani, Shohei');
  assert.equal(rows[0].player_id, '660271');
  assert.equal(rows[1].xera, '2.48');
});

test('parseTeamStatcastTables & parsePitcherStatcastTable resolve team aliases and normalize rates', () => {
  assert.equal(resolveSavantTeamId({ team_abbrev: 'WSN' }), 120);
  assert.equal(resolveSavantTeamId({ team_abbrev: 'CHW' }), 145);
  assert.equal(resolveSavantTeamId({ entity_name: 'Arizona D-backs' }), 109);
  assert.equal(resolveSavantTeamId({ team_abbrev: 'OAK' }), 133);

  const teamExpCsv = 'entity_id,team_abbrev,pa,est_woba\n119,LAD,2400,0.351\n147,NYY,2350,0.344\n';
  const teamBrlCsv = 'entity_id,team_abbrev,attempts,brl_percent\n119,LAD,1650,11.2\n147,NYY,1610,10.8%\n';
  const teams = parseTeamStatcastTables(teamExpCsv, teamBrlCsv);
  assert.equal(teams.get(119).xwoba, 0.351);
  assert.equal(teams.get(119).barrelRate, 0.112);
  assert.equal(teams.get(147).barrelRate, 0.108);

  const pitCsv = 'player_id,pa,est_woba,xera\n669373,710,0.245,2.54\n543037,520,0.278,3.18\n';
  const pitchers = parsePitcherStatcastTable(pitCsv);
  assert.equal(pitchers.get(669373).xera, 2.54);
  assert.equal(pitchers.get(543037).xwobaAllowed, 0.278);
});

test('blendStatcastBundle shrinks low-PA early-season stats toward prior without fabricating missing clubs', () => {
  const current = {
    teams: new Map([[119, { xwoba: 0.410, barrelRate: 0.140, pa: 130 }]]),
    pitchers: new Map([[669373, { xera: 1.80, xwobaAllowed: 0.210, pa: 40 }]])
  };
  const prior = {
    teams: new Map([
      [119, { xwoba: 0.340, barrelRate: 0.100, pa: 6200 }],
      [147, { xwoba: 0.335, barrelRate: 0.098, pa: 6100 }]
    ]),
    pitchers: new Map([[669373, { xera: 2.60, xwobaAllowed: 0.250, pa: 750 }]])
  };
  const blended = blendStatcastBundle(current, prior);
  // LAD weight = 130 / (130 + 650) = 1/6 -> 0.340 + (0.070 / 6) = 0.3517
  assert.ok(blended.teams['119'].xwoba > 0.345 && blended.teams['119'].xwoba < 0.360);
  assert.equal(blended.teams['119'].source, 'blended_prior');
  // NYY only in prior -> carried cleanly from prior.
  assert.equal(blended.teams['147'].xwoba, 0.335);
  assert.equal(blended.teams['147'].source, 'prior_only');
  // Missing club (e.g. 115) stays absent (never fabricated).
  assert.equal(blended.teams['115'], undefined);
  // Skubal weight = 40 / (40 + 120) = 0.25 -> 0.25 * 1.80 + 0.75 * 2.60 = 2.400
  assert.equal(blended.pitchers['669373'].xera, 2.4);
});

test('fetchLiveStatcastBundle caches, blends prior early in season, degrades gracefully, and flows into Feature Vector v2.0', async () => {
  _clearStatcastCache();
  let calls = 0;
  const mockFetch = async (url) => {
    calls += 1;
    if (url.includes('year=2026') && url.includes('batter-team') && url.includes('expected_statistics')) {
      return { ok: true, text: async () => 'entity_id,pa,est_woba\n119,300,0.360\n147,300,0.330\n' };
    }
    if (url.includes('year=2026') && url.includes('batter-team') && url.includes('statcast')) {
      return { ok: true, text: async () => 'entity_id,attempts,brl_percent\n119,200,11.5\n147,200,9.5\n' };
    }
    if (url.includes('year=2026') && url.includes('type=pitcher')) {
      return { ok: true, text: async () => 'player_id,pa,xera\n600001,60,2.70\n600002,60,4.50\n' };
    }
    if (url.includes('year=2025') && url.includes('batter-team') && url.includes('expected_statistics')) {
      return { ok: true, text: async () => 'entity_id,pa,est_woba\n119,6000,0.345\n147,6000,0.338\n' };
    }
    if (url.includes('year=2025') && url.includes('batter-team') && url.includes('statcast')) {
      return { ok: true, text: async () => 'entity_id,attempts,brl_percent\n119,4200,10.5\n147,4200,10.1\n' };
    }
    if (url.includes('year=2025') && url.includes('type=pitcher')) {
      return { ok: true, text: async () => 'player_id,pa,xera\n600001,700,3.10\n600002,700,4.10\n' };
    }
    return { ok: false, status: 503, text: async () => '' };
  };

  const bundle = await fetchLiveStatcastBundle(2026, { fetchImpl: mockFetch, nowMs: 1_000_000 });
  assert.equal(calls, 6); // 3 current + 3 prior (since maxTeamPa=300 < 2200)
  // Second call within TTL hits memory cache -> zero extra HTTP calls!
  const cached = await fetchLiveStatcastBundle(2026, { fetchImpl: mockFetch, nowMs: 1_060_000 });
  assert.equal(calls, 6);
  assert.deepEqual(cached, bundle);

  const sliced = sliceGameStatcast(bundle, {
    awayTeamId: 119,
    homeTeamId: 147,
    awayPitcherId: 600001,
    homePitcherId: 600002
  });
  const snap = buildCoreInputsSnapshot({
    game: {
      gamePk: 889900,
      officialDate: '2026-04-20',
      teams: {
        away: { team: { id: 119 }, probablePitcher: { id: 600001 } },
        home: { team: { id: 147 }, probablePitcher: { id: 600002 } }
      }
    },
    statcast: sliced
  });
  const v2 = buildFeatureVectorV2(snap, {
    asOfUtc: '2026-04-20T18:00:00Z',
    firstPitchUtc: '2026-04-20T23:05:00Z'
  });
  assert.equal(v2.awayTeamXwoba.missing, 0);
  assert.equal(v2.homeTeamXwoba.missing, 0);
  assert.equal(v2.awayTeamBarrelRate.missing, 0);
  assert.equal(v2.homeTeamBarrelRate.missing, 0);
  assert.equal(v2.awayStarterXera.missing, 0);
  assert.equal(v2.homeStarterXera.missing, 0);
  assert.ok(v2.awayStarterXera.value < v2.homeStarterXera.value);

  // Outage / network failure degrades gracefully to empty bundle.
  _clearStatcastCache();
  const empty = await fetchLiveStatcastBundle(2026, {
    fetchImpl: async () => {
      throw new Error('network down');
    },
    nowMs: 2_000_000
  });
  assert.deepEqual(empty, { teams: {}, pitchers: {} });
  _clearStatcastCache();
});

// ============================================================================
// Upgrade #2: Bullpen High-Leverage Availability Tracking & Edge Tests
// ============================================================================

test('finalizeBullpenProfile preserves legacy output when relieverUsage is absent and tracks high-leverage depletion when present', () => {
  // Legacy call without relieverUsage -> leverage fields remain null.
  const legacy = finalizeBullpenProfile({
    teamId: 119,
    games: 2,
    bullpenPitches: 60,
    bullpenOuts: 15,
    relieverAppearances: 4,
    relieverDates: new Map([['1', new Set(['2026-07-01', '2026-07-02'])]]),
    highPitchRelievers: 1
  });
  assert.equal(legacy.leverageFatigueScore, null);
  assert.equal(legacy.closerUnavailable, null);
  assert.equal(legacy.highLeverageUnavailable, null);

  // High-leverage closer (B2B yesterday+2d ago) + setup man (38 pitches yesterday) burned!
  const hlUsage = new Map([
    [
      '9001',
      {
        dates3d: new Set(['2026-07-01', '2026-07-02']),
        pitches3d: 34,
        pitchesYesterday: 18,
        pitchedYesterday: true,
        pitchedTwoDaysAgo: true,
        highLeverage: true,
        closerRole: true
      }
    ],
    [
      '9002',
      {
        dates3d: new Set(['2026-07-02']),
        pitches3d: 38,
        pitchesYesterday: 38,
        pitchedYesterday: true,
        pitchedTwoDaysAgo: false,
        highLeverage: true,
        closerRole: false
      }
    ],
    [
      '9003',
      {
        dates3d: new Set(['2026-07-02']),
        pitches3d: 45,
        pitchesYesterday: 45,
        pitchedYesterday: true,
        pitchedTwoDaysAgo: false,
        highLeverage: false, // mop-up reliever -> must NOT count as high-leverage unavailable!
        closerRole: false
      }
    ]
  ]);

  const burned = finalizeBullpenProfile({
    teamId: 147,
    games: 2,
    bullpenPitches: 117,
    bullpenOuts: 21,
    relieverAppearances: 4,
    relieverDates: new Map([['9001', new Set(['2026-07-01', '2026-07-02'])]]),
    relieverUsage: hlUsage,
    highPitchRelievers: 2
  });
  assert.equal(burned.highLeverageRelieversTracked, 2);
  assert.equal(burned.highLeverageUnavailable, 2);
  assert.equal(burned.closerUnavailable, true);
  // 2 * 0.55 + 0.25 closer bonus = 1.35
  assert.equal(burned.leverageFatigueScore, 1.35);
  assert.ok(burned.line.includes('HL unavail 2 (closer)'));

  // Mop-up-only depletion yields leverageFatigueScore = 0.
  const mopUpOnly = summarizeBullpenLeverage(new Map([['9003', hlUsage.get('9003')]]));
  assert.equal(mopUpOnly.highLeverageUnavailable, 0);
  assert.equal(mopUpOnly.closerUnavailable, false);
  assert.equal(mopUpOnly.leverageFatigueScore, 0);
});

test('bullpenAvailabilityEdge penalizes burned high-leverage bullpen asymmetrically by inning share', () => {
  const freshHome = {
    fatigueScore: 0.8,
    backToBackRelievers: 1,
    highPitchRelievers: 0,
    leverageFatigueScore: 0
  };
  const burnedAway = {
    fatigueScore: 0.8,
    backToBackRelievers: 1,
    highPitchRelievers: 0,
    leverageFatigueScore: 1.35 // closer + setup unavailable
  };
  const normalEdge = bullpenAvailabilityEdge(freshHome, burnedAway, {
    homeBullpenShare: 0.4,
    awayBullpenShare: 0.4
  });
  // 1.35 * 0.042 = +0.0567 favoring home!
  assert.ok(normalEdge > 0.05, `expected positive home edge from burned away HL arms, got ${normalEdge}`);

  // When away ALSO uses an opener (awayBullpenShare = 0.80 -> 2x exposure), penalty amplifies!
  const openerEdge = bullpenAvailabilityEdge(freshHome, burnedAway, {
    homeBullpenShare: 0.4,
    awayBullpenShare: 0.8
  });
  assert.ok(openerEdge > normalEdge * 1.5);
});
