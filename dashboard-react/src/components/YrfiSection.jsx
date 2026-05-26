import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { Badge } from './ui/badge.jsx';
import { Zap, ShieldCheck, AlertCircle } from 'lucide-react';

function SignalMeter({ value }) {
  const v = Number(value) || 50;
  const color = v >= 60 ? 'bg-accent-green' : v <= 40 ? 'bg-accent-red' : 'bg-accent-yellow';
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-2 rounded-full bg-white/10 overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${v}%` }} />
      </div>
      <span className="text-[11px] text-slate-400">{v}%</span>
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
          <p className="text-xs text-slate-400 mt-1">Will there be a run in the 1st inning? Model analyzes team scoring rates, pitcher vulnerability, leadoff OBP, and venue history.</p>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="text-center py-8 text-sm text-slate-400">No YRFI data available.</div>
        ) : (
          <div className="grid gap-3">
            {rows.map((game) => {
              const isYrfi = game.lean === 'YRFI' || game.lean === 'YES';
              const isNrfi = game.lean === 'NRFI' || game.lean === 'NO';
              const isNoBet = !isYrfi && !isNrfi;
              return (
                <div key={game.id} className="p-4 rounded-lg bg-white/[0.02] border border-white/[0.06] hover:border-white/[0.1] transition-colors">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-semibold text-white">{game.matchup}</span>
                      <Badge variant={isYrfi ? 'success' : isNrfi ? 'default' : 'nobet'}>
                        {isYrfi && <Zap className="h-3 w-3 mr-1" />}
                        {isNrfi && <ShieldCheck className="h-3 w-3 mr-1" />}
                        {isNoBet && <AlertCircle className="h-3 w-3 mr-1" />}
                        {game.lean}
                      </Badge>
                    </div>
                    <SignalMeter value={game.signal} />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase">YRFI Prob</p>
                      <p className="text-xs text-slate-300">{game.yrfiProb.toFixed(1)}%</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase">Confidence</p>
                      <p className={`text-xs capitalize ${game.confidence.toLowerCase() === 'high' ? 'text-accent-green' : game.confidence.toLowerCase() === 'medium' ? 'text-accent-blue' : 'text-accent-yellow'}`}>{game.confidence}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase">Signal</p>
                      <p className="text-xs text-slate-300">{game.signal >= 60 ? 'YRFI Lean' : game.signal <= 40 ? 'NRFI Lean' : 'Neutral'}</p>
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
