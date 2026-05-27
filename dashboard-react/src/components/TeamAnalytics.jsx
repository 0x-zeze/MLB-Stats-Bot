import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';

function StatRow({ label, away, home, highlight }) {
  return (
    <div className="flex items-center justify-between border-b-2 border-ink py-1.5 last:border-0">
      <span className={`w-16 text-right text-xs font-black ${highlight === 'away' ? 'text-green-700' : 'text-ink/70'}`}>{away}</span>
      <span className="flex-1 text-center text-[11px] font-black uppercase text-ink/50">{label}</span>
      <span className={`w-16 text-xs font-black ${highlight === 'home' ? 'text-green-700' : 'text-ink/70'}`}>{home}</span>
    </div>
  );
}

export default function TeamAnalytics({ game }) {
  if (!game) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Team & Pitcher Analytics</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="py-8 text-center text-sm font-black uppercase text-ink/60">Select a game to view team analytics</p>
        </CardContent>
      </Card>
    );
  }

  const ml = game.moneyline || {};
  const totals = game.totals || {};
  const pitchers = game.probable_pitchers || {};
  const factors = game.main_factors || [];
  const risks = game.risk_factors || [];
  const quality = game.data_quality || {};

  const awayTeam = game.away_team || 'Away';
  const homeTeam = game.home_team || 'Home';

  const awayProb = Number(ml.away_probability) || 0;
  const homeProb = Number(ml.home_probability) || 0;
  const edge = ml.edge || ml.model_edge || 'N/A';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Team & Pitcher Analytics</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Left column: Team comparison */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-black text-ink">{awayTeam}</span>
              <span className="rounded-md border-2 border-ink bg-accent-yellow px-2 py-0.5 text-[11px] font-black uppercase text-ink shadow-neo-sm">vs</span>
              <span className="text-sm font-black text-ink">{homeTeam}</span>
            </div>

            {/* Moneyline probabilities */}
            <div className="space-y-0.5 mb-4">
              <p className="text-[10px] text-ink/50 uppercase tracking-wider mb-2 text-center">Model Probabilities</p>
              <StatRow
                label="Win %"
                away={awayProb ? `${awayProb.toFixed(1)}%` : '-'}
                home={homeProb ? `${homeProb.toFixed(1)}%` : '-'}
                highlight={awayProb > homeProb ? 'away' : homeProb > awayProb ? 'home' : undefined}
              />
              <StatRow
                label="Edge"
                away={edge !== 'N/A' ? `${Number(edge).toFixed(1)}%` : '-'}
                home=""
                highlight={edge !== 'N/A' && Number(edge) > 0 ? 'away' : undefined}
              />
            </div>

            {/* Totals */}
            {(totals.over_probability || totals.line || totals.total) && (
              <div className="space-y-0.5 mb-4">
                <p className="text-[10px] text-ink/50 uppercase tracking-wider mb-2 text-center">Totals</p>
                {totals.line && (
                  <StatRow label="Line" away={String(totals.line)} home="" />
                )}
                {totals.total && (
                  <StatRow label="Total" away={String(totals.total)} home="" />
                )}
                {totals.over_probability != null && (
                  <StatRow label="Over %" away={`${Number(totals.over_probability).toFixed(1)}%`} home="" />
                )}
                {totals.under_probability != null && (
                  <StatRow label="Under %" away={`${Number(totals.under_probability).toFixed(1)}%`} home="" />
                )}
              </div>
            )}

            {/* Data quality */}
            {quality.score != null && (
              <div className="space-y-0.5 mb-4">
                <p className="text-[10px] text-ink/50 uppercase tracking-wider mb-2 text-center">Data Quality</p>
                <StatRow label="Score" away={String(quality.score)} home="" />
                {quality.tier && <StatRow label="Tier" away={quality.tier} home="" />}
              </div>
            )}
          </div>

          {/* Right column: Pitchers & Factors */}
          <div>
            {/* Probable Pitchers */}
            {(pitchers.away || pitchers.home) && (
              <div className="mb-4">
                <h4 className="text-xs font-semibold text-ink/60 uppercase tracking-wider mb-3">Probable Pitchers</h4>
                <div className="space-y-2">
                  {pitchers.away && (
                    <div className="flex items-center gap-3 py-2 px-3 rounded border-2 border-ink bg-paper shadow-neo-sm">
                      <span className="text-[10px] text-ink/50 uppercase w-10">Away</span>
                      <span className="text-sm font-semibold text-ink">{pitchers.away}</span>
                    </div>
                  )}
                  {pitchers.home && (
                    <div className="flex items-center gap-3 py-2 px-3 rounded border-2 border-ink bg-paper shadow-neo-sm">
                      <span className="text-[10px] text-ink/50 uppercase w-10">Home</span>
                      <span className="text-sm font-semibold text-ink">{pitchers.home}</span>
                    </div>
                  )}
                  {pitchers.status && (
                    <p className="text-[11px] text-ink/50 text-center mt-1">Status: {pitchers.status}</p>
                  )}
                </div>
              </div>
            )}

            {/* Main Factors */}
            {factors.length > 0 && (
              <div className="mb-4">
                <h4 className="text-xs font-semibold text-ink/60 uppercase tracking-wider mb-3">Main Factors</h4>
                <ul className="space-y-1.5">
                  {factors.map((f, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-ink/70 py-1 px-2 rounded border-2 border-ink bg-paper shadow-neo-sm">
                      <span className="text-accent-green mt-0.5">▸</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Risk Factors */}
            {risks.length > 0 && (
              <div className="mb-4">
                <h4 className="text-xs font-semibold text-ink/60 uppercase tracking-wider mb-3">Risk Factors</h4>
                <ul className="space-y-1.5">
                  {risks.map((r, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-ink/70 py-1 px-2 rounded border-2 border-ink bg-paper shadow-neo-sm">
                      <span className="text-accent-red mt-0.5">▸</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Empty state */}
            {!pitchers.away && !pitchers.home && factors.length === 0 && risks.length === 0 && (
              <p className="text-ink/50 text-sm text-center py-4">No additional data available</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
