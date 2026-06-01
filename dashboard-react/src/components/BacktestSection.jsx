import { useState } from 'react';
import { api } from '../api.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { Badge } from './ui/badge.jsx';
import { Button } from './ui/button.jsx';
import { BarChart3, TrendingUp, Target, Calendar, Play, Loader } from 'lucide-react';

export default function BacktestSection() {
  const [startDate, setStartDate] = useState('2026-05-04');
  const [endDate, setEndDate] = useState('2026-05-25');
  const [market, setMarket] = useState('all');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  async function handleRunBacktest(e) {
    e.preventDefault();
    setRunning(true);
    setError(null);
    setResults(null);
    try {
      const data = await api.backtest({ start_date: startDate, end_date: endDate, market_type: market });
      setResults(data);
    } catch (err) {
      setError(err.message || 'Backtest failed');
    } finally {
      setRunning(false);
    }
  }

  const summary = results?.summary || {};
  const byMarket = Array.isArray(results?.byMarket) ? results.byMarket : [];
  const calibration = Array.isArray(results?.calibration) ? results.calibration : [];
  const rows = Array.isArray(results?.rows) ? results.rows : [];
  const totalBets = summary.totalBets ?? summary.bets_taken ?? 0;
  const winRate = summary.winRate ?? summary.win_rate ?? 0;
  const roi = summary.roi ?? 0;
  const clv = summary.clv ?? summary.average_clv ?? 0;
  const brier = summary.brier ?? summary.brier_score ?? 0;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Backtest Results</CardTitle>
          <p className="mt-1 text-xs font-semibold text-ink/70">Historical model performance analysis with calibration metrics.</p>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleRunBacktest} className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border-3 border-ink bg-cream p-4 shadow-neo-sm">
          <div>
            <label className="block text-[11px] text-ink/60 uppercase tracking-wider mb-1">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="glass-input px-3 py-1.5 text-xs"
            />
          </div>
          <div>
            <label className="block text-[11px] text-ink/60 uppercase tracking-wider mb-1">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="glass-input px-3 py-1.5 text-xs"
            />
          </div>
          <div>
            <label className="block text-[11px] text-ink/60 uppercase tracking-wider mb-1">Market</label>
            <select
              value={market}
              onChange={(e) => setMarket(e.target.value)}
              className="glass-input px-3 py-1.5 text-xs"
            >
              <option value="all">All Markets</option>
              <option value="moneyline">Moneyline</option>
              <option value="totals">Totals</option>
              <option value="yrfi">YRFI</option>
            </select>
          </div>
          <Button type="submit" size="sm" variant="primary" disabled={running}>
            {running ? <><Loader className="h-3 w-3 animate-spin" /> Running...</> : <><Play className="h-3 w-3" /> Run Backtest</>}
          </Button>
        </form>

        {error && (
          <div className="mb-4 p-3 rounded-lg border-3 border-ink bg-accent-red text-ink shadow-neo-sm text-xs">
            {error}
          </div>
        )}

        {results && (
          <>
            <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
              <div className="metric-card text-center">
                <BarChart3 className="h-4 w-4 text-accent-blue mx-auto mb-1" />
                <p className="text-lg font-bold text-ink">{totalBets}</p>
                <p className="text-[10px] text-ink/60">Total Bets</p>
              </div>
              <div className="metric-card text-center">
                <Target className="h-4 w-4 text-accent-blue mx-auto mb-1" />
                <p className="text-lg font-bold text-ink">{winRate}%</p>
                <p className="text-[10px] text-ink/60">Win Rate</p>
              </div>
              <div className="metric-card text-center">
                <TrendingUp className="h-4 w-4 text-accent-green mx-auto mb-1" />
                <p className={`text-lg font-bold ${roi >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>{roi >= 0 ? '+' : ''}{roi}%</p>
                <p className="text-[10px] text-ink/60">ROI</p>
              </div>
              <div className="metric-card text-center">
                <p className={`text-lg font-bold ${clv >= 0 ? 'text-accent-blue' : 'text-accent-red'}`}>{clv >= 0 ? '+' : ''}{clv}%</p>
                <p className="text-[10px] text-ink/60">Avg CLV</p>
              </div>
              <div className="metric-card text-center">
                <p className="text-lg font-bold text-ink">{brier}</p>
                <p className="text-[10px] text-ink/60">Brier Score</p>
              </div>
            </div>

            <div className="grid lg:grid-cols-2 gap-4">
              <div>
                <h4 className="text-xs font-semibold text-ink/60 uppercase tracking-wider mb-3">By Market</h4>
                <div className="space-y-2">
                  {byMarket.length === 0 && (
                    <div className="rounded-lg border-2 border-ink bg-paper p-3 text-xs font-semibold text-ink/60 shadow-neo-sm">
                      No market breakdown available for this backtest.
                    </div>
                  )}
                  {byMarket.map((row) => (
                    <div key={row.market} className="flex items-center justify-between p-3 rounded-lg border-2 border-ink bg-paper shadow-neo-sm">
                      <div>
                        <p className="text-sm font-medium text-ink">{row.market}</p>
                        <p className="text-[11px] text-ink/50">{row.bets} bets</p>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className="text-xs text-ink/70">{row.winRate}%</p>
                          <p className="text-[10px] text-ink/50">Win Rate</p>
                        </div>
                        <div className="text-right">
                          <p className={`text-xs font-semibold ${row.roi >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                            {row.roi >= 0 ? '+' : ''}{row.roi}%
                          </p>
                          <p className="text-[10px] text-ink/50">ROI</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-ink/60 uppercase tracking-wider mb-3">Calibration</h4>
                <div className="space-y-2">
                  {calibration.length === 0 && (
                    <div className="rounded-lg border-2 border-ink bg-paper p-3 text-xs font-semibold text-ink/60 shadow-neo-sm">
                      No calibration buckets available for this backtest.
                    </div>
                  )}
                  {calibration.map((row) => {
                    const predicted = Number(row.predicted ?? row.expected ?? row.avg_probability ?? 0);
                    const actual = Number(row.actual ?? row.actual_rate ?? 0);
                    const error = actual - predicted;
                    const isOverconfident = error < -5;
                    return (
                      <div key={row.bucket} className="flex items-center justify-between p-3 rounded-lg border-2 border-ink bg-paper shadow-neo-sm">
                        <div>
                          <p className="text-sm font-medium text-ink">{row.bucket}</p>
                          <p className="text-[11px] text-ink/50">n={row.count}</p>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="text-right">
                            <p className="text-xs text-ink/70">{predicted.toFixed(1)}%</p>
                            <p className="text-[10px] text-ink/50">Predicted</p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-ink/70">{actual.toFixed(1)}%</p>
                            <p className="text-[10px] text-ink/50">Actual</p>
                          </div>
                          <Badge variant={isOverconfident ? 'danger' : 'success'}>
                            {error >= 0 ? '+' : ''}{error.toFixed(1)}%
                          </Badge>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {rows.length === 0 && (
              <div className="mt-4 rounded-lg border-3 border-ink bg-accent-yellow p-4 text-sm font-black text-ink shadow-neo-sm">
                Backtest ran, but no rows were found for this market/date range. Try a wider date range or another supported market.
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
