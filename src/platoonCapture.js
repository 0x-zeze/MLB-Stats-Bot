// Player-level platoon capture. When a lineup confirms pre-game, snapshot each
// hitter's split (OPS/wOBA-proxy) against the OPPOSING starter's handedness.
// This is sharper than the team-level L/R split the live model uses today, but
// it is captured for LATER backtesting (write-once into feature_snapshots) — it
// is NOT yet wired into the live probability. Lineups only post ~1-3h before
// first pitch, so this can never be a first-pass pre-slate feature; the lineup
// monitor's "just confirmed" hook is the earliest valid capture point.

const MLB_BASE_URL = 'https://statsapi.mlb.com/api/v1';

function lineupHitterIds(boxTeam) {
  if (!boxTeam) return [];
  const hitters = Object.values(boxTeam.players || {})
    .filter((p) => p?.battingOrder)
    .sort((a, b) => Number.parseInt(a.battingOrder, 10) - Number.parseInt(b.battingOrder, 10));
  const seenSlots = new Set();
  const ids = [];
  for (const hitter of hitters) {
    const slot = Math.floor(Number.parseInt(hitter.battingOrder, 10) / 100) || Number.parseInt(hitter.battingOrder, 10);
    if (slot >= 1 && slot <= 9 && !seenSlots.has(slot)) {
      seenSlots.add(slot);
      const id = hitter?.person?.id;
      if (id) ids.push({ id, name: hitter?.person?.fullName || hitter?.person?.boxscoreName || String(id), slot });
    }
  }
  return ids;
}

// The split code we want for a hitter facing a pitcher of `pitcherHand`.
// 'vl' = vs LHP, 'vr' = vs RHP. Unknown hand -> null (skip, don't guess).
function splitCodeForHand(pitcherHand) {
  const code = String(pitcherHand || '').toUpperCase();
  if (code === 'L') return 'vl';
  if (code === 'R') return 'vr';
  return null;
}

// Pure: turn raw per-hitter split stats into a compact lineup platoon payload.
// `entries` = [{ id, name, slot, ops, atBats, obp, slg }]. Aggregates a simple
// AB-weighted mean OPS so the backtest has one lineup-level number plus the
// per-hitter detail to re-aggregate differently later.
export function buildPlatoonPayload(side, pitcherHand, entries) {
  const valid = (entries || []).filter((e) => Number.isFinite(e.ops) && Number.isFinite(e.atBats));
  const totalAb = valid.reduce((sum, e) => sum + e.atBats, 0);
  const weightedOps = totalAb > 0
    ? valid.reduce((sum, e) => sum + e.ops * e.atBats, 0) / totalAb
    : null;
  return {
    side,
    vsPitcherHand: String(pitcherHand || '').toUpperCase() || null,
    hittersCaptured: valid.length,
    totalAtBats: totalAb,
    weightedOps: weightedOps === null ? null : Math.round(weightedOps * 1000) / 1000,
    hitters: valid.map((e) => ({
      id: e.id,
      name: e.name,
      slot: e.slot,
      ops: e.ops,
      atBats: e.atBats
    }))
  };
}

async function fetchHitterSplit(personId, splitCode, season, fetchImpl) {
  const url = `${MLB_BASE_URL}/people/${personId}/stats?stats=statSplits&sitCodes=vl,vr&group=hitting&season=${season}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'mlb-stats-bot/platoon-capture' }
    });
    if (!response.ok) return null;
    const data = await response.json();
    const splits = data?.stats?.[0]?.splits || [];
    const match = splits.find((s) => s?.split?.code === splitCode);
    if (!match) return null;
    return {
      ops: Number(match.stat?.ops),
      atBats: Number(match.stat?.atBats),
      obp: Number(match.stat?.obp),
      slg: Number(match.stat?.slg)
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Capture platoon snapshots for one game's two confirmed lineups. Write-once per
// (gamePk, "platoon") so the first confirmed capture is preserved. Returns the
// payload written, or null when nothing usable was captured. `deps` injects
// fetch + season for testing.
export async function capturePlatoonForGame(game, boxscore, storage, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const season = deps.season || new Date().getUTCFullYear();
  if (!game || !boxscore || !storage) return null;

  const gamePk = String(game.gamePk || game.game_id || game.id || '');
  if (!gamePk) return null;
  if (storage.getFeatureSnapshot?.(gamePk, 'platoon')) return null; // already captured

  // Away hitters face the HOME starter; home hitters face the AWAY starter.
  const homeStarterHand = game.home?.starter?.pitchHand?.code;
  const awayStarterHand = game.away?.starter?.pitchHand?.code;

  const sides = [
    { side: 'away', boxTeam: boxscore.teams?.away, oppHand: homeStarterHand },
    { side: 'home', boxTeam: boxscore.teams?.home, oppHand: awayStarterHand }
  ];

  const payloadBySide = {};
  for (const { side, boxTeam, oppHand } of sides) {
    const splitCode = splitCodeForHand(oppHand);
    const hitters = lineupHitterIds(boxTeam);
    if (!splitCode || hitters.length < 9) continue; // need full lineup + known hand
    const entries = [];
    for (const hitter of hitters) {
      const split = await fetchHitterSplit(hitter.id, splitCode, season, fetchImpl);
      if (split) entries.push({ ...hitter, ...split });
    }
    if (entries.length) {
      payloadBySide[side] = buildPlatoonPayload(side, oppHand, entries);
    }
  }

  if (!Object.keys(payloadBySide).length) return null;

  const dateYmd = game.dateYmd || game.date || String(game.gameDate || '').slice(0, 10) || '';
  const written = storage.setFeatureSnapshot(gamePk, 'platoon', dateYmd, payloadBySide);
  return written ? payloadBySide : null;
}
