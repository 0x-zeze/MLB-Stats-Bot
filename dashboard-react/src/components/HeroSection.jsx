import { BarChart3, TrendingUp, ShieldAlert, Target, Gauge, Database } from 'lucide-react';
import { Button } from './ui/button.jsx';

export default function HeroSection({ onRefresh, onTabChange, summary = {}, loading }) {
  const metrics = [
    { label: 'Games Today', value: summary.total_games ?? '-', icon: BarChart3, color: 'bg-accent-blue' },
    { label: 'Value Bets', value: summary.bet_count ?? '-', icon: TrendingUp, color: 'bg-accent-green' },
    { label: 'Lean Picks', value: summary.lean_count ?? '-', icon: Target, color: 'bg-accent-blue' },
    { label: 'No Bet', value: summary.no_bet_count ?? '-', icon: ShieldAlert, color: 'bg-accent-red' },
    { label: 'Avg Quality', value: summary.average_data_quality ? `${Math.round(summary.average_data_quality)}` : '-', icon: Database, color: 'bg-accent-yellow' },
    { label: 'Model Picks', value: summary.total_games ? (summary.bet_count + summary.lean_count) : '-', icon: Gauge, color: 'bg-accent-green' },
  ];

  return (
    <section className="mb-8 animate-fade-in">
      <div className="mb-6 rounded-lg border-4 border-ink bg-paper p-6 shadow-neo-lg">
        <p className="mb-2 inline-flex rounded-md border-2 border-ink bg-accent-red px-3 py-1 text-xs font-black uppercase tracking-tight text-ink shadow-neo-sm">
          Live MLB Model Room
        </p>
        <h1 className="mb-3 max-w-4xl text-3xl font-black uppercase leading-none tracking-tight text-ink md:text-5xl">
          MLB Prediction Control Center
        </h1>
        <p className="max-w-3xl text-sm font-semibold leading-6 text-ink/75 md:text-base">
          Track today's MLB slate, model probabilities, moneyline value, totals, YRFI/NRFI signals, and Analyst Agent reasoning in one loud dashboard.
        </p>
      </div>

      <div className="mb-6 flex flex-wrap gap-3">
        <Button variant="primary" size="sm" onClick={onRefresh}>Refresh Slate</Button>
        <Button size="sm" onClick={onRefresh} disabled={loading}>{loading ? 'Running...' : 'Run Analysis'}</Button>
        <Button variant="secondary" size="sm" onClick={() => onTabChange('telegram')}>Open Telegram Bot</Button>
        <Button variant="secondary" size="sm" onClick={() => onTabChange('backtest')}>View Backtest</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {metrics.map((metric) => (
          <div key={metric.label} className="metric-card">
            <div className="mb-3 flex items-center gap-2">
              <span className={`flex h-8 w-8 items-center justify-center rounded-md border-2 border-ink ${metric.color} shadow-neo-sm`}>
                <metric.icon className="h-4 w-4 text-ink" />
              </span>
              <span className="text-[11px] font-black uppercase tracking-tight text-ink/70">{metric.label}</span>
            </div>
            {loading ? (
              <div className="h-7 w-16 skeleton" />
            ) : (
              <p className="text-3xl font-black text-ink">{metric.value}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
