import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { Badge } from './ui/badge.jsx';
import { X, TrendingUp, AlertTriangle, Brain } from 'lucide-react';

function decisionVariant(decision) {
  if (decision === 'BET') return 'value';
  if (decision === 'LEAN') return 'lean';
  return 'nobet';
}

export default function PredictionDetail({ game, onClose }) {
  if (!game) return null;

  const ml = game.moneyline || {};
  const totals = game.totals || {};
  const quality = game.data_quality || {};
  const pitchers = game.probable_pitchers || {};
  const factors = game.main_factors || [];
  const risks = game.risk_factors || [];
  const homeProb = Number(ml.home_probability) || 0;
  const awayProb = Number(ml.away_probability) || 0;
  const edge = Number(ml.edge) || 0;

  return (
    <Card className="animate-slide-up">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{game.away_team} @ {game.home_team} — Prediction Detail</CardTitle>
        <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
          <X className="h-4 w-4" />
        </button>
      </CardHeader>
      <CardContent>
        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Team Comparison</h4>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                <div>
                  <p className="text-sm font-semibold text-white">{game.away_team}</p>
                  <p className="text-xs text-slate-400">Away — {pitchers.away || 'TBD'}</p>
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-accent-blue">{awayProb ? `${awayProb.toFixed(1)}%` : '-'}</p>
                  <p className="text-[10px] text-slate-500">Win Prob</p>
                </div>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                <div>
                  <p className="text-sm font-semibold text-white">{game.home_team}</p>
                  <p className="text-xs text-slate-400">Home — {pitchers.home || 'TBD'}</p>
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-slate-300">{homeProb ? `${homeProb.toFixed(1)}%` : '-'}</p>
                  <p className="text-[10px] text-slate-500">Win Prob</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-4">
                <div className="text-center p-2 rounded-lg bg-white/[0.02]">
                  <p className="text-xs text-slate-400">Edge</p>
                  <p className={`text-sm font-semibold ${edge > 0 ? 'text-accent-green' : 'text-slate-400'}`}>
                    {edge ? `${edge > 0 ? '+' : ''}${edge.toFixed(1)}%` : '-'}
                  </p>
                </div>
                <div className="text-center p-2 rounded-lg bg-white/[0.02]">
                  <p className="text-xs text-slate-400">Confidence</p>
                  <p className="text-sm font-semibold text-accent-blue capitalize">{ml.confidence || '-'}</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-white/[0.02]">
                  <p className="text-xs text-slate-400">Quality</p>
                  <p className="text-sm font-semibold text-white">{quality.score || '-'}</p>
                </div>
              </div>

              {totals.projected_total > 0 && (
                <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06] mt-3">
                  <p className="text-xs text-slate-400 mb-2">Totals</p>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-white">Projected: <span className="font-bold text-accent-blue">{Number(totals.projected_total).toFixed(1)}</span></span>
                    <span className="text-sm text-white">Market: <span className="font-bold">{totals.market_total}</span></span>
                    <Badge variant={totals.lean?.toLowerCase().includes('over') ? 'success' : totals.lean?.toLowerCase().includes('under') ? 'danger' : 'neutral'}>
                      {totals.lean || 'No lean'}
                    </Badge>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Analysis</h4>
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-accent-green/5 border border-accent-green/20">
                <div className="flex items-center gap-2 mb-2">
                  <TrendingUp className="h-3.5 w-3.5 text-accent-green" />
                  <span className="text-xs font-semibold text-accent-green">Pick Recommendation</span>
                </div>
                <p className="text-sm text-white font-semibold">{game.predicted_winner || game.final_lean || '-'}</p>
                <Badge variant={decisionVariant(game.decision)} className="mt-2">
                  {game.decision || 'NO BET'}
                </Badge>
                {game.no_bet_reason && (
                  <p className="text-xs text-slate-400 mt-1">{game.no_bet_reason}</p>
                )}
              </div>

              {factors.length > 0 && (
                <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                  <div className="flex items-center gap-2 mb-2">
                    <Brain className="h-3.5 w-3.5 text-accent-blue" />
                    <span className="text-xs font-semibold text-accent-blue">Key Factors</span>
                  </div>
                  <ul className="space-y-1.5 text-xs text-slate-300">
                    {factors.slice(0, 5).map((f, i) => <li key={i}>• {f}</li>)}
                  </ul>
                </div>
              )}

              {risks.length > 0 && (
                <div className="p-3 rounded-lg bg-accent-yellow/5 border border-accent-yellow/20">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-accent-yellow" />
                    <span className="text-xs font-semibold text-accent-yellow">Risks</span>
                  </div>
                  <ul className="space-y-1 text-xs text-slate-300">
                    {risks.slice(0, 4).map((r, i) => <li key={i}>• {r}</li>)}
                  </ul>
                </div>
              )}

              {factors.length === 0 && risks.length === 0 && (
                <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                  <p className="text-xs text-slate-400">Detailed analysis will be available once the Analyst Agent processes this game.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
