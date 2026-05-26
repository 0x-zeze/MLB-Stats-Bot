import { BarChart3, TrendingUp, ShieldAlert, Target, Gauge, Database } from 'lucide-react';
import { Button } from './ui/button.jsx';

export default function HeroSection({ onRefresh, onTabChange, summary = {}, loading }) {
  const metrics = [
    { label: 'Games Today', value: summary.total_games ?? '-', icon: BarChart3, color: 'text-accent-blue' },
    { label: 'Value Bets', value: summary.bet_count ?? '-', icon: TrendingUp, color: 'text-accent-green' },
    { label: 'Lean Picks', value: summary.lean_count ?? '-', icon: Target, color: 'text-accent-blue' },
    { label: 'No Bet', value: summary.no_bet_count ?? '-', icon: ShieldAlert, color: 'text-accent-red' },
    { label: 'Avg Quality', value: summary.average_data_quality ? `${Math.round(summary.average_data_quality)}` : '-', icon: Database, color: 'text-accent-yellow' },
    { label: 'Model Picks', value: summary.total_games ? (summary.bet_count + summary.lean_count) : '-', icon: Gauge, color: 'text-accent-green' },
  ];

  return (
    <section className="mb-8 animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl md:text-3xl font-bold text-white mb-2">
          MLB Prediction Control Center
        </h1>
        <p className="text-sm text-slate-400 max-w-2xl">
          Track today's MLB slate, model probabilities, moneyline value, totals, YRFI/NRFI signals, and Analyst Agent reasoning in one clean dashboard.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 mb-6">
        <Button variant="primary" size="sm" onClick={onRefresh}>Refresh Slate</Button>
        <Button size="sm" onClick={() => onTabChange('predictions')}>Run Analysis</Button>
        <Button variant="secondary" size="sm" onClick={() => onTabChange('telegram')}>Open Telegram Bot</Button>
        <Button variant="secondary" size="sm" onClick={() => onTabChange('backtest')}>View Backtest</Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {metrics.map((metric) => (
          <div key={metric.label} className="metric-card">
            <div className="flex items-center gap-2 mb-2">
              <metric.icon className={`h-4 w-4 ${metric.color}`} />
              <span className="text-[11px] text-slate-400 uppercase tracking-wider">{metric.label}</span>
            </div>
            {loading ? (
              <div className="h-7 w-12 skeleton rounded" />
            ) : (
              <p className="text-xl font-bold text-white">{metric.value}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
