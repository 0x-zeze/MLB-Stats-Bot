import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { Badge } from './ui/badge.jsx';
import { CheckCircle, AlertCircle, XCircle, MinusCircle } from 'lucide-react';

const STATUS_CONFIG = {
  CONNECTED: { icon: CheckCircle, color: 'text-accent-green', bg: 'bg-accent-green/10', variant: 'success' },
  PARTIAL: { icon: AlertCircle, color: 'text-accent-yellow', bg: 'bg-accent-yellow/10', variant: 'warning' },
  MISSING: { icon: XCircle, color: 'text-accent-red', bg: 'bg-accent-red/10', variant: 'danger' },
  UNAVAILABLE: { icon: MinusCircle, color: 'text-ink/60', bg: 'bg-paper', variant: 'neutral' },
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
            <p className="mt-1 text-xs font-semibold text-ink/70">Real-time status of all data sources feeding the prediction engine.</p>
          </div>
          <div className="text-right">
            <p className="text-lg font-black text-ink">{connected}/{total}</p>
            <p className="text-[10px] font-black uppercase text-ink/60">Sources Active</p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2">
          {DATA_SOURCES.map((source) => {
            const config = STATUS_CONFIG[source.status];
            const Icon = config.icon;
            return (
              <div key={source.name} className="flex items-center justify-between rounded-lg border-2 border-ink bg-paper p-3 shadow-neo-sm transition-colors hover:bg-cream">
                <div className="flex items-center gap-3">
                  <div className={`flex h-8 w-8 items-center justify-center rounded-lg border-2 border-ink ${config.bg} shadow-neo-sm`}>
                    <Icon className={`h-4 w-4 ${config.color}`} />
                  </div>
                  <div>
                    <p className="text-sm font-black text-ink">{source.name}</p>
                    <p className="text-[11px] font-semibold text-ink/50">{source.provider}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right hidden sm:block">
                    <p className="text-[11px] font-black text-ink/60">{source.latency}</p>
                    <p className="text-[10px] font-semibold text-ink/50">{source.lastUpdate}</p>
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
