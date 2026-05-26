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
    try {
      const data = await api.backtest({ start_date: startDate, end_date: endDate, market });
      setResults(data);
    } catch (err) {
      setError(err.message || 'Backtest failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Backtest Results</CardTitle>
          <p className="text-xs text-slate-400 mt-1">Historical model performance analysis with calibration metrics.</p>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleRunBacktest} className="flex flex-wrap items-end gap-3 mb-6 p-4 rounded-lg bg-white/[0.02] border border-white/[0.06]">
          <div>
            <label className="block text-[11px] text-slate-400 uppercase tracking-wider mb-1">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="glass-input px-3 py-1.5 text-xs"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 uppercase tracking-wider mb-1">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="glass-input px-3 py-1.5 text-xs"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 uppercase tracking-wider mb-1">Market</label>
            <select
              value={market}
              onChange={(e) => setMarket(e.target.value)}
              className="glass-input px-3 py-1.5 text-xs"
            >
              <option value="all">All Markets</option>
              <option value="moneyline">Moneyline</option>
              <option value="totals">Totals</option>
              <option value="yrfi">YRFI/NRFI</option>
            </select>
          </div>
          <Button type="submit" size="sm" variant="primary" disabled={running}>
            {running ? <><Loader className="h-3 w-3 animate-spin" /> Running...</> : <><Play className="h-3 w-3" /> Run Backtest</>}
          </Button>
        </form>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
            {error}
          </div>
        )}

        {results && (
          <>
            <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
              <div className="metric-card text-center">
                <BarChart3 className="h-4 w-4 text-accent-blue mx-auto mb-1" />
                <p className="text-lg font-bold text-white">{results.summary.totalBets}</p>
                <p className="text-[10px] text-slate-400">Total Bets</p>
              </div>
              <div className="metric-card text-center">
                <Target className="h-4 w-4 text-accent-blue mx-auto mb-1" />
                <p className="text-lg font-bold text-white">{results.summary.winRate}%</p>
                <p className="text-[10px] text-slate-400">Win Rate</p>
              </div>
              <div className="metric-card text-center">
                <TrendingUp className="h-4 w-4 text-accent-green mx-auto mb-1" />
                <p className="text-lg font-bold text-accent-green">+{results.summary.roi}%</p>
                <p className="text-[10px] text-slate-400">ROI</p>
              </div>
              <div className="metric-card text-center">
                <p className="text-lg font-bold text-accent-blue">+{results.summary.clv}%</p>
                <p className="text-[10px] text-slate-400">Avg CLV</p>
              </div>
              <div className="metric-card text-center">
                <p className="text-lg font-bold text-white">{results.summary.brier}</p>
                <p className="text-[10px] text-slate-400">Brier Score</p>
              </div>
            </div>

            <div className="grid lg:grid-cols-2 gap-4">
              <div>
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">By Market</h4>
                <div className="space-y-2">
                  {results.byMarket.map((row) => (
                    <div key={row.market} className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                      <div>
                        <p className="text-sm font-medium text-white">{row.market}</p>
                        <p className="text-[11px] text-slate-500">{row.bets} bets</p>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className="text-xs text-slate-300">{row.winRate}%</p>
                          <p className="text-[10px] text-slate-500">Win Rate</p>
                        </div>
                        <div className="text-right">
                          <p className={`text-xs font-semibold ${row.roi >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                            {row.roi >= 0 ? '+' : ''}{row.roi}%
                          </p>
                          <p className="text-[10px] text-slate-500">ROI</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Calibration</h4>
                <div className="space-y-2">
                  {results.calibration.map((row) => {
                    const error = row.actual - row.predicted;
                    const isOverconfident = error < -5;
                    return (
                      <div key={row.bucket} className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                        <div>
                          <p className="text-sm font-medium text-white">{row.bucket}</p>
                          <p className="text-[11px] text-slate-500">n={row.count}</p>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="text-right">
                            <p className="text-xs text-slate-300">{row.predicted.toFixed(1)}%</p>
                            <p className="text-[10px] text-slate-500">Predicted</p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-slate-300">{row.actual.toFixed(1)}%</p>
                            <p className="text-[10px] text-slate-500">Actual</p>
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
