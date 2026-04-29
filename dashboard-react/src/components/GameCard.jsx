import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/utils.js';
import { number, percent } from '../utils.js';
import ConfidenceBadge from './ConfidenceBadge.jsx';
import DataQualityPanel from './DataQualityPanel.jsx';
import EdgeIndicator from './EdgeIndicator.jsx';
import MarketComparison from './MarketComparison.jsx';
import NoBetReason from './NoBetReason.jsx';
import PredictionBadge from './PredictionBadge.jsx';
import RiskFactors from './RiskFactors.jsx';
import DataQualityBadge from './DataQualityBadge.jsx';
import { Button } from './ui/button.jsx';
import { Card, CardContent } from './ui/card.jsx';

function decisionTone(decision) {
  if (decision === 'BET') return 'border-emerald-200 bg-emerald-50/60';
  if (decision === 'LEAN') return 'border-amber-200 bg-amber-50/50';
  return 'border-slate-200 bg-slate-50';
}

function Stat({ label, value, helper }) {
  return (
    <div className="min-w-0 rounded-md bg-slate-50 px-3 py-2">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 truncate text-sm font-bold text-ink">{value}</p>
      {helper ? <p className="mt-1 truncate text-xs text-slate-500">{helper}</p> : null}
    </div>
  );
}

export default function GameCard({ game }) {
  const [open, setOpen] = useState(false);
  const moneyline = game.moneyline || {};
  const totals = game.totals || {};
  const modelProbability = moneyline.model_probability || Math.max(Number(moneyline.away_probability) || 0, Number(moneyline.home_probability) || 0);
  const edge = Math.max(Math.abs(Number(moneyline.edge) || 0), Math.abs(Number(totals.edge) || 0));
  const quality = Number(game.data_quality?.score) || 0;
  return (
    <Card className="border-slate-200 shadow-none">
      <CardContent className="p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <PredictionBadge>{game.decision}</PredictionBadge>
              <ConfidenceBadge value={moneyline.confidence} />
              <DataQualityBadge score={quality} />
            </div>
            <h3 className="text-lg font-bold leading-tight text-ink">{game.away_team} @ {game.home_team}</h3>
            <p className="mt-1 text-sm text-slate-500">{game.game_time} | {game.ballpark}</p>
          </div>
          <div className={cn('rounded-md border px-4 py-3 lg:min-w-56', decisionTone(game.decision))}>
            <p className="text-xs font-semibold text-slate-500">Decision</p>
            <p className="mt-1 text-base font-bold text-ink">{game.decision} - {game.final_lean}</p>
          </div>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Model Prob" value={percent(modelProbability)} helper={`${game.away_team}: ${percent(moneyline.away_probability)} | ${game.home_team}: ${percent(moneyline.home_probability)}`} />
          <Stat label="Edge" value={<EdgeIndicator value={edge} />} helper="largest edge" />
          <Stat label="Total" value={totals.lean || '-'} helper={`Projected ${number(totals.projected_total)} / Market ${number(totals.market_total)}`} />
          <Stat label="Quality" value={`${quality}/100`} helper={game.freshness_status || game.status} />
        </div>

        <NoBetReason reason={game.no_bet_reason} />

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-500">{(game.main_factors || [])[0] || 'No major model note'}</p>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            {open ? 'Hide details' : 'Details'}
          </Button>
        </div>

        {open ? (
          <div className="mt-4 space-y-4 border-t border-slate-100 pt-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-md bg-slate-50 p-3">
                <p className="text-xs font-semibold text-slate-500">Pitchers</p>
                <p className="mt-2 text-sm text-ink">{game.probable_pitchers?.away}</p>
                <p className="text-sm text-ink">{game.probable_pitchers?.home}</p>
                <div className="mt-2"><PredictionBadge>{game.probable_pitchers?.status}</PredictionBadge></div>
              </div>
              <div className="rounded-md bg-slate-50 p-3">
                <p className="text-xs font-semibold text-slate-500">Status</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <PredictionBadge>{game.lineup_status}</PredictionBadge>
                  <PredictionBadge>{game.weather_status}</PredictionBadge>
                  <PredictionBadge>{game.odds_status}</PredictionBadge>
                </div>
                <p className="mt-2 text-sm text-slate-500">{game.weather_summary}</p>
              </div>
              <div className="rounded-md bg-slate-50 p-3">
                <p className="text-xs font-semibold text-slate-500">Risk</p>
                <p className="mt-2 text-2xl font-bold text-ink">{(game.risk_factors || []).length}</p>
                <p className="mt-1 text-sm text-slate-500">{(game.risk_factors || [])[0] || 'No major risk note'}</p>
              </div>
            </div>
            <RiskFactors title="Main Factors" items={game.main_factors} />
            <MarketComparison game={game} />
            <div className="grid gap-4 lg:grid-cols-2">
              <DataQualityPanel quality={game.data_quality} />
              <RiskFactors title="Risk Factors" items={game.risk_factors} />
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
