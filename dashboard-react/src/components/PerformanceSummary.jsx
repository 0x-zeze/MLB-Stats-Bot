import { number, percent } from '../utils.js';

function Metric({ label, value }) {
  return (
    <div className="rounded-lg border border-line bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-ink">{value}</p>
    </div>
  );
}

function SmallTable({ title, rows, columns }) {
  return (
    <section className="rounded-lg border border-line bg-white p-4">
      <h3 className="mb-3 text-sm font-bold text-ink">{title}</h3>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-500">
            <tr>{columns.map((column) => <th key={column.key} className="py-2 pr-4">{column.label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-t border-line">
                {columns.map((column) => <td key={column.key} className="py-2 pr-4">{column.render ? column.render(row[column.key], row) : row[column.key]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function PerformanceSummary({ performance }) {
  const overall = performance?.overall || {};
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Bets Taken" value={overall.bets_taken || 0} />
        <Metric label="Win Rate" value={percent(overall.win_rate)} />
        <Metric label="ROI" value={percent(overall.roi)} />
        <Metric label="Average Edge" value={percent(overall.average_edge)} />
        <Metric label="Average CLV" value={number(overall.average_clv, 2)} />
        <Metric label="Brier Score" value={number(overall.brier_score, 3)} />
        <Metric label="Log Loss" value={number(overall.log_loss, 3)} />
        <Metric label="CLV Hit Rate" value={percent(overall.clv_hit_rate)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <SmallTable
          title="Performance by Market"
          rows={performance?.by_market || []}
          columns={[
            { key: 'market', label: 'Market' },
            { key: 'bets', label: 'Bets' },
            { key: 'win_rate', label: 'Win Rate', render: percent },
            { key: 'roi', label: 'ROI', render: percent },
          ]}
        />
        <SmallTable
          title="Performance by Total Range"
          rows={performance?.by_total_range || []}
          columns={[
            { key: 'range', label: 'Range' },
            { key: 'bets', label: 'Bets' },
            { key: 'win_rate', label: 'Win Rate', render: percent },
            { key: 'roi', label: 'ROI', render: percent },
          ]}
        />
      </div>
      <SmallTable
        title="Calibration"
        rows={performance?.calibration || []}
        columns={[
          { key: 'bucket', label: 'Bucket' },
          { key: 'predictions', label: 'Predictions' },
          { key: 'expected', label: 'Expected', render: percent },
          { key: 'actual', label: 'Actual', render: percent },
        ]}
      />
    </div>
  );
}
