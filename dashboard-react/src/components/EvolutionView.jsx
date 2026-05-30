import { useState } from 'react';
import { Activity, BookOpen, GitBranch, ShieldCheck, ChevronDown, ChevronUp } from 'lucide-react';
import PredictionBadge from './PredictionBadge.jsx';
import SummaryCard from './SummaryCard.jsx';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';

function text(value, fallback = '-') {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value)) return value.filter(Boolean).join(', ') || fallback;
  return String(value);
}

function statusTone(status) {
  const value = String(status || '').toLowerCase();
  if (value.includes('approved') || value.includes('active')) return 'green';
  if (value.includes('rejected')) return 'red';
  if (value.includes('pending') || value.includes('candidate')) return 'yellow';
  return 'gray';
}

function Section({ title, children }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function EmptyRow({ colSpan = 6 }) {
  return (
    <tr>
      <td className="px-3 py-4 text-sm text-ink/50" colSpan={colSpan}>No records yet.</td>
    </tr>
  );
}

function asList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map((item) => typeof item === 'string' ? item : text(item.description || item.text || item.reason || JSON.stringify(item)));
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${text(item)}`);
  return [String(value)];
}

function compactObjectRows(value, keys) {
  if (!value || typeof value !== 'object') return [];
  return keys.map(([label, key]) => [label, value[key]]).filter(([, item]) => item !== undefined && item !== null && item !== '');
}

function DetailBlock({ title, children }) {
  return (
    <div className="rounded-md border-2 border-ink bg-paper p-3 shadow-neo-sm">
      <p className="text-[10px] font-black uppercase text-ink/50">{title}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function KeyValueGrid({ rows, empty = 'No detail stored.' }) {
  const cleanRows = rows.filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!cleanRows.length) return <p className="text-xs font-semibold text-ink/50">{empty}</p>;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {cleanRows.map(([label, value]) => (
        <div key={label} className="rounded border-2 border-ink bg-cream px-2 py-1.5">
          <p className="text-[10px] font-black uppercase text-ink/50">{label}</p>
          <p className="text-xs font-black text-ink">{text(value)}</p>
        </div>
      ))}
    </div>
  );
}

function DetailList({ items, empty = 'Nothing flagged.' }) {
  const list = asList(items);
  if (!list.length) return <p className="text-xs font-semibold text-ink/50">{empty}</p>;
  return (
    <ul className="space-y-1 text-xs font-semibold text-ink/70">
      {list.slice(0, 8).map((item, index) => <li key={`${item}-${index}`}>• {item}</li>)}
    </ul>
  );
}

function TrajectoryDetails({ row }) {
  const prediction = row.prediction || {};
  const input = row.input_snapshot || row.input_data_snapshot || {};
  const dataQuality = input.data_quality || row.data_quality || {};
  const moneyline = prediction.moneyline || row.moneyline || {};
  const totals = prediction.totals || row.totals || {};
  const yrfi = prediction.yrfi || prediction.first_inning || row.first_inning || {};
  const modelBreakdown = row.model_breakdown || prediction.model_breakdown;
  const betDecision = row.bet_decision || prediction.bet_decision;
  const valuePick = row.value_pick || prediction.value_pick;
  const marketRows = [
    ...compactObjectRows(moneyline, [['ML Model Prob', 'model_probability'], ['Home Prob', 'home_probability'], ['Away Prob', 'away_probability'], ['Edge', 'edge'], ['Odds', 'current_odds']]),
    ...compactObjectRows(totals, [['Projected Total', 'projected_total'], ['Market Total', 'market_total'], ['Lean', 'lean'], ['Over Prob', 'over_probability'], ['Under Prob', 'under_probability'], ['Edge', 'edge']]),
    ...compactObjectRows(yrfi, [['Pick', 'pick'], ['Probability', 'probability'], ['YRFI Prob', 'yrfi_probability'], ['Edge', 'edge']]),
  ];
  const qualityRows = typeof dataQuality === 'object'
    ? compactObjectRows(dataQuality, [['Score', 'score'], ['Tier', 'tier'], ['Pitchers', 'probable_pitchers'], ['Lineup', 'lineup'], ['Weather', 'weather'], ['Odds', 'odds'], ['Bullpen', 'bullpen_usage'], ['Park', 'park_factor']])
    : [['Data Quality', dataQuality]];
  return (
    <div className="mt-2 grid gap-3 lg:grid-cols-2">
      <DetailBlock title="Prediction Snapshot">
        <KeyValueGrid rows={[
          ['Matchup', row.matchup],
          ['Date', row.date || row.timestamp],
          ['Market', row.market],
          ['Final Lean', prediction.final_lean || prediction.lean || row.final_lean],
          ['Confidence', prediction.confidence || row.confidence],
          ['No Bet', row.no_bet_reason || prediction.no_bet_reason],
        ]} />
      </DetailBlock>
      <DetailBlock title="Market / Model Detail">
        <KeyValueGrid rows={marketRows} empty="No market detail stored for this trajectory." />
      </DetailBlock>
      <DetailBlock title="Why">
        <DetailList items={row.main_factors || prediction.main_factors || modelBreakdown || valuePick || betDecision} empty="No factor explanation stored." />
      </DetailBlock>
      <DetailBlock title="Risks / No Bet">
        <DetailList items={row.risk_factors || prediction.risk_factors || row.no_bet_reason || prediction.no_bet_reason} empty="No risk note stored." />
      </DetailBlock>
      <DetailBlock title="Data Quality">
        <KeyValueGrid rows={[
          ...qualityRows,
          ['Lineup Status', input.lineup_status],
          ['Weather Status', input.weather_status],
          ['Odds Status', input.odds_status],
          ['Pitcher Status', input.probable_pitcher_status],
        ]} />
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <DetailList items={dataQuality.missing_fields} empty="No missing fields listed." />
          <DetailList items={dataQuality.stale_fields} empty="No stale fields listed." />
        </div>
      </DetailBlock>
      <DetailBlock title="Tools & Versions">
        <KeyValueGrid rows={[
          ['Tools', asList(row.tool_usage).join(', ')],
          ['Prompt', row.prompt_version],
          ['Rules', row.rule_version],
          ['Weights', row.weight_version],
          ['Model', row.model_version],
        ]} />
      </DetailBlock>
    </div>
  );
}

function Trajectories({ rows }) {
  const [expandedRow, setExpandedRow] = useState(null);

  return (
    <Section title="Recent Trajectories">
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-xs uppercase text-ink/50">
            <tr>
              <th className="px-3 py-2">Game</th>
              <th className="px-3 py-2">Market</th>
              <th className="px-3 py-2">Lean</th>
              <th className="px-3 py-2">Confidence</th>
              <th className="px-3 py-2">Versions</th>
              <th className="px-3 py-2">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink">
            {rows?.length ? rows.map((row) => {
              const rowKey = `${row.game_id}-${row.timestamp}`;
              const isExpanded = expandedRow === rowKey;
              return (
                <tr key={rowKey} className={isExpanded ? 'bg-cream' : ''}>
                  <td className="px-3 py-3 font-semibold text-ink">{text(row.matchup)}</td>
                  <td className="px-3 py-3">{text(row.market)}</td>
                  <td className="px-3 py-3">{text(row.prediction?.final_lean || row.prediction?.lean)}</td>
                  <td className="px-3 py-3"><PredictionBadge>{text(row.prediction?.confidence)}</PredictionBadge></td>
                  <td className="px-3 py-3 text-xs text-ink/50">{text(row.prompt_version)} / {text(row.weight_version)}</td>
                  <td className="px-3 py-3">
                    <button
                      type="button"
                      onClick={() => setExpandedRow(isExpanded ? null : rowKey)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-accent-blue hover:text-accent-blue/80 transition-colors cursor-pointer"
                    >
                      {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      {isExpanded ? 'Hide' : 'Details'}
                    </button>
                  </td>
                </tr>
              );
            }) : <EmptyRow />}
          </tbody>
        </table>
        {expandedRow && rows?.length > 0 && (() => {
          const row = rows.find((r) => `${r.game_id}-${r.timestamp}` === expandedRow);
          if (!row) return null;
          return (
            <div className="mt-2 rounded-md border-2 border-ink bg-cream p-4 shadow-neo-sm">
              <p className="mb-2 text-xs font-black uppercase text-ink/70">Trajectory Details — {text(row.matchup)}</p>
              <TrajectoryDetails row={row} />
            </div>
          );
        })()}
      </div>
    </Section>
  );
}

function Lessons({ rows }) {
  return (
    <Section title="Recent Lessons">
      <div className="grid gap-3 md:grid-cols-2">
        {rows?.length ? rows.map((row) => (
          <div key={row.lesson_id} className="rounded-md border border-line p-4">
            <div className="flex flex-wrap items-center gap-2">
              <PredictionBadge tone={row.result === 'win' ? 'green' : row.result === 'loss' ? 'red' : 'gray'}>{text(row.result)}</PredictionBadge>
              <span className="text-xs font-semibold uppercase text-ink/50">{text(row.market)}</span>
              <span className="text-xs text-ink/60">{text(row.lesson_type)}</span>
            </div>
            <p className="mt-3 text-sm font-semibold text-ink">{text(row.game_id)}</p>
            <p className="mt-2 text-sm text-ink/70">{text(row.summary)}</p>
            <p className="mt-2 text-xs text-ink/50">{text(row.suggested_adjustment)}</p>
          </div>
        )) : <p className="text-sm text-ink/50">No lessons yet.</p>}
      </div>
    </Section>
  );
}

function Losses({ rows }) {
  return (
    <Section title="Language Losses">
      <div className="space-y-3">
        {rows?.length ? rows.map((row) => (
          <div key={row.loss_id} className="flex flex-col gap-2 rounded-md border border-line p-4 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-sm font-semibold text-ink">{text(row.loss_summary)}</p>
              <p className="mt-1 text-xs text-ink/50">{text(row.market)} / {text(row.affected_factor)}</p>
            </div>
            <PredictionBadge tone={statusTone(row.severity)}>{text(row.severity)}</PredictionBadge>
          </div>
        )) : <p className="text-sm text-ink/50">No language losses yet.</p>}
      </div>
    </Section>
  );
}

function Gradients({ rows }) {
  return (
    <Section title="Language Gradients">
      <div className="space-y-3">
        {rows?.length ? rows.map((row) => (
          <div key={row.gradient_id} className="rounded-md border border-line p-4">
            <p className="text-xs font-semibold uppercase text-blue-700">{text(row.target)}</p>
            <p className="mt-2 text-sm font-semibold text-ink">{text(row.gradient)}</p>
            <p className="mt-2 text-xs text-ink/50">{text(row.reason)}</p>
          </div>
        )) : <p className="text-sm text-ink/50">No gradients yet.</p>}
      </div>
    </Section>
  );
}

function Candidates({ rows }) {
  return (
    <Section title="Symbolic Update Candidates">
      <div className="space-y-3">
        {rows?.length ? rows.map((row) => (
          <div key={row.candidate_id} className="rounded-md border border-line p-4">
            <div className="flex flex-wrap items-center gap-2">
              <PredictionBadge tone={statusTone(row.promotion_status || row.status)}>{text(row.promotion_status || row.status)}</PredictionBadge>
              <span className="text-xs font-semibold uppercase text-ink/50">{text(row.type)}</span>
            </div>
            <p className="mt-2 text-sm font-semibold text-ink">{text(row.update || row.rule)}</p>
            <p className="mt-2 text-xs text-ink/50">Backtest: {text(row.backtest_status)} / Sources: {text(row.source_losses)}</p>
          </div>
        )) : <p className="text-sm text-ink/50">No candidates yet.</p>}
      </div>
    </Section>
  );
}

function ApprovedChanges({ rows }) {
  return (
    <Section title="Approved Changes">
      <div className="space-y-3">
        {rows?.length ? rows.map((row, index) => (
          <div key={`${row.date}-${index}`} className="rounded-md border border-line p-4">
            <div className="flex flex-wrap items-center gap-2">
              <PredictionBadge tone="green">{text(row.decision?.status, 'approved')}</PredictionBadge>
              <span className="text-xs text-ink/50">{text(row.date)}</span>
            </div>
            <p className="mt-2 text-sm font-semibold text-ink">{text(row.candidate?.update || row.candidate?.rule || row.candidate?.candidate_id)}</p>
            <p className="mt-2 text-xs text-ink/50">Rollback supported: {row.rollback_supported ? 'yes' : 'no'}</p>
          </div>
        )) : <p className="text-sm text-ink/50">No approved changes yet.</p>}
      </div>
    </Section>
  );
}

function RiskWarnings({ rows }) {
  return (
    <Section title="Risk Warnings">
      <div className="space-y-3">
        {rows?.length ? rows.map((row) => (
          <div key={`${row.pattern}-${row.note}`} className="rounded-md border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">{text(row.pattern)}</p>
            <p className="mt-1 text-sm text-amber-800">{text(row.note)}</p>
          </div>
        )) : <p className="text-sm text-ink/50">No repeated weakness patterns detected yet.</p>}
      </div>
    </Section>
  );
}

function AuditDiagnostics({ audit }) {
  const summary = audit?.summary || {};
  const weakest = audit?.weakest_segments || [];
  const causes = audit?.root_causes || [];
  const recommendations = audit?.priority_recommendations || [];
  const candidates = audit?.candidate_priorities || [];

  return (
    <Section title="Audit Diagnostics">
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase text-ink/50">Snapshot</p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <span>Evaluated: {summary.evaluated || 0}</span>
            <span>Accuracy: {summary.accuracy || 0}%</span>
            <span>Record: {summary.wins || 0}-{summary.losses || 0}</span>
            <span>No Bet: {summary.no_bets || 0}</span>
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase text-ink/50">Candidate Priority</p>
          <div className="mt-2 space-y-2">
            {candidates.length ? candidates.slice(0, 3).map((row) => (
              <p key={row.candidate_id} className="text-sm text-ink/70">
                <span className="font-semibold text-ink">{text(row.type)}</span> score {text(row.priority_score)} / {text(row.backtest_status)}
              </p>
            )) : <p className="text-sm text-ink/50">No prioritized candidates yet.</p>}
          </div>
        </div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div>
          <p className="text-xs font-semibold uppercase text-ink/50">Weakest Segments</p>
          <div className="mt-2 space-y-2">
            {weakest.length ? weakest.slice(0, 4).map((row) => (
              <p key={row.segment} className="text-sm text-ink/70">
                <span className="font-semibold text-ink">{text(row.segment)}</span>: {row.wins || 0}-{row.losses || 0}, {row.loss_rate || 0}% loss
              </p>
            )) : <p className="text-sm text-ink/50">Not enough segment sample yet.</p>}
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase text-ink/50">Root Causes</p>
          <div className="mt-2 space-y-2">
            {causes.length ? causes.slice(0, 4).map((row) => (
              <p key={row.loss_type} className="text-sm text-ink/70">
                <span className="font-semibold text-ink">{text(row.loss_type)}</span>: {row.count || 0}x / {text(row.primary_factor)}
              </p>
            )) : <p className="text-sm text-ink/50">No language losses yet.</p>}
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase text-ink/50">Top Fixes</p>
          <div className="mt-2 space-y-2">
            {recommendations.length ? recommendations.slice(0, 3).map((row) => (
              <p key={row.recommendation} className="text-sm text-ink/70">{text(row.recommendation)}</p>
            )) : <p className="text-sm text-ink/50">Run /evolve after settled games to build fixes.</p>}
          </div>
        </div>
      </div>
    </Section>
  );
}

export default function EvolutionView({ evolution }) {
  const summary = evolution?.summary || {};
  const candidates = [
    ...(evolution?.symbolic_update_candidates || []),
    ...(evolution?.rule_candidates || []),
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard label="Evaluated" value={summary.total_predictions_evaluated || 0} helper="settled predictions" icon={Activity} />
        <SummaryCard label="Lessons" value={summary.lessons_generated || 0} helper={`${summary.language_losses_generated || 0} losses`} icon={BookOpen} />
        <SummaryCard label="Candidates" value={summary.candidates_proposed || 0} helper={`${summary.candidates_approved || 0} approved`} icon={GitBranch} />
        <SummaryCard label="Active Versions" value={text(summary.current_rule_version)} helper={`${text(summary.current_prompt_version)} / ${text(summary.current_weight_version)}`} icon={ShieldCheck} />
      </div>
      <Trajectories rows={evolution?.recent_trajectories || []} />
      <Lessons rows={evolution?.recent_lessons || []} />
      <Losses rows={evolution?.language_losses || []} />
      <Gradients rows={evolution?.language_gradients || []} />
      <Candidates rows={candidates} />
      <AuditDiagnostics audit={evolution?.audit} />
      <ApprovedChanges rows={evolution?.approved_changes || []} />
      <RiskWarnings rows={evolution?.risk_warnings || []} />
    </div>
  );
}
