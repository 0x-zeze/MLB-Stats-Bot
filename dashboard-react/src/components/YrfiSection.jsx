import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { Badge } from './ui/badge.jsx';
import { Zap, ShieldCheck, AlertCircle } from 'lucide-react';

function SignalMeter({ value }) {
  const v = Number(value) || 50;
  const color = v >= 60 ? 'bg-accent-green' : v <= 40 ? 'bg-accent-red' : 'bg-accent-yellow';
  return (
    <div className="flex items-center gap-2">
      <div className="h-3 w-20 overflow-hidden rounded-full border-2 border-ink bg-white">
        <div className={`h-full ${color} transition-all`} style={{ width: `${v}%` }} />
      </div>
      <span className="text-[11px] font-black text-ink">{v}%</span>
    </div>
  );
}

export default function YrfiSection({ games = [] }) {
  const rows = games.map((game) => {
    const fi = game.first_inning || {};
    const yrfiProb = Number(fi.yrfi_probability || fi.probability) || 50;
    const lean = fi.lean || fi.pick || 'NO BET';
    const confidence = fi.confidence || 'Low';
    return {
      id: game.id,
      matchup: `${game.away_team || '?'} @ ${game.home_team || '?'}`,
      yrfiProb,
      lean,
      confidence,
      signal: Math.round(yrfiProb),
    };
  });

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>YRFI / NRFI Analysis</CardTitle>
          <p className="mt-1 text-xs font-semibold text-ink/70">Will there be a run in the 1st inning? Model analyzes team scoring rates, pitcher vulnerability, leadoff OBP, and venue history.</p>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="py-8 text-center text-sm font-black uppercase text-ink/70">No YRFI data available.</div>
        ) : (
          <div className="grid gap-3">
            {rows.map((game) => {
              const isYrfi = game.lean === 'YRFI' || game.lean === 'YES';
              const isNrfi = game.lean === 'NRFI' || game.lean === 'NO';
              const isNoBet = !isYrfi && !isNrfi;
              return (
                <div key={game.id} className="rounded-lg border-3 border-ink bg-paper p-4 shadow-neo-sm transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-cream hover:shadow-neo">
                  <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-black text-ink">{game.matchup}</span>
                      <Badge variant={isYrfi ? 'success' : isNrfi ? 'default' : 'nobet'}>
                        {isYrfi && <Zap className="mr-1 h-3 w-3" />}
                        {isNrfi && <ShieldCheck className="mr-1 h-3 w-3" />}
                        {isNoBet && <AlertCircle className="mr-1 h-3 w-3" />}
                        {game.lean}
                      </Badge>
                    </div>
                    <SignalMeter value={game.signal} />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <div>
                      <p className="text-[10px] font-black uppercase text-ink/60">YRFI Prob</p>
                      <p className="text-xs font-black text-ink">{game.yrfiProb.toFixed(1)}%</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-black uppercase text-ink/60">Confidence</p>
                      <p className={`text-xs font-black capitalize ${game.confidence.toLowerCase() === 'high' ? 'text-green-700' : game.confidence.toLowerCase() === 'medium' ? 'text-blue-700' : 'text-yellow-700'}`}>{game.confidence}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-black uppercase text-ink/60">Signal</p>
                      <p className="text-xs font-black text-ink">{game.signal >= 60 ? 'YRFI Lean' : game.signal <= 40 ? 'NRFI Lean' : 'Neutral'}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
