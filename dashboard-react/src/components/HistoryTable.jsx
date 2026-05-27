import PredictionBadge from './PredictionBadge.jsx';
import EdgeIndicator from './EdgeIndicator.jsx';
import { number, signed } from '../utils.js';

export default function HistoryTable({ rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b-3 border-ink bg-accent-yellow">
            {['Date', 'Matchup', 'Market', 'Prediction', 'Confidence', 'Prob', 'Edge', 'Close', 'Result', 'P/L', 'CLV'].map((label) => (
              <th key={label} className="px-3 py-2 text-left text-[11px] font-black uppercase text-ink">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y-2 divide-ink">
          {rows.map((row, index) => {
            const edgeVal = Number(row.edge);
            const plVal = Number(row.profit_loss);
            const clvVal = Number(row.clv);
            return (
              <tr key={`${row.date}-${row.matchup}-${index}`} className={`${index % 2 === 0 ? 'bg-paper' : 'bg-cream'} transition-colors hover:bg-accent-yellow`}>
                <td className="px-3 py-2.5 text-xs text-ink/60">{row.date || '-'}</td>
                <td className="px-3 py-2.5 text-xs text-ink font-medium">{row.matchup || '-'}</td>
                <td className="px-3 py-2.5 text-xs text-ink/70">{row.market_type || '-'}</td>
                <td className="px-3 py-2.5 text-xs text-ink">{row.prediction || '-'}</td>
                <td className="px-3 py-2.5"><PredictionBadge>{row.confidence}</PredictionBadge></td>
                <td className="px-3 py-2.5 text-xs text-ink/70">{row.model_probability != null ? `${Number(row.model_probability).toFixed(1)}%` : '-'}</td>
                <td className="px-3 py-2.5">
                  <EdgeIndicator value={row.edge} />
                </td>
                <td className="px-3 py-2.5 text-xs text-ink/70">{row.closing_line || '-'}</td>
                <td className="px-3 py-2.5"><PredictionBadge>{row.result}</PredictionBadge></td>
                <td className={`px-3 py-2.5 text-xs font-semibold ${plVal > 0 ? 'text-accent-green' : plVal < 0 ? 'text-accent-red' : 'text-ink/60'}`}>
                  {Number.isFinite(plVal) ? signed(plVal, '', 2) : '-'}
                </td>
                <td className={`px-3 py-2.5 text-xs ${clvVal > 0 ? 'text-accent-green' : clvVal < 0 ? 'text-accent-red' : 'text-ink/60'}`}>
                  {Number.isFinite(clvVal) ? number(clvVal, 2) : '-'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
