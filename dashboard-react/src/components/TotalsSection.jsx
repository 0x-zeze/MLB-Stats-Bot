import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { Badge } from './ui/badge.jsx';
import { ArrowUp, ArrowDown } from 'lucide-react';

function ProbBar({ over, under }) {
  const o = Number(over) || 50;
  const u = Number(under) || 50;
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 text-right text-[11px] font-black text-green-700">{o}%</span>
      <div className="flex h-3 flex-1 overflow-hidden rounded-full border-2 border-ink bg-white">
        <div className="h-full bg-accent-green" style={{ width: `${o}%` }} />
        <div className="h-full bg-accent-red" style={{ width: `${u}%` }} />
      </div>
      <span className="w-8 text-[11px] font-black text-red-700">{u}%</span>
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
          <p className="mt-1 text-xs font-semibold text-ink/70">Projected total runs vs market line.</p>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="py-8 text-center text-sm font-black uppercase text-ink/70">No totals data available.</div>
        ) : (
          <div className="grid gap-4">
            {rows.map((game) => {
              const leanLower = game.lean.toLowerCase();
              const isOver = leanLower.includes('over');
              const isUnder = leanLower.includes('under');
              return (
                <div key={game.id} className="rounded-lg border-3 border-ink bg-paper p-4 shadow-neo-sm transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-cream hover:shadow-neo">
                  <div className="mb-3 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-black text-ink">{game.matchup}</span>
                      <Badge variant={isOver ? 'success' : isUnder ? 'danger' : 'neutral'}>
                        {isOver && <ArrowUp className="mr-1 h-3 w-3" />}
                        {isUnder && <ArrowDown className="mr-1 h-3 w-3" />}
                        {game.lean}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-center">
                        <p className="text-xs font-black uppercase text-ink/60">Projected</p>
                        <p className="text-sm font-black text-blue-700">{game.projected.toFixed(1)}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs font-black uppercase text-ink/60">Market</p>
                        <p className="text-sm font-black text-ink">{game.marketTotal}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs font-black uppercase text-ink/60">Diff</p>
                        <p className={`text-sm font-black ${game.diff > 0 ? 'text-green-700' : game.diff < 0 ? 'text-red-700' : 'text-ink/70'}`}>
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
