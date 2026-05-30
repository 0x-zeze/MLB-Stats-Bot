import { useEffect, useState, useCallback } from 'react';
import { Play, ShieldCheck, Loader2, CheckCircle, XCircle, History } from 'lucide-react';
import { api } from '../api.js';
import HistoryTable from './HistoryTable.jsx';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';

function parseOutput(result) {
  if (!result) return {};
  if (result.ingest || result.summary || result.weakest_segments || result.applied_updates) return result;
  if (typeof result.output === 'string') {
    try {
      return JSON.parse(result.output);
    } catch {
      return {};
    }
  }
  return {};
}

function metricValue(value, fallback = 0) {
  return value === undefined || value === null || value === '' ? fallback : value;
}

function MetricPill({ label, value }) {
  return (
    <div className="rounded-md border-2 border-ink bg-paper px-3 py-2 shadow-neo-sm">
      <p className="text-[10px] font-black uppercase text-ink/50">{label}</p>
      <p className="mt-1 text-sm font-black text-ink">{metricValue(value)}</p>
    </div>
  );
}

function Note({ children }) {
  if (!children) return null;
  return <p className="rounded-md border-2 border-ink bg-accent-yellow px-3 py-2 text-xs font-semibold text-ink shadow-neo-sm">{children}</p>;
}

function ResultError({ result }) {
  const message = result?.detail || result?.output || 'Operation failed.';
  return <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] opacity-80">{message}</pre>;
}

function EvolveSummary({ result }) {
  const payload = parseOutput(result);
  const ingest = payload.ingest || {};
  const summary = payload.summary || {};
  const backtest = payload.backtest || {};
  return (
    <div className="mt-3 space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MetricPill label="Evaluated" value={ingest.evaluated || summary.total_predictions_evaluated} />
        <MetricPill label="Skipped Dupes" value={ingest.skipped_duplicates} />
        <MetricPill label="Lessons" value={ingest.lessons || summary.lessons_generated} />
        <MetricPill label="Losses" value={ingest.language_losses || summary.language_losses_generated} />
        <MetricPill label="Gradients" value={ingest.language_gradients || summary.language_gradients_generated} />
        <MetricPill label="Symbolic" value={payload.symbolic_candidates} />
        <MetricPill label="Rules" value={payload.rule_candidates} />
        <MetricPill label="Backtested" value={backtest.processed} />
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <MetricPill label="Approved" value={backtest.approved || summary.candidates_approved} />
        <MetricPill label="Rejected" value={backtest.rejected || summary.candidates_rejected} />
        <MetricPill label="Buckets" value={(payload.miscalibrated_buckets || []).length} />
      </div>
      <Note>{backtest.reason}</Note>
      <Note>{payload.safety}</Note>
      <p className="text-[11px] font-black uppercase text-ink/60">
        Versions: {summary.current_prompt_version || '-'} / {summary.current_rule_version || '-'} / {summary.current_weight_version || '-'}
      </p>
    </div>
  );
}

function AuditSummary({ result }) {
  const payload = parseOutput(result);
  const summary = payload.summary || {};
  const updates = payload.applied_updates || {};
  const memory = payload.memory_update || {};
  const recommendations = payload.priority_recommendations || [];
  const weakest = payload.weakest_segments || [];
  const accuracy = summary.accuracy != null ? `${Number(summary.accuracy).toFixed(1)}%` : '-';
  return (
    <div className="mt-3 space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MetricPill label="Evaluated" value={summary.evaluated} />
        <MetricPill label="Record" value={`${summary.wins || 0}-${summary.losses || 0}`} />
        <MetricPill label="Accuracy" value={accuracy} />
        <MetricPill label="No Bets" value={summary.no_bets} />
        <MetricPill label="Candidates" value={summary.candidates} />
        <MetricPill label="Approved" value={summary.approved} />
        <MetricPill label="Rules Added" value={(updates.rules_added || []).length} />
        <MetricPill label="Patterns" value={memory.patterns_written} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-md border-2 border-ink bg-paper p-3 shadow-neo-sm">
          <p className="text-[10px] font-black uppercase text-ink/50">Weakest Segments</p>
          {weakest.length ? weakest.slice(0, 3).map((row) => (
            <p key={row.segment} className="mt-1 text-xs font-semibold text-ink/70">{row.segment}: {row.wins || 0}-{row.losses || 0}, {row.loss_rate || 0}% loss</p>
          )) : <p className="mt-1 text-xs font-semibold text-ink/50">No weak segment flagged.</p>}
        </div>
        <div className="rounded-md border-2 border-ink bg-paper p-3 shadow-neo-sm">
          <p className="text-[10px] font-black uppercase text-ink/50">Top Recommendations</p>
          {recommendations.length ? recommendations.slice(0, 3).map((row) => (
            <p key={row.recommendation} className="mt-1 text-xs font-semibold text-ink/70">{row.recommendation}</p>
          )) : <p className="mt-1 text-xs font-semibold text-ink/50">No priority recommendation.</p>}
        </div>
      </div>
      <Note>{updates.note || payload.safety}</Note>
    </div>
  );
}

export default function HistorySection() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [evolving, setEvolving] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [evolveResult, setEvolveResult] = useState(null);
  const [auditResult, setAuditResult] = useState(null);

  const fetchHistory = useCallback(() => {
    setLoading(true);
    api.history()
      .then((data) => setRows(data?.rows || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  async function handleEvolve() {
    setEvolving(true);
    setEvolveResult(null);
    try {
      const result = await api.evolve();
      setEvolveResult(result);
    } catch (err) {
      setEvolveResult({ status: 'error', detail: err.message });
    } finally {
      setEvolving(false);
    }
  }

  async function handleAudit() {
    setAuditing(true);
    setAuditResult(null);
    try {
      const result = await api.audit();
      setAuditResult(result);
    } catch (err) {
      setAuditResult({ status: 'error', detail: err.message });
    } finally {
      setAuditing(false);
    }
  }

  const wins = rows.filter((r) => r.result === 'Win').length;
  const losses = rows.filter((r) => r.result === 'Loss').length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <History className="h-5 w-5 text-accent-blue" />
            <div>
              <CardTitle>Prediction History</CardTitle>
              <p className="mt-1 text-xs font-semibold text-ink/70">Real prediction data from the bot. Run evolve/audit to improve the model.</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {rows.length > 0 && (
              <div className="flex items-center gap-2 text-xs mr-2">
                <span className="text-accent-green font-semibold">{wins}W</span>
                <span className="text-accent-red font-semibold">{losses}L</span>
                <span className="font-black text-ink/60">{rows.length} total</span>
              </div>
            )}
            <button
              onClick={handleEvolve}
              disabled={evolving || auditing}
              className="inline-flex items-center gap-1.5 rounded-lg border-2 border-ink bg-accent-blue px-3 py-1.5 text-xs font-black uppercase text-ink shadow-neo-sm transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-accent-yellow disabled:cursor-not-allowed disabled:opacity-50"
            >
              {evolving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              {evolving ? 'Running...' : 'Evolve'}
            </button>
            <button
              onClick={handleAudit}
              disabled={evolving || auditing}
              className="inline-flex items-center gap-1.5 rounded-lg border-2 border-ink bg-accent-green px-3 py-1.5 text-xs font-black uppercase text-ink shadow-neo-sm transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-accent-yellow disabled:cursor-not-allowed disabled:opacity-50"
            >
              {auditing ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
              {auditing ? 'Running...' : 'Audit'}
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {evolveResult && (
          <div className={`mb-4 flex items-start gap-2 rounded-lg border-2 px-3 py-2 shadow-neo-sm text-xs ${
            evolveResult.status === 'ok'
              ? 'border-ink bg-accent-green text-ink'
              : 'border-ink bg-accent-red text-ink'
          }`}>
            {evolveResult.status === 'ok' ? <CheckCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /> : <XCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />}
            <div className="min-w-0">
              <p className="font-black uppercase">{evolveResult.status === 'ok' ? 'Evolution cycle complete' : 'Evolution failed'}</p>
              {evolveResult.status === 'ok' ? <EvolveSummary result={evolveResult} /> : <ResultError result={evolveResult} />}
            </div>
          </div>
        )}
        {auditResult && (
          <div className={`mb-4 flex items-start gap-2 rounded-lg border-2 px-3 py-2 shadow-neo-sm text-xs ${
            auditResult.status === 'ok'
              ? 'border-ink bg-accent-green text-ink'
              : 'border-ink bg-accent-red text-ink'
          }`}>
            {auditResult.status === 'ok' ? <CheckCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /> : <XCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />}
            <div className="min-w-0">
              <p className="font-black uppercase">{auditResult.status === 'ok' ? 'Audit complete — safe guardrails applied' : 'Audit failed'}</p>
              {auditResult.status === 'ok' ? <AuditSummary result={auditResult} /> : <ResultError result={auditResult} />}
            </div>
          </div>
        )}

        {loading ? (
          <p className="py-8 text-center text-sm font-black uppercase text-ink/60">Loading prediction history...</p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm font-black uppercase text-ink/60">No prediction history yet. Predictions will appear here after games are processed.</p>
        ) : (
          <HistoryTable rows={rows} />
        )}
      </CardContent>
    </Card>
  );
}
