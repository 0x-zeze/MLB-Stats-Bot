import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { number, percent } from '../utils.js';
import DataQualityBadge from './DataQualityBadge.jsx';
import EdgeIndicator from './EdgeIndicator.jsx';
import MarketComparison from './MarketComparison.jsx';
import NoBetReason from './NoBetReason.jsx';
import PredictionBadge from './PredictionBadge.jsx';
import RiskFactors from './RiskFactors.jsx';

function DetailRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-right text-sm font-semibold text-ink">{value || '-'}</span>
    </div>
  );
}

function DataQualityPanel({ quality }) {
  const issues = [...(quality?.issues || []), ...(quality?.stale_fields || [])];
  return (
    <div className="mt-4 rounded-lg border border-line bg-slate-50 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h4 className="text-sm font-bold text-ink">Data Quality Report</h4>
        <DataQualityBadge score={quality?.score || 0} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <DetailRow label="Probable pitchers" value={quality?.probable_pitchers} />
          <DetailRow label="Lineup" value={quality?.lineup} />
          <DetailRow label="Weather" value={quality?.weather} />
          <DetailRow label="Odds" value={quality?.odds} />
        </div>
        <div>
          <DetailRow label="Bullpen usage" value={quality?.bullpen_usage} />
          <DetailRow label="Park factor" value={quality?.park_factor} />
          <DetailRow label="Injury/news" value={quality?.injury_news} />
          <DetailRow label="Market movement" value={quality?.market_movement} />
        </div>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <RiskFactors title="Issues" items={issues} />
        <RiskFactors title="Confidence Adjustments" items={quality?.confidence_adjustments} />
      </div>
    </div>
  );
}

export default function GameCard({ game }) {
  const [open, setOpen] = useState(false);
  const moneyline = game.moneyline || {};
  const totals = game.totals || {};
  return (
    <article className="rounded-lg border border-line bg-panel p-4 shadow-soft">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <PredictionBadge>{game.decision}</PredictionBadge>
            <PredictionBadge>{moneyline.confidence || 'Low Confidence'}</PredictionBadge>
            <DataQualityBadge score={game.data_quality?.score || 0} />
          </div>
          <h3 className="text-xl font-bold text-ink">{game.away_team} @ {game.home_team}</h3>
          <p className="mt-1 text-sm text-slate-500">{game.game_time} | {game.ballpark} | {game.status}</p>
        </div>
        <div className="min-w-48 rounded-lg bg-slate-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Final Decision</p>
          <p className="mt-1 text-lg font-bold text-ink">{game.decision} - {game.final_lean}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border border-line p-3">
          <p className="text-xs font-semibold uppercase text-slate-500">Probable Pitchers</p>
          <p className="mt-2 text-sm text-ink">{game.probable_pitchers?.away}</p>
          <p className="text-sm text-ink">{game.probable_pitchers?.home}</p>
          <div className="mt-2"><PredictionBadge>{game.probable_pitchers?.status}</PredictionBadge></div>
        </div>
        <div className="rounded-lg border border-line p-3">
          <p className="text-xs font-semibold uppercase text-slate-500">Statuses</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <PredictionBadge>{game.lineup_status}</PredictionBadge>
            <PredictionBadge>{game.weather_status}</PredictionBadge>
            <PredictionBadge>{game.odds_status}</PredictionBadge>
          </div>
          <p className="mt-2 text-sm text-slate-500">{game.weather_summary}</p>
        </div>
        <div className="rounded-lg border border-line p-3">
          <p className="text-xs font-semibold uppercase text-slate-500">Moneyline</p>
          <p className="mt-2 text-sm">{game.away_team}: <strong>{percent(moneyline.away_probability)}</strong></p>
          <p className="text-sm">{game.home_team}: <strong>{percent(moneyline.home_probability)}</strong></p>
          <p className="mt-2 text-sm">Edge: <EdgeIndicator value={moneyline.edge} /></p>
        </div>
        <div className="rounded-lg border border-line p-3">
          <p className="text-xs font-semibold uppercase text-slate-500">Total Runs</p>
          <p className="mt-2 text-sm">Projected: <strong>{number(totals.projected_total)}</strong></p>
          <p className="text-sm">Market: <strong>{number(totals.market_total)}</strong></p>
          <p className="text-sm">Lean: <strong>{totals.lean}</strong></p>
        </div>
      </div>

      <NoBetReason reason={game.no_bet_reason} />

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <RiskFactors title="Main Factors" items={game.main_factors} />
        <RiskFactors title="Risk Factors" items={game.risk_factors} />
      </div>

      <button
        type="button"
        className="mt-4 inline-flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm font-semibold text-ink hover:bg-slate-50"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        {open ? 'Hide details' : 'Show market and quality details'}
      </button>

      {open ? (
        <div className="mt-4 space-y-4">
          <MarketComparison game={game} />
          <DataQualityPanel quality={game.data_quality} />
        </div>
      ) : null}
    </article>
  );
}
