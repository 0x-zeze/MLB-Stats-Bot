import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { Badge } from './ui/badge.jsx';
import { ArrowUp, ArrowDown } from 'lucide-react';

function ProbBar({ over, under }) {
  const o = Number(over) || 50;
  const u = Number(under) || 50;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-accent-green w-8 text-right">{o}%</span>
      <div className="flex-1 h-2 rounded-full bg-white/10 overflow-hidden flex">
        <div className="h-full bg-accent-green/60 rounded-l-full" style={{ width: `${o}%` }} />
        <div className="h-full bg-accent-red/40 rounded-r-full" style={{ width: `${u}%` }} />
      </div>
      <span className="text-[11px] text-accent-red w-8">{u}%</span>
    </div>
  );
}

export default function TotalsSection({ games = [] }) {
  const rows = games.map((game) => {
    const totals = game.totals || {};
    return {
      id: game.id,
      matchup: `${game.away_team || '?'} @ ${game.home_team || '?'}`,
      projected: Number(totals.projected_total) || 0,
      marketTotal: Number(totals.market_total) || 0,
      overProb: Number(totals.over_probability) || 50,
      underProb: Number(totals.under_probability) || 50,
      lean: totals.lean || 'No lean',
      diff: Number(totals.difference) || 0,
    };
  }).filter((r) => r.projected > 0);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Totals / Over-Under</CardTitle>
          <p className="text-xs text-slate-400 mt-1">Projected total runs vs market line.</p>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="text-center py-8 text-sm text-slate-400">No totals data available.</div>
        ) : (
          <div className="grid gap-4">
            {rows.map((game) => {
              const leanLower = game.lean.toLowerCase();
              const isOver = leanLower.includes('over');
              const isUnder = leanLower.includes('under');
              return (
                <div key={game.id} className="p-4 rounded-lg bg-white/[0.02] border border-white/[0.06] hover:border-white/[0.1] transition-colors">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-semibold text-white">{game.matchup}</span>
                      <Badge variant={isOver ? 'success' : isUnder ? 'danger' : 'neutral'}>
                        {isOver && <ArrowUp className="h-3 w-3 mr-1" />}
                        {isUnder && <ArrowDown className="h-3 w-3 mr-1" />}
                        {game.lean}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-center">
                        <p className="text-xs text-slate-400">Projected</p>
                        <p className="text-sm font-bold text-accent-blue">{game.projected.toFixed(1)}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-slate-400">Market</p>
                        <p className="text-sm font-bold text-white">{game.marketTotal}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-slate-400">Diff</p>
                        <p className={`text-sm font-bold ${game.diff > 0 ? 'text-accent-green' : game.diff < 0 ? 'text-accent-red' : 'text-slate-400'}`}>
                          {game.diff > 0 ? '+' : ''}{game.diff.toFixed(1)}
                        </p>
                      </div>
                    </div>
                  </div>
                  <ProbBar over={game.overProb} under={game.underProb} />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
