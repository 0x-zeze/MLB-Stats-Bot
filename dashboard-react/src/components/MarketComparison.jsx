import EdgeIndicator from './EdgeIndicator.jsx';
import { percent } from '../utils.js';

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-sm font-semibold text-ink">{children}</span>
    </div>
  );
}

export default function MarketComparison({ game }) {
  const moneyline = game.moneyline || {};
  return (
    <div className="grid gap-3">
      <section className="rounded-lg border border-line bg-white p-4">
        <h4 className="mb-2 text-sm font-bold text-ink">Moneyline Market</h4>
        <Row label="Model probability">{percent(moneyline.model_probability)}</Row>
        <Row label="Market implied">{percent(moneyline.market_implied_probability)}</Row>
        <Row label="Difference / edge"><EdgeIndicator value={moneyline.edge} /></Row>
        <Row label="Current odds">{moneyline.current_odds || 'Unavailable'}</Row>
      </section>

    </div>
  );
}
