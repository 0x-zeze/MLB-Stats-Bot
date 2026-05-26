import { Clock, MapPin } from 'lucide-react';
import { Badge } from './ui/badge.jsx';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';

function decisionBadge(decision) {
  if (decision === 'BET') return <Badge variant="value">VALUE</Badge>;
  if (decision === 'LEAN') return <Badge variant="lean">LEAN</Badge>;
  return <Badge variant="nobet">NO BET</Badge>;
}

function ConfidenceColor({ confidence }) {
  const c = String(confidence || '').toLowerCase();
  const colors = { high: 'text-accent-green', medium: 'text-accent-blue', low: 'text-accent-yellow' };
  return <span className={`font-semibold capitalize ${colors[c] || 'text-slate-400'}`}>{confidence || '-'}</span>;
}

function QualityBar({ score }) {
  const s = Number(score) || 0;
  const color = s >= 80 ? 'bg-accent-green' : s >= 65 ? 'bg-accent-yellow' : 'bg-accent-red';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 rounded-full bg-white/10 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(s, 100)}%` }} />
      </div>
      <span className="text-[11px] text-slate-400">{s}</span>
    </div>
  );
}

function formatTime(gameTime) {
  if (!gameTime) return '-';
  try {
    const d = new Date(gameTime);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    return gameTime;
  }
}

function EmptySlate() {
  return (
    <div className="text-center py-12">
      <p className="text-slate-400 text-sm">No games scheduled for this date.</p>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="h-12 skeleton rounded-lg" />
      ))}
    </div>
  );
}

export default function TodaySlate({ games = [], loading, error, onSelectGame }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Today's Slate</CardTitle>
          <span className="text-xs text-slate-500">{games.length} game{games.length !== 1 ? 's' : ''}</span>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading && <LoadingSkeleton />}
        {error && (
          <div className="p-4 text-center">
            <p className="text-accent-red text-sm">{error}</p>
          </div>
        )}
        {!loading && !error && games.length === 0 && <EmptySlate />}
        {!loading && !error && games.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className="text-left px-4 py-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider">Matchup</th>
                  <th className="text-left px-4 py-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider hidden md:table-cell">Time</th>
                  <th className="text-left px-4 py-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider hidden lg:table-cell">Pitchers</th>
                  <th className="text-left px-4 py-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider hidden xl:table-cell">Venue</th>
                  <th className="text-left px-4 py-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider">Pick</th>
                  <th className="text-left px-4 py-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider">Confidence</th>
                  <th className="text-left px-4 py-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider hidden sm:table-cell">Quality</th>
                  <th className="text-left px-4 py-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider">Signal</th>
                </tr>
              </thead>
              <tbody>
                {games.map((game) => {
                  const pitchers = game.probable_pitchers || {};
                  const moneyline = game.moneyline || {};
                  const quality = game.data_quality || {};
                  const pick = game.predicted_winner || game.final_lean || '-';

                  return (
                    <tr
                      key={game.id}
                      onClick={() => onSelectGame?.(game)}
                      className="border-b border-white/[0.04] hover:bg-white/[0.02] cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3">
                        <span className="font-semibold text-white">{game.away_team || '-'}</span>
                        <span className="text-slate-500 mx-1.5">@</span>
                        <span className="font-semibold text-white">{game.home_team || '-'}</span>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="flex items-center gap-1.5 text-slate-300">
                          <Clock className="h-3 w-3 text-slate-500" />
                          {formatTime(game.game_time)}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell text-slate-300 text-xs">
                        {pitchers.away || 'TBD'} vs {pitchers.home || 'TBD'}
                      </td>
                      <td className="px-4 py-3 hidden xl:table-cell">
                        <span className="flex items-center gap-1.5 text-slate-400 text-xs">
                          <MapPin className="h-3 w-3" />
                          {game.ballpark || '-'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`font-semibold ${pick === 'NO BET' ? 'text-accent-red' : 'text-white'}`}>
                          {pick}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <ConfidenceColor confidence={moneyline.confidence} />
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <QualityBar score={quality.score} />
                      </td>
                      <td className="px-4 py-3">
                        {decisionBadge(game.decision)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
