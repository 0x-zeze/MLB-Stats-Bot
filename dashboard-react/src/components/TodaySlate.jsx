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
  const colors = { high: 'bg-accent-green', medium: 'bg-accent-blue', low: 'bg-accent-yellow' };
  return (
    <span className={`inline-flex rounded-md border-2 border-ink px-2 py-0.5 text-xs font-black uppercase text-ink ${colors[c] || 'bg-stone-200'}`}>
      {confidence || '-'}
    </span>
  );
}

function QualityBar({ score }) {
  const s = Number(score) || 0;
  const color = s >= 80 ? 'bg-accent-green' : s >= 65 ? 'bg-accent-yellow' : 'bg-accent-red';
  return (
    <div className="flex items-center gap-2">
      <div className="h-3 w-16 overflow-hidden rounded-full border-2 border-ink bg-white">
        <div className={`h-full ${color}`} style={{ width: `${Math.min(s, 100)}%` }} />
      </div>
      <span className="text-[11px] font-black text-ink">{s}</span>
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
    <div className="p-12 text-center">
      <p className="text-sm font-black uppercase text-ink/70">No games scheduled for this date.</p>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="h-12 skeleton" />
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
          <span className="rounded-md border-2 border-ink bg-paper px-2 py-1 text-xs font-black uppercase text-ink shadow-neo-sm">
            {games.length} game{games.length !== 1 ? 's' : ''}
          </span>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading && <LoadingSkeleton />}
        {error && (
          <div className="p-4 text-center">
            <p className="whitespace-pre-line rounded-md border-2 border-ink bg-accent-red px-3 py-2 text-sm font-black text-ink shadow-neo-sm">{error}</p>
          </div>
        )}
        {!loading && !error && games.length === 0 && <EmptySlate />}
        {!loading && !error && games.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-3 border-ink bg-accent-blue">
                  <th className="px-4 py-3 text-left text-[11px] font-black uppercase tracking-tight text-ink">Matchup</th>
                  <th className="hidden px-4 py-3 text-left text-[11px] font-black uppercase tracking-tight text-ink md:table-cell">Time</th>
                  <th className="hidden px-4 py-3 text-left text-[11px] font-black uppercase tracking-tight text-ink lg:table-cell">Pitchers</th>
                  <th className="hidden px-4 py-3 text-left text-[11px] font-black uppercase tracking-tight text-ink xl:table-cell">Venue</th>
                  <th className="px-4 py-3 text-left text-[11px] font-black uppercase tracking-tight text-ink">Pick</th>
                  <th className="px-4 py-3 text-left text-[11px] font-black uppercase tracking-tight text-ink">Confidence</th>
                  <th className="hidden px-4 py-3 text-left text-[11px] font-black uppercase tracking-tight text-ink sm:table-cell">Quality</th>
                  <th className="px-4 py-3 text-left text-[11px] font-black uppercase tracking-tight text-ink">Signal</th>
                </tr>
              </thead>
              <tbody>
                {games.map((game, index) => {
                  const pitchers = game.probable_pitchers || {};
                  const moneyline = game.moneyline || {};
                  const quality = game.data_quality || {};
                  const pick = game.predicted_winner || game.final_lean || '-';

                  return (
                    <tr
                      key={game.id}
                      onClick={() => onSelectGame?.(game)}
                      className={`${index % 2 === 0 ? 'bg-paper' : 'bg-cream'} cursor-pointer border-b-2 border-ink transition-colors hover:bg-accent-yellow`}
                    >
                      <td className="px-4 py-3">
                        <span className="font-black text-ink">{game.away_team || '-'}</span>
                        <span className="mx-1.5 font-black text-ink/60">@</span>
                        <span className="font-black text-ink">{game.home_team || '-'}</span>
                      </td>
                      <td className="hidden px-4 py-3 md:table-cell">
                        <span className="flex items-center gap-1.5 font-semibold text-ink">
                          <Clock className="h-3 w-3 text-ink" />
                          {formatTime(game.game_time)}
                        </span>
                      </td>
                      <td className="hidden px-4 py-3 text-xs font-semibold text-ink lg:table-cell">
                        {pitchers.away || 'TBD'} vs {pitchers.home || 'TBD'}
                      </td>
                      <td className="hidden px-4 py-3 xl:table-cell">
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                          <MapPin className="h-3 w-3" />
                          {game.ballpark || '-'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`font-black ${pick === 'NO BET' ? 'text-red-700' : 'text-ink'}`}>
                          {pick}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <ConfidenceColor confidence={moneyline.confidence} />
                      </td>
                      <td className="hidden px-4 py-3 sm:table-cell">
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
