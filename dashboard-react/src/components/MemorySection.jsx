import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { Badge } from './ui/badge.jsx';
import { ArrowRight, CheckCircle, XCircle, Brain, RefreshCw } from 'lucide-react';

const MOCK_MEMORY = [
  { date: '2026-05-25', matchup: 'NYY @ TOR', pick: 'NYY', result: 'win', closingMove: '+3', brier: 0.18, roi: '+1.0', lesson: 'Cole dominance pattern confirmed vs weak lineups', status: 'Updated' },
  { date: '2026-05-25', matchup: 'LAD @ ARI', pick: 'LAD', result: 'loss', closingMove: '-5', brier: 0.35, roi: '-1.0', lesson: 'Desert heat + day game fatigue underweighted', status: 'Updated' },
  { date: '2026-05-24', matchup: 'ATL @ MIA', pick: 'ATL', result: 'win', closingMove: '+1', brier: 0.12, roi: '+1.0', lesson: 'Bullpen fatigue signal correctly identified', status: 'Updated' },
  { date: '2026-05-24', matchup: 'HOU @ SEA', pick: 'HOU', result: 'loss', closingMove: '-8', brier: 0.42, roi: '-1.0', lesson: 'Sharp money against pick was correct — respect closing line movement', status: 'Updated' },
  { date: '2026-05-23', matchup: 'CLE @ DET', pick: 'CLE', result: 'win', closingMove: '0', brier: 0.21, roi: '+1.0', lesson: 'Pitcher rest days advantage validated', status: 'Updated' },
];

const LOOP_STEPS = [
  { label: 'Pre-game Prediction', icon: Brain, active: false },
  { label: 'Game Result', icon: CheckCircle, active: false },
  { label: 'Post-game Recap', icon: RefreshCw, active: true },
  { label: 'Memory Update', icon: RefreshCw, active: false },
  { label: 'Better Future Picks', icon: Brain, active: false },
];

export default function MemorySection() {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Memory & Learning Loop</CardTitle>
          <p className="text-xs text-slate-400 mt-1">Post-game evaluation feeds back into the model for continuous improvement.</p>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-center gap-1 mb-6 overflow-x-auto py-2">
          {LOOP_STEPS.map((step, i) => (
            <div key={step.label} className="flex items-center gap-1">
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium whitespace-nowrap ${
                step.active ? 'bg-accent-blue/15 text-accent-blue border border-accent-blue/30' : 'bg-white/[0.03] text-slate-400 border border-white/[0.06]'
              }`}>
                <step.icon className="h-3 w-3" />
                {step.label}
              </div>
              {i < LOOP_STEPS.length - 1 && <ArrowRight className="h-3 w-3 text-slate-600 flex-shrink-0" />}
            </div>
          ))}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="text-left px-3 py-2 text-[11px] font-medium text-slate-400 uppercase">Date</th>
                <th className="text-left px-3 py-2 text-[11px] font-medium text-slate-400 uppercase">Matchup</th>
                <th className="text-left px-3 py-2 text-[11px] font-medium text-slate-400 uppercase">Pick</th>
                <th className="text-left px-3 py-2 text-[11px] font-medium text-slate-400 uppercase">Result</th>
                <th className="text-right px-3 py-2 text-[11px] font-medium text-slate-400 uppercase hidden sm:table-cell">CLV</th>
                <th className="text-right px-3 py-2 text-[11px] font-medium text-slate-400 uppercase hidden md:table-cell">Brier</th>
                <th className="text-right px-3 py-2 text-[11px] font-medium text-slate-400 uppercase hidden md:table-cell">ROI</th>
                <th className="text-left px-3 py-2 text-[11px] font-medium text-slate-400 uppercase hidden lg:table-cell">Lesson</th>
              </tr>
            </thead>
            <tbody>
              {MOCK_MEMORY.map((row, i) => (
                <tr key={i} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                  <td className="px-3 py-2.5 text-xs text-slate-400">{row.date}</td>
                  <td className="px-3 py-2.5 text-xs text-white font-medium">{row.matchup}</td>
                  <td className="px-3 py-2.5 text-xs text-white">{row.pick}</td>
                  <td className="px-3 py-2.5">
                    {row.result === 'win'
                      ? <span className="inline-flex items-center gap-1 text-xs text-accent-green"><CheckCircle className="h-3 w-3" />Win</span>
                      : <span className="inline-flex items-center gap-1 text-xs text-accent-red"><XCircle className="h-3 w-3" />Loss</span>
                    }
                  </td>
                  <td className="px-3 py-2.5 text-right text-xs hidden sm:table-cell">
                    <span className={row.closingMove.startsWith('+') ? 'text-accent-green' : row.closingMove.startsWith('-') ? 'text-accent-red' : 'text-slate-400'}>{row.closingMove}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right text-xs text-slate-300 hidden md:table-cell">{row.brier.toFixed(2)}</td>
                  <td className="px-3 py-2.5 text-right text-xs hidden md:table-cell">
                    <span className={row.roi.startsWith('+') ? 'text-accent-green' : 'text-accent-red'}>{row.roi}</span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-400 max-w-[200px] truncate hidden lg:table-cell">{row.lesson}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
