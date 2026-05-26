import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { Badge } from './ui/badge.jsx';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

function RecBadge({ decision }) {
  if (decision === 'BET') return <Badge variant="value">VALUE</Badge>;
  if (decision === 'LEAN') return <Badge variant="lean">LEAN ONLY</Badge>;
  return <Badge variant="nobet">NO BET</Badge>;
}

function EdgeDisplay({ edge }) {
  const val = Number(edge) || 0;
  if (val >= 3) return <span className="text-accent-green font-semibold flex items-center gap-1"><TrendingUp className="h-3 w-3" />+{val.toFixed(1)}%</span>;
  if (val >= 1.5) return <span className="text-accent-blue font-semibold flex items-center gap-1"><Minus className="h-3 w-3" />+{val.toFixed(1)}%</span>;
  if (val > 0) return <span className="text-slate-400 flex items-center gap-1">{val.toFixed(1)}%</span>;
  return <span className="text-slate-500 flex items-center gap-1"><TrendingDown className="h-3 w-3" />-</span>;
}

export default function MoneylineSection({ games = [] }) {
  const rows = games.map((game) => {
    const ml = game.moneyline || {};
    const modelProb = Number(ml.model_probability) || Number(ml.home_probability) || 0;
    const impliedProb = Number(ml.market_implied_probability) || 0;
    const edge = Number(ml.edge) || 0;
    return {
      id: game.id,
      matchup: `${game.away_team || '?'} @ ${game.home_team || '?'}`,
      pick: game.predicted_winner || '-',
      modelProb,
      impliedProb,
      edge,
      decision: game.decision,
      confidence: ml.confidence,
    };
  });

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Moneyline Value Engine</CardTitle>
          <p className="text-xs text-slate-400 mt-1">Model probability vs market implied probability. Identifies value where model edge exceeds threshold.</p>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="text-center py-8 text-sm text-slate-400">No moneyline data available.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className="text-left px-4 py-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider">Matchup</th>
                  <th className="text-left px-4 py-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider">Pick</th>
                  <th className="text-right px-4 py-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider">Model Prob</th>
                  <th className="text-right px-4 py-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider hidden sm:table-cell">Implied</th>
                  <th className="text-right px-4 py-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider hidden md:table-cell">Confidence</th>
                  <th className="text-right px-4 py-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider">Edge</th>
                  <th className="text-left px-4 py-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider">Signal</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-3 text-white font-medium">{row.matchup}</td>
                    <td className="px-4 py-3 text-white font-semibold">{row.pick}</td>
                    <td className="px-4 py-3 text-right text-accent-blue font-semibold">{row.modelProb ? `${row.modelProb.toFixed(1)}%` : '-'}</td>
                    <td className="px-4 py-3 text-right text-slate-300 hidden sm:table-cell">{row.impliedProb ? `${row.impliedProb.toFixed(1)}%` : '-'}</td>
                    <td className="px-4 py-3 text-right text-slate-300 hidden md:table-cell capitalize">{row.confidence || '-'}</td>
                    <td className="px-4 py-3 text-right"><EdgeDisplay edge={row.edge} /></td>
                    <td className="px-4 py-3"><RecBadge decision={row.decision} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
