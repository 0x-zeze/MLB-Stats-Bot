import { useEffect, useState } from 'react';
import { Wallet, TrendingUp, TrendingDown } from 'lucide-react';
import { api } from '../api.js';
import { number, percent, signed } from '../utils.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';

function fmtOdds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${n > 0 ? '+' : ''}${Math.round(n)}`;
}

function StatPill({ label, value, tone = 'paper' }) {
  const toneClass = {
    paper: 'bg-paper',
    green: 'bg-accent-green',
    red: 'bg-accent-red',
    blue: 'bg-accent-blue',
    yellow: 'bg-accent-yellow',
  }[tone];
  return (
    <div className={`rounded-md border-2 border-ink px-3 py-2 shadow-neo-sm ${toneClass}`}>
      <p className="text-[10px] font-black uppercase text-ink/50">{label}</p>
      <p className="mt-1 text-sm font-black text-ink">{value}</p>
    </div>
  );
}

export default function LedgerSection() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.ledger()
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  const summary = data?.summary || {};
  const open = data?.open || [];
  const settled = data?.settled || [];
  const byMarket = data?.by_market || [];
  const plPositive = Number(summary.units_pl) >= 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Wallet className="h-5 w-5 text-ink" />
            <div>
              <CardTitle>Bet Ledger</CardTitle>
              <p className="mt-1 text-xs font-semibold text-ink/70">
                VALUE bets tracked at quarter-Kelly stakes on a {data?.bankroll_units || 100}u notional bankroll.
              </p>
            </div>
          </div>
          {!loading && settled.length > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-md border-2 border-ink bg-paper px-2 py-1 text-xs font-black uppercase text-ink shadow-neo-sm">
              {plPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {summary.record}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <p className="py-8 text-center text-sm font-black uppercase text-ink/60">Loading ledger...</p>
        ) : !data || (open.length === 0 && settled.length === 0) ? (
          <p className="py-8 text-center text-sm font-black uppercase text-ink/60">
            No VALUE bets recorded yet. They appear here once /picks surfaces a value pick.
          </p>
        ) : (
          <>
            <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
              <StatPill label="Open" value={summary.open_count} tone="yellow" />
              <StatPill label="Record" value={summary.record} tone="blue" />
              <StatPill label="Units Staked" value={`${number(summary.units_staked, 2)}u`} />
              <StatPill label="Units P/L" value={signed(summary.units_pl, 'u', 2)} tone={plPositive ? 'green' : 'red'} />
              <StatPill label="ROI" value={percent(summary.roi)} tone={Number(summary.roi) >= 0 ? 'green' : 'red'} />
            </div>

            {open.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-black uppercase tracking-tight text-ink/60">Open ({open.length})</p>
                <div className="overflow-x-auto rounded-md border-2 border-ink shadow-neo-sm">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b-2 border-ink bg-accent-yellow text-left text-[11px] font-black uppercase text-ink">
                        <th className="px-3 py-2">Date</th>
                        <th className="px-3 py-2">Team</th>
                        <th className="px-3 py-2">Odds</th>
                        <th className="px-3 py-2">Edge</th>
                        <th className="px-3 py-2">Stake</th>
                      </tr>
                    </thead>
                    <tbody>
                      {open.map((r) => (
                        <tr key={r.decision_id} className="border-b border-ink/20 last:border-0">
                          <td className="px-3 py-2 font-semibold text-ink/70">{r.date_ymd}</td>
                          <td className="px-3 py-2 font-black text-ink">{r.team || '-'}</td>
                          <td className="px-3 py-2 font-semibold text-ink">{fmtOdds(r.odds)}</td>
                          <td className="px-3 py-2 font-semibold text-ink">{signed(r.edge, '%')}</td>
                          <td className="px-3 py-2 font-semibold text-ink">{number(r.units_staked, 2)}u</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {settled.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-black uppercase tracking-tight text-ink/60">Settled ({settled.length})</p>
                <div className="overflow-x-auto rounded-md border-2 border-ink shadow-neo-sm">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b-2 border-ink bg-accent-blue text-left text-[11px] font-black uppercase text-ink">
                        <th className="px-3 py-2">Date</th>
                        <th className="px-3 py-2">Team</th>
                        <th className="px-3 py-2">Odds</th>
                        <th className="px-3 py-2">Result</th>
                        <th className="px-3 py-2">P/L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {settled.map((r) => (
                        <tr key={r.decision_id} className="border-b border-ink/20 last:border-0">
                          <td className="px-3 py-2 font-semibold text-ink/70">{r.date_ymd}</td>
                          <td className="px-3 py-2 font-black text-ink">{r.team || '-'}</td>
                          <td className="px-3 py-2 font-semibold text-ink">{fmtOdds(r.odds)}</td>
                          <td className="px-3 py-2">
                            <span className={`font-black uppercase ${r.result === 'win' ? 'text-accent-green' : r.result === 'loss' ? 'text-accent-red' : 'text-ink/60'}`}>
                              {r.result || '-'}
                            </span>
                          </td>
                          <td className={`px-3 py-2 font-black ${Number(r.units_pl) >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                            {signed(r.units_pl, 'u', 2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {byMarket.length > 1 && (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {byMarket.map((m) => (
                  <div key={m.market} className="rounded-md border-2 border-ink bg-paper px-3 py-2 shadow-neo-sm">
                    <p className="text-[10px] font-black uppercase text-ink/50">{m.market} ({m.bets})</p>
                    <p className="mt-1 text-sm font-black text-ink">
                      {signed(m.units_pl, 'u', 2)} <span className="text-ink/50">on {number(m.units_staked, 2)}u</span> ({percent(m.roi)})
                    </p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
