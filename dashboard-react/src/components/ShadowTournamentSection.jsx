import { useEffect, useState } from 'react';
import { Award, CheckCircle2, Lock, RefreshCw, ShieldAlert, Trophy } from 'lucide-react';
import { api } from '../api.js';
import { isFiniteNum } from '../utils.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';

function fmtNum(val, digits = 4) {
  if (!isFiniteNum(val)) return '-';
  return Number(val).toFixed(digits);
}

function fmtSigned(val, digits = 4) {
  if (!isFiniteNum(val)) return '-';
  const n = Number(val);
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;
}

function fmtPct(val, digits = 1) {
  if (!isFiniteNum(val)) return '-';
  return `${(Number(val) * 100).toFixed(digits)}%`;
}

function fmtSignedPct(val, digits = 2) {
  if (!isFiniteNum(val)) return '-';
  const pct = Number(val) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`;
}

const VERDICT_META = {
  PROMOTE_CANDIDATE_PENDING_APPROVAL: {
    label: 'Promote Candidate (Pending Approval)',
    tone: 'bg-accent-green',
  },
  CONTINUE_SHADOW: {
    label: 'Continue Shadow',
    tone: 'bg-accent-blue',
  },
  KEEP_V1: {
    label: 'Keep Heuristic V1',
    tone: 'bg-accent-red',
  },
  INSUFFICIENT_DATA: {
    label: 'Insufficient Data',
    tone: 'bg-accent-yellow',
  },
};

function StatusPill({ label, value, tone = 'paper' }) {
  const toneClass = {
    paper: 'bg-paper',
    green: 'bg-accent-green',
    red: 'bg-accent-red',
    blue: 'bg-accent-blue',
    yellow: 'bg-accent-yellow',
  }[tone] || 'bg-paper';
  return (
    <div className={`rounded-md border-2 border-ink px-3 py-2 shadow-neo-sm ${toneClass}`}>
      <p className="text-[10px] font-black uppercase text-ink/55">{label}</p>
      <p className="mt-1 text-sm font-black text-ink break-words">{value}</p>
    </div>
  );
}

export default function ShadowTournamentSection() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function loadTournament() {
    setLoading(true);
    setError(null);
    try {
      const payload = await api.shadowTournament();
      setData(payload);
    } catch (err) {
      setError(err?.message || 'Failed to load shadow tournament status.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTournament();
  }, []);

  const verdict = data?.verdict || 'INSUFFICIENT_DATA';
  const verdictMeta = VERDICT_META[verdict] || VERDICT_META.INSUFFICIENT_DATA;
  const commonGames = Number(data?.common_games || 0);
  const minGames = Number(data?.min_common_games || 200);
  const progressPct = Math.min(100, Math.max(0, Number(data?.progress_pct || 0)));
  const runtime = data?.runtime_config || {};
  const artifacts = data?.artifacts_present || {};
  const leaderboard = data?.leaderboard || [];
  const comparisons = data?.comparisons || {};
  const comparisonEntries = Object.entries(comparisons);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Trophy className="h-5 w-5 text-ink" />
              <div>
                <CardTitle>Shadow Tournament & Promotion Gate</CardTitle>
                <p className="mt-1 text-xs font-semibold text-ink/70">
                  Head-to-head evaluation on identical settled pregame runs (heuristic_v1 vs no-vig market vs challengers).
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {!loading && data && (
                <span className={`inline-flex items-center gap-1.5 rounded-md border-2 border-ink px-2.5 py-1 text-xs font-black uppercase text-ink shadow-neo-sm ${verdictMeta.tone}`}>
                  {data.rule_simplification_eligible ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <Lock className="h-3.5 w-3.5" />
                  )}
                  {verdictMeta.label}
                </span>
              )}
              <button
                onClick={loadTournament}
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-md border-2 border-ink bg-paper px-2.5 py-1 text-xs font-black uppercase text-ink shadow-neo-sm transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-accent-blue disabled:opacity-60"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          {loading ? (
            <p className="py-8 text-center text-sm font-black uppercase text-ink/60">
              Loading shadow tournament...
            </p>
          ) : error ? (
            <div className="rounded-md border-2 border-ink bg-accent-red/20 p-4 text-xs font-bold text-ink">
              {error}
            </div>
          ) : (
            <>
              <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
                <StatusPill
                  label="Active Control"
                  value={runtime.active_model_version || 'heuristic_v1'}
                  tone="paper"
                />
                <StatusPill
                  label="Shadow Mode"
                  value={runtime.shadow_mode ? 'ENABLED' : 'OFF (Safe Default)'}
                  tone={runtime.shadow_mode ? 'green' : 'yellow'}
                />
                <StatusPill
                  label="Rule Profile"
                  value={runtime.active_rule_profile || 'default'}
                  tone="blue"
                />
                <StatusPill
                  label="Rule Simplification"
                  value={data?.rule_simplification_eligible ? 'ELIGIBLE (Manual Approval)' : 'LOCKED (n >= 200 + CLV)'}
                  tone={data?.rule_simplification_eligible ? 'green' : 'paper'}
                />
              </div>

              <div className="rounded-md border-2 border-ink bg-paper p-3 shadow-neo-sm">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-black uppercase text-ink">
                  <span>Promotion Sample Progress</span>
                  <span>
                    {commonGames} / {minGames} Settled Games ({progressPct.toFixed(1)}%)
                  </span>
                </div>
                <div className="mt-2 h-3.5 w-full overflow-hidden rounded border-2 border-ink bg-ink/10">
                  <div
                    className={`h-full transition-all duration-300 ${
                      progressPct >= 100 ? 'bg-accent-green' : 'bg-accent-yellow'
                    }`}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <p className="mt-2 text-[11px] font-semibold text-ink/70">
                  Recommended profile: <span className="font-black text-ink">{data?.recommended_rule_profile || 'default'}</span>
                  {data?.winner_model_id ? ` · Leader: ${data.winner_model_id}` : ''}
                  {` · All-models intersection: ${data?.all_models_common_games ?? 0}`}
                </p>
              </div>

              <div>
                <p className="mb-2 text-xs font-black uppercase tracking-tight text-ink/60">
                  Challenger Artifacts (`data/models/`)
                </p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {Object.entries(artifacts).map(([modelId, info]) => (
                    <div
                      key={modelId}
                      className={`rounded-md border-2 border-ink p-3 shadow-neo-sm ${
                        info.present ? 'bg-accent-green/25' : 'bg-paper'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-black text-ink">{modelId}</span>
                        <span
                          className={`rounded border border-ink px-1.5 py-0.5 text-[10px] font-black uppercase ${
                            info.present ? 'bg-accent-green' : 'bg-accent-yellow'
                          }`}
                        >
                          {info.present ? 'READY' : 'NOT TRAINED'}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-[11px] font-semibold text-ink/70">
                        {info.present
                          ? `${info.feature_schema_version || 'v1'} · ${info.file}`
                          : 'Run npm run train:challengers after >= 120 settled games'}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {leaderboard.length > 0 ? (
                <div>
                  <p className="mb-2 text-xs font-black uppercase tracking-tight text-ink/60">
                    Head-to-Head Leaderboard (Lower Brier / Log-Loss Is Better)
                  </p>
                  <div className="overflow-x-auto rounded-md border-2 border-ink shadow-neo-sm">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b-2 border-ink bg-accent-blue text-left text-[11px] font-black uppercase text-ink">
                          <th className="px-3 py-2">Model</th>
                          <th className="px-3 py-2">N</th>
                          <th className="px-3 py-2">Brier</th>
                          <th className="px-3 py-2">Log-Loss</th>
                          <th className="px-3 py-2">ECE</th>
                          <th className="px-3 py-2">Accuracy</th>
                          <th className="px-3 py-2">Mean CLV</th>
                          <th className="px-3 py-2">CLV N</th>
                        </tr>
                      </thead>
                      <tbody>
                        {leaderboard.map((row, idx) => (
                          <tr
                            key={row.model_id}
                            className={`border-b border-ink/20 last:border-0 ${
                              idx === 0 ? 'bg-accent-green/15' : 'bg-paper'
                            }`}
                          >
                            <td className="px-3 py-2 font-black text-ink">
                              <span className="inline-flex items-center gap-1.5">
                                {idx === 0 && <Award className="h-3.5 w-3.5 text-ink" />}
                                {row.model_id}
                              </span>
                            </td>
                            <td className="px-3 py-2 font-semibold text-ink">{row.n ?? 0}</td>
                            <td className="px-3 py-2 font-mono text-xs font-bold text-ink">{fmtNum(row.brier, 5)}</td>
                            <td className="px-3 py-2 font-mono text-xs font-bold text-ink">{fmtNum(row.log_loss, 5)}</td>
                            <td className="px-3 py-2 font-mono text-xs font-semibold text-ink">{fmtNum(row.ece, 4)}</td>
                            <td className="px-3 py-2 font-semibold text-ink">{fmtPct(row.accuracy, 1)}</td>
                            <td className="px-3 py-2 font-mono text-xs font-bold text-ink">{fmtSignedPct(row.mean_clv, 2)}</td>
                            <td className="px-3 py-2 font-semibold text-ink">{row.clv_n ?? 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="rounded-md border-2 border-dashed border-ink bg-paper p-5 text-xs font-semibold text-ink/80 space-y-2">
                  <p className="text-sm font-black uppercase text-ink">
                    Offseason / Waiting for Live Settled Games
                  </p>
                  <p>
                    1. Start the bot during the MLB season (<code className="font-mono font-bold">npm start</code>) with <code className="font-mono font-bold">ODDS_API_KEY</code> configured so pregame snapshots, v2.0 features, and opening/closing odds accumulate in SQLite.
                  </p>
                  <p>
                    2. Once settled market-paired games reach 120+, run <code className="font-mono font-bold">npm run train:challengers</code> and set <code className="font-mono font-bold">MLB_SHADOW_MODE=true</code>.
                  </p>
                  <p>
                    3. After 200+ shadow games, a challenger beating both <code className="font-mono font-bold">no_vig_market</code> and <code className="font-mono font-bold">heuristic_v1</code> with positive CLV unlocks manual promotion and <code className="font-mono font-bold">simplified_challenger</code> rules.
                  </p>
                </div>
              )}

              {comparisonEntries.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-black uppercase tracking-tight text-ink/60">
                    Challenger Promotion Gate Breakdown
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    {comparisonEntries.map(([cid, comp]) => {
                      const passed = Boolean(comp.passed_promotion_gate);
                      const pbMkt = comp.bootstrap_vs_market?.log_loss?.prob_better;
                      return (
                        <div
                          key={cid}
                          className="rounded-md border-2 border-ink bg-paper p-3 shadow-neo-sm space-y-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-black text-ink">{cid}</span>
                            <span
                              className={`rounded border-2 border-ink px-2 py-0.5 text-[10px] font-black uppercase ${
                                passed ? 'bg-accent-green' : 'bg-accent-yellow'
                              }`}
                            >
                              {passed ? 'PASS' : 'HOLD'}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-xs font-semibold text-ink/80">
                            <div>Common N: <span className="font-black text-ink">{comp.common_games ?? 0}</span></div>
                            <div>Bootstrap P(Win): <span className="font-black text-ink">{fmtPct(pbMkt, 1)}</span></div>
                            <div>dBrier vs Mkt: <span className="font-mono font-black text-ink">{fmtSigned(comp.brier_gain_vs_market, 5)}</span></div>
                            <div>dLogLoss vs Mkt: <span className="font-mono font-black text-ink">{fmtSigned(comp.logloss_gain_vs_market, 5)}</span></div>
                            <div>dBrier vs V1: <span className="font-mono font-black text-ink">{fmtSigned(comp.brier_gain_vs_control, 5)}</span></div>
                            <div>Mean CLV: <span className="font-mono font-black text-ink">{fmtSignedPct(comp.mean_clv, 2)}</span></div>
                          </div>
                          {Array.isArray(comp.gate_failures) && comp.gate_failures.length > 0 && (
                            <div className="rounded border border-ink/30 bg-ink/5 p-2 text-[11px] font-semibold text-ink/80">
                              <span className="inline-flex items-center gap-1 font-black uppercase text-ink">
                                <ShieldAlert className="h-3 w-3" /> Active Hold Gates:
                              </span>
                              <ul className="mt-1 list-disc pl-4 space-y-0.5">
                                {comp.gate_failures.map((f) => (
                                  <li key={f} className="font-mono text-[10px]">{f}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
