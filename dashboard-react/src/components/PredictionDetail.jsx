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
        <button onClick={onClose} className="rounded-md border-2 border-ink bg-paper p-1 text-ink shadow-neo-sm transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-accent-red hover:shadow-neo">
          <X className="h-4 w-4" />
        </button>
      </CardHeader>
      <CardContent>
        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <h4 className="text-xs font-semibold text-ink/60 uppercase tracking-wider mb-3">Team Comparison</h4>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 rounded-lg border-2 border-ink bg-paper shadow-neo-sm">
                <div>
                  <p className="text-sm font-semibold text-ink">{game.away_team}</p>
                  <p className="text-xs text-ink/60">Away — {pitchers.away || 'TBD'}</p>
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-accent-blue">{awayProb ? `${awayProb.toFixed(1)}%` : '-'}</p>
                  <p className="text-[10px] text-ink/50">Win Prob</p>
                </div>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg border-2 border-ink bg-paper shadow-neo-sm">
                <div>
                  <p className="text-sm font-semibold text-ink">{game.home_team}</p>
                  <p className="text-xs text-ink/60">Home — {pitchers.home || 'TBD'}</p>
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-ink/70">{homeProb ? `${homeProb.toFixed(1)}%` : '-'}</p>
                  <p className="text-[10px] text-ink/50">Win Prob</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-4">
                <div className="text-center p-2 rounded-lg border-2 border-ink bg-paper shadow-neo-sm">
                  <p className="text-xs text-ink/60">Edge</p>
                  <p className={`text-sm font-semibold ${edge > 0 ? 'text-accent-green' : 'text-ink/60'}`}>
                    {edge ? `${edge > 0 ? '+' : ''}${edge.toFixed(1)}%` : '-'}
                  </p>
                </div>
                <div className="text-center p-2 rounded-lg border-2 border-ink bg-paper shadow-neo-sm">
                  <p className="text-xs text-ink/60">Confidence</p>
                  <p className="text-sm font-semibold text-accent-blue capitalize">{ml.confidence || '-'}</p>
                </div>
                <div className="text-center p-2 rounded-lg border-2 border-ink bg-paper shadow-neo-sm">
                  <p className="text-xs text-ink/60">Quality</p>
                  <p className="text-sm font-semibold text-ink">{quality.score || '-'}</p>
                </div>
              </div>

      
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-ink/60 uppercase tracking-wider mb-3">Analysis</h4>
            <div className="space-y-3">
              <div className="p-3 rounded-lg border-2 border-ink bg-accent-green shadow-neo-sm">
                <div className="flex items-center gap-2 mb-2">
                  <TrendingUp className="h-3.5 w-3.5 text-ink" />
                  <span className="text-xs font-black uppercase text-ink">Pick Recommendation</span>
                </div>
                <p className="text-sm text-ink font-semibold">{game.predicted_winner || game.final_lean || '-'}</p>
                <Badge variant={decisionVariant(game.decision)} className="mt-2">
                  {game.decision || 'NO BET'}
                </Badge>
                {game.no_bet_reason && (
                  <p className="text-xs text-ink/60 mt-1">{game.no_bet_reason}</p>
                )}
              </div>

              {factors.length > 0 && (
                <div className="p-3 rounded-lg border-2 border-ink bg-paper shadow-neo-sm">
                  <div className="flex items-center gap-2 mb-2">
                    <Brain className="h-3.5 w-3.5 text-accent-blue" />
                    <span className="text-xs font-semibold text-accent-blue">Key Factors</span>
                  </div>
                  <ul className="space-y-1.5 text-xs text-ink/70">
                    {factors.slice(0, 5).map((f, i) => <li key={i}>• {f}</li>)}
                  </ul>
                </div>
              )}

              {risks.length > 0 && (
                <div className="p-3 rounded-lg border-2 border-ink bg-accent-yellow shadow-neo-sm">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-ink" />
                    <span className="text-xs font-black uppercase text-ink">Risks</span>
                  </div>
                  <ul className="space-y-1 text-xs text-ink/70">
                    {risks.slice(0, 4).map((r, i) => <li key={i}>• {r}</li>)}
                  </ul>
                </div>
              )}

              {factors.length === 0 && risks.length === 0 && (
                <div className="p-3 rounded-lg border-2 border-ink bg-paper shadow-neo-sm">
                  <p className="text-xs text-ink/60">Detailed analysis will be available once the Analyst Agent processes this game.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
