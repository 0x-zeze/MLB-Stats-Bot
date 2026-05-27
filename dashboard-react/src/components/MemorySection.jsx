import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { ArrowRight, CheckCircle, XCircle, Brain, RefreshCw } from 'lucide-react';
import { api } from '../api.js';

const LOOP_STEPS = [
  { label: 'Pre-game Prediction', icon: Brain, active: false },
  { label: 'Game Result', icon: CheckCircle, active: false },
  { label: 'Post-game Recap', icon: RefreshCw, active: true },
  { label: 'Memory Update', icon: RefreshCw, active: false },
  { label: 'Better Future Picks', icon: Brain, active: false },
];

function brierScore(probability, correct) {
  const p = (probability || 50) / 100;
  const y = correct ? 1 : 0;
  return ((p - y) ** 2).toFixed(2);
}

export default function MemorySection() {
  const [log, setLog] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.performance()
      .then((data) => {
        setLog(data?.recent_log || []);
        setStats(data?.overall || null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Memory & Learning Loop</CardTitle>
            <p className="mt-1 text-xs font-semibold text-ink/70">Post-game evaluation feeds back into the model for continuous improvement.</p>
          </div>
          {stats && (
            <div className="flex items-center gap-3 text-xs">
              <span className="text-accent-green font-semibold">{stats.wins || 0}W</span>
              <span className="text-accent-red font-semibold">{stats.losses || 0}L</span>
              <span className="font-black text-ink/70">{stats.win_rate || 0}% WR</span>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-center gap-1 mb-6 overflow-x-auto py-2">
          {LOOP_STEPS.map((step, i) => (
            <div key={step.label} className="flex items-center gap-1">
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium whitespace-nowrap ${
                step.active ? 'border-2 border-ink bg-accent-blue text-ink shadow-neo-sm' : 'border-2 border-ink bg-paper text-ink/60'
              }`}>
                <step.icon className="h-3 w-3" />
                {step.label}
              </div>
              {i < LOOP_STEPS.length - 1 && <ArrowRight className="h-3 w-3 flex-shrink-0 text-ink/50" />}
            </div>
          ))}
        </div>

        {loading ? (
          <p className="py-8 text-center text-sm font-black uppercase text-ink/60">Loading learning history...</p>
        ) : log.length === 0 ? (
          <p className="py-8 text-center text-sm font-black uppercase text-ink/60">No learning data yet. Run /postgame after games settle to build the learning loop.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-3 border-ink bg-accent-yellow">
                  <th className="px-3 py-2 text-left text-[11px] font-black uppercase text-ink">Date</th>
                  <th className="px-3 py-2 text-left text-[11px] font-black uppercase text-ink">Matchup</th>
                  <th className="px-3 py-2 text-left text-[11px] font-black uppercase text-ink">Pick</th>
                  <th className="px-3 py-2 text-left text-[11px] font-black uppercase text-ink">Result</th>
                  <th className="hidden px-3 py-2 text-right text-[11px] font-black uppercase text-ink sm:table-cell">Edge</th>
                  <th className="hidden px-3 py-2 text-right text-[11px] font-black uppercase text-ink md:table-cell">Brier</th>
                  <th className="hidden px-3 py-2 text-left text-[11px] font-black uppercase text-ink md:table-cell">Confidence</th>
                  <th className="hidden px-3 py-2 text-left text-[11px] font-black uppercase text-ink lg:table-cell">Lesson</th>
                </tr>
              </thead>
              <tbody>
                {log.map((row, i) => (
                  <tr key={row.gamePk || i} className={`${i % 2 === 0 ? 'bg-paper' : 'bg-cream'} border-b-2 border-ink transition-colors hover:bg-accent-yellow`}>
                    <td className="px-3 py-2.5 text-xs text-ink/60">{row.at ? new Date(row.at).toLocaleDateString() : '-'}</td>
                    <td className="px-3 py-2.5 text-xs text-ink font-medium">{row.matchup || '-'}</td>
                    <td className="px-3 py-2.5 text-xs text-ink">{row.pick || '-'}</td>
                    <td className="px-3 py-2.5">
                      {row.correct
                        ? <span className="inline-flex items-center gap-1 text-xs text-accent-green"><CheckCircle className="h-3 w-3" />Win</span>
                        : <span className="inline-flex items-center gap-1 text-xs text-accent-red"><XCircle className="h-3 w-3" />Loss</span>
                      }
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs hidden sm:table-cell">
                      <span className={row.edge > 0 ? 'text-accent-green' : row.edge < 0 ? 'text-accent-red' : 'text-ink/60'}>
                        {row.edge != null ? `${row.edge > 0 ? '+' : ''}${Number(row.edge).toFixed(1)}%` : '-'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs text-ink/70 hidden md:table-cell">{brierScore(row.pickProbability, row.correct)}</td>
                    <td className="px-3 py-2.5 text-xs hidden md:table-cell">
                      <span className="capitalize text-ink/70">{row.confidence || '-'}</span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-ink/60 max-w-[250px] truncate hidden lg:table-cell">{row.note || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
