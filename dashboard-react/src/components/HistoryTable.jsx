import PredictionBadge from './PredictionBadge.jsx';
import EdgeIndicator from './EdgeIndicator.jsx';
import { isFiniteNum, number, signed } from '../utils.js';

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
            const hasPl = isFiniteNum(row.profit_loss);
            const hasClv = isFiniteNum(row.clv);
            const plVal = hasPl ? Number(row.profit_loss) : NaN;
            const clvVal = hasClv ? Number(row.clv) : NaN;
            return (
              <tr key={`${row.date}-${row.matchup}-${index}`} className={`${index % 2 === 0 ? 'bg-paper' : 'bg-cream'} transition-colors hover:bg-accent-yellow`}>
                <td className="px-3 py-2.5 text-xs text-ink/60">{row.date || '-'}</td>
                <td className="px-3 py-2.5 text-xs text-ink font-medium">{row.matchup || '-'}</td>
                <td className="px-3 py-2.5 text-xs text-ink/70">{row.market_type || '-'}</td>
                <td className="px-3 py-2.5 text-xs text-ink">{row.prediction || '-'}</td>
                <td className="px-3 py-2.5"><PredictionBadge>{row.confidence}</PredictionBadge></td>
                <td className="px-3 py-2.5 text-xs text-ink/70">{isFiniteNum(row.model_probability) ? `${Number(row.model_probability).toFixed(1)}%` : '-'}</td>
                <td className="px-3 py-2.5">
                  <EdgeIndicator value={row.edge} />
                </td>
                <td className="px-3 py-2.5 text-xs text-ink/70">{row.closing_line || '-'}</td>
                <td className="px-3 py-2.5"><PredictionBadge>{row.result}</PredictionBadge></td>
                <td className={`px-3 py-2.5 text-xs font-semibold ${hasPl && plVal > 0 ? 'text-accent-green' : hasPl && plVal < 0 ? 'text-accent-red' : 'text-ink/60'}`}>
                  {hasPl ? signed(plVal, '', 2) : '-'}
                </td>
                <td className={`px-3 py-2.5 text-xs ${hasClv && clvVal > 0 ? 'text-accent-green' : hasClv && clvVal < 0 ? 'text-accent-red' : 'text-ink/60'}`}>
                  {hasClv ? number(clvVal, 2) : '-'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
