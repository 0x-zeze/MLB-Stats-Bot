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
  if (val >= 3) return <span className="flex items-center gap-1 font-black text-green-700"><TrendingUp className="h-3 w-3" />+{val.toFixed(1)}%</span>;
  if (val >= 1.5) return <span className="flex items-center gap-1 font-black text-blue-700"><Minus className="h-3 w-3" />+{val.toFixed(1)}%</span>;
  if (val > 0) return <span className="flex items-center gap-1 font-black text-ink/70">{val.toFixed(1)}%</span>;
  return <span className="flex items-center gap-1 font-black text-red-700"><TrendingDown className="h-3 w-3" />-</span>;
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
          <p className="mt-1 text-xs font-semibold text-ink/70">Model probability vs market implied probability. Identifies value where model edge exceeds threshold.</p>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="py-8 text-center text-sm font-black uppercase text-ink/70">No moneyline data available.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-3 border-ink bg-accent-green">
                  {['Matchup', 'Pick', 'Model Prob', 'Implied', 'Confidence', 'Edge', 'Signal'].map((label) => (
                    <th key={label} className="px-4 py-3 text-left text-[11px] font-black uppercase tracking-tight text-ink">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.id} className={`${index % 2 === 0 ? 'bg-paper' : 'bg-cream'} border-b-2 border-ink transition-colors hover:bg-accent-yellow`}>
                    <td className="px-4 py-3 font-black text-ink">{row.matchup}</td>
                    <td className="px-4 py-3 font-black text-ink">{row.pick}</td>
                    <td className="px-4 py-3 font-black text-blue-700">{row.modelProb ? `${row.modelProb.toFixed(1)}%` : '-'}</td>
                    <td className="px-4 py-3 font-semibold text-ink hidden sm:table-cell">{row.impliedProb ? `${row.impliedProb.toFixed(1)}%` : '-'}</td>
                    <td className="px-4 py-3 font-semibold capitalize text-ink hidden md:table-cell">{row.confidence || '-'}</td>
                    <td className="px-4 py-3"><EdgeDisplay edge={row.edge} /></td>
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
