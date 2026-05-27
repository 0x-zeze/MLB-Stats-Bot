import { useEffect, useState, useCallback } from 'react';
import { Play, ShieldCheck, Loader2, CheckCircle, XCircle, History } from 'lucide-react';
import { api } from '../api.js';
import HistoryTable from './HistoryTable.jsx';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';

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
              <p className="font-semibold">{evolveResult.status === 'ok' ? 'Evolution cycle complete' : 'Evolution failed'}</p>
              {evolveResult.output && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] opacity-80">{evolveResult.output}</pre>}
              {evolveResult.detail && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] opacity-80">{evolveResult.detail}</pre>}
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
              <p className="font-semibold">{auditResult.status === 'ok' ? 'Audit complete — safe guardrails applied' : 'Audit failed'}</p>
              {auditResult.output && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] opacity-80">{auditResult.output}</pre>}
              {auditResult.detail && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] opacity-80">{auditResult.detail}</pre>}
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
