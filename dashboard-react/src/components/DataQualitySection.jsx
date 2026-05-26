import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { Badge } from './ui/badge.jsx';
import { CheckCircle, AlertCircle, XCircle, MinusCircle } from 'lucide-react';

const STATUS_CONFIG = {
  CONNECTED: { icon: CheckCircle, color: 'text-accent-green', bg: 'bg-accent-green/10', variant: 'success' },
  PARTIAL: { icon: AlertCircle, color: 'text-accent-yellow', bg: 'bg-accent-yellow/10', variant: 'warning' },
  MISSING: { icon: XCircle, color: 'text-accent-red', bg: 'bg-accent-red/10', variant: 'danger' },
  UNAVAILABLE: { icon: MinusCircle, color: 'text-slate-400', bg: 'bg-slate-500/10', variant: 'neutral' },
};

const DATA_SOURCES = [
  { name: 'Schedule Data', provider: 'MLB Stats API', status: 'CONNECTED', latency: '120ms', lastUpdate: '2 min ago' },
  { name: 'Probable Pitchers', provider: 'MLB Stats API', status: 'CONNECTED', latency: '120ms', lastUpdate: '2 min ago' },
  { name: 'Standings', provider: 'MLB Stats API', status: 'CONNECTED', latency: '95ms', lastUpdate: '5 min ago' },
  { name: 'Injury Report', provider: 'MLB Stats API', status: 'PARTIAL', latency: '200ms', lastUpdate: '1 hr ago' },
  { name: 'Bullpen Data', provider: 'MLB Stats API', status: 'CONNECTED', latency: '150ms', lastUpdate: '10 min ago' },
  { name: 'Odds Provider', provider: 'The Odds API', status: 'CONNECTED', latency: '340ms', lastUpdate: '30 sec ago' },
  { name: 'LLM Analyst Agent', provider: 'OpenRouter', status: 'CONNECTED', latency: '1.2s', lastUpdate: 'Active' },
  { name: 'Memory Store', provider: 'SQLite', status: 'CONNECTED', latency: '5ms', lastUpdate: 'Active' },
  { name: 'Weather Data', provider: 'OpenWeather', status: 'PARTIAL', latency: '450ms', lastUpdate: '15 min ago' },
  { name: 'Umpire Data', provider: 'CSV / Manual', status: 'UNAVAILABLE', latency: '-', lastUpdate: 'Not configured' },
];

export default function DataQualitySection() {
  const connected = DATA_SOURCES.filter(s => s.status === 'CONNECTED').length;
  const total = DATA_SOURCES.length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Data Quality & Reliability</CardTitle>
            <p className="text-xs text-slate-400 mt-1">Real-time status of all data sources feeding the prediction engine.</p>
          </div>
          <div className="text-right">
            <p className="text-lg font-bold text-white">{connected}/{total}</p>
            <p className="text-[10px] text-slate-400">Sources Active</p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2">
          {DATA_SOURCES.map((source) => {
            const config = STATUS_CONFIG[source.status];
            const Icon = config.icon;
            return (
              <div key={source.name} className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] hover:border-white/[0.08] transition-colors">
                <div className="flex items-center gap-3">
                  <div className={`h-8 w-8 rounded-lg ${config.bg} flex items-center justify-center`}>
                    <Icon className={`h-4 w-4 ${config.color}`} />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">{source.name}</p>
                    <p className="text-[11px] text-slate-500">{source.provider}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right hidden sm:block">
                    <p className="text-[11px] text-slate-400">{source.latency}</p>
                    <p className="text-[10px] text-slate-500">{source.lastUpdate}</p>
                  </div>
                  <Badge variant={config.variant}>{source.status}</Badge>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
