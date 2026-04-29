import { Download, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, exportUrl } from './api.js';
import { lower, relativeTime } from './utils.js';
import BacktestTable from './components/BacktestTable.jsx';
import GameCard from './components/GameCard.jsx';
import HistoryTable from './components/HistoryTable.jsx';
import PerformanceSummary from './components/PerformanceSummary.jsx';
import PredictionBadge from './components/PredictionBadge.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';

const tabs = ['Today', 'History', 'Backtest', 'Performance', 'Settings'];
const filters = [
  ['all', 'All games'],
  ['BET', 'BET'],
  ['LEAN', 'LEAN'],
  ['NO BET', 'NO BET'],
  ['high_edge', 'High edge'],
  ['stale', 'Stale data'],
  ['pitchers', 'Confirmed pitchers'],
  ['lineups', 'Confirmed lineups'],
  ['totals', 'Totals only'],
  ['moneyline', 'Moneyline only'],
];
const sorts = [
  ['time', 'Game time'],
  ['moneyline_edge', 'Highest moneyline edge'],
  ['total_edge', 'Highest total edge'],
  ['confidence', 'Confidence'],
  ['quality', 'Data quality score'],
  ['total_diff', 'Projected total difference'],
  ['movement', 'Market movement'],
];

function HeaderMetric({ label, value }) {
  return (
    <div className="rounded-lg border border-line bg-white p-4 shadow-soft">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-ink">{value}</p>
    </div>
  );
}

function useDashboardData() {
  const [today, setToday] = useState(null);
  const [history, setHistory] = useState([]);
  const [performance, setPerformance] = useState(null);
  const [settings, setSettings] = useState(null);
  const [backtest, setBacktest] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [source, setSource] = useState('live');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  async function loadToday(nextSource = source) {
    setLoading(true);
    setError('');
    try {
      setToday(await api.today({ source: nextSource, date }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadAll() {
    setLoading(true);
    setError('');
    try {
      const [todayPayload, historyPayload, performancePayload, settingsPayload] = await Promise.all([
        api.today({ source, date }),
        api.history(),
        api.performance(),
        api.settings(),
      ]);
      setToday(todayPayload);
      setHistory(historyPayload.rows || []);
      setPerformance(performancePayload);
      setSettings(settingsPayload);
      setBacktest(await api.backtest({ season: new Date().getFullYear(), market_type: 'moneyline' }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    if (!settings?.auto_refresh_minutes) return undefined;
    const interval = setInterval(() => loadToday(), Math.max(5, Number(settings.auto_refresh_minutes)) * 60000);
    return () => clearInterval(interval);
  }, [settings?.auto_refresh_minutes, source, date]);

  return {
    today,
    history,
    performance,
    settings,
    setSettings,
    backtest,
    setBacktest,
    loading,
    error,
    source,
    setSource,
    date,
    setDate,
    loadToday,
    loadAll,
  };
}

function filterGames(games, filter) {
  if (filter === 'all') return games;
  if (['BET', 'LEAN', 'NO BET'].includes(filter)) return games.filter((game) => game.decision === filter);
  if (filter === 'high_edge') return games.filter((game) => Math.max(Math.abs(Number(game.moneyline?.edge) || 0), Math.abs(Number(game.totals?.edge) || 0)) >= 4);
  if (filter === 'stale') return games.filter((game) => lower(game.data_quality?.weather).includes('stale') || lower(game.data_quality?.odds).includes('stale'));
  if (filter === 'pitchers') return games.filter((game) => lower(game.probable_pitchers?.status).includes('confirmed'));
  if (filter === 'lineups') return games.filter((game) => lower(game.lineup_status).includes('confirmed'));
  if (filter === 'totals') return games.filter((game) => lower(game.final_lean).includes('over') || lower(game.final_lean).includes('under'));
  if (filter === 'moneyline') return games.filter((game) => !lower(game.final_lean).includes('over') && !lower(game.final_lean).includes('under'));
  return games;
}

function sortGames(games, sort) {
  const confidenceScore = { high: 3, medium: 2, low: 1 };
  const copy = [...games];
  copy.sort((a, b) => {
    if (sort === 'moneyline_edge') return Math.abs(Number(b.moneyline?.edge) || 0) - Math.abs(Number(a.moneyline?.edge) || 0);
    if (sort === 'total_edge') return Math.abs(Number(b.totals?.edge) || 0) - Math.abs(Number(a.totals?.edge) || 0);
    if (sort === 'confidence') return (confidenceScore[lower(b.moneyline?.confidence)] || 0) - (confidenceScore[lower(a.moneyline?.confidence)] || 0);
    if (sort === 'quality') return (Number(b.data_quality?.score) || 0) - (Number(a.data_quality?.score) || 0);
    if (sort === 'total_diff') return Math.abs(Number(b.totals?.difference) || 0) - Math.abs(Number(a.totals?.difference) || 0);
    if (sort === 'movement') return lower(b.data_quality?.market_movement).localeCompare(lower(a.data_quality?.market_movement));
    return String(a.game_time || '').localeCompare(String(b.game_time || ''));
  });
  return copy;
}

function TodayView({ today, source, setSource, date, setDate, loadToday, loading }) {
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('time');
  const games = useMemo(() => sortGames(filterGames(today?.games || [], filter), sort), [today, filter, sort]);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-6">
        <HeaderMetric label="Total Games" value={today?.summary?.total_games || 0} />
        <HeaderMetric label="BET" value={today?.summary?.bet_count || 0} />
        <HeaderMetric label="LEAN" value={today?.summary?.lean_count || 0} />
        <HeaderMetric label="NO BET" value={today?.summary?.no_bet_count || 0} />
        <HeaderMetric label="Avg Quality" value={`${today?.summary?.average_data_quality || 0}/100`} />
        <HeaderMetric label="Last Updated" value={relativeTime(today?.last_updated)} />
      </div>

      <section className="rounded-lg border border-line bg-white p-4 shadow-soft">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            {filters.map(([value, label]) => (
              <button key={value} className={`rounded-md px-3 py-2 text-sm font-semibold ${filter === value ? 'bg-blue-600 text-white' : 'border border-line text-ink'}`} onClick={() => setFilter(value)} type="button">
                {label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <input className="rounded-md border border-line px-3 py-2 text-sm" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            <select className="rounded-md border border-line px-3 py-2 text-sm" value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="live">Live</option>
              <option value="sample">Sample</option>
              <option value="mock">Mock</option>
            </select>
            <select className="rounded-md border border-line px-3 py-2 text-sm" value={sort} onChange={(event) => setSort(event.target.value)}>
              {sorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <button className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white" onClick={() => loadToday(source)} type="button">
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
            <a className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm font-semibold text-ink" href={exportUrl('today', { source, date })}>
              <Download size={16} />
              CSV
            </a>
          </div>
        </div>
        {today?.warning ? <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">{today.warning}</p> : null}
      </section>

      <div className="space-y-4">
        {games.map((game) => <GameCard key={game.id} game={game} />)}
      </div>
    </div>
  );
}

function HistoryView({ history }) {
  const [filters, setFilters] = useState({
    start: '',
    end: '',
    market: 'all',
    result: 'all',
    confidence: 'all',
    decision: 'all',
  });
  const rows = history.filter((row) => {
    if (filters.start && row.date < filters.start) return false;
    if (filters.end && row.date > filters.end) return false;
    if (filters.market !== 'all' && lower(row.market_type) !== filters.market) return false;
    if (filters.result !== 'all' && lower(row.result) !== filters.result) return false;
    if (filters.confidence !== 'all' && lower(row.confidence) !== filters.confidence) return false;
    if (filters.decision !== 'all' && row.decision !== filters.decision) return false;
    return true;
  });
  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-line bg-white p-4 shadow-soft">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm font-semibold">Start<input className="rounded-md border border-line px-3 py-2" type="date" value={filters.start} onChange={(event) => setFilters({ ...filters, start: event.target.value })} /></label>
          <label className="grid gap-1 text-sm font-semibold">End<input className="rounded-md border border-line px-3 py-2" type="date" value={filters.end} onChange={(event) => setFilters({ ...filters, end: event.target.value })} /></label>
          <label className="grid gap-1 text-sm font-semibold">Market<select className="rounded-md border border-line px-3 py-2" value={filters.market} onChange={(event) => setFilters({ ...filters, market: event.target.value })}><option value="all">All</option><option value="moneyline">Moneyline</option><option value="totals">Totals</option><option value="run line">Run line</option></select></label>
          <label className="grid gap-1 text-sm font-semibold">Result<select className="rounded-md border border-line px-3 py-2" value={filters.result} onChange={(event) => setFilters({ ...filters, result: event.target.value })}><option value="all">All</option><option value="win">Win</option><option value="loss">Loss</option><option value="push">Push</option></select></label>
          <label className="grid gap-1 text-sm font-semibold">Confidence<select className="rounded-md border border-line px-3 py-2" value={filters.confidence} onChange={(event) => setFilters({ ...filters, confidence: event.target.value })}><option value="all">All</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          <label className="grid gap-1 text-sm font-semibold">Decision<select className="rounded-md border border-line px-3 py-2" value={filters.decision} onChange={(event) => setFilters({ ...filters, decision: event.target.value })}><option value="all">All</option><option value="BET">BET</option><option value="LEAN">LEAN</option><option value="NO BET">NO BET</option></select></label>
          <a className="rounded-md border border-line px-3 py-2 text-sm font-semibold" href={exportUrl('history')}>Export CSV</a>
        </div>
      </div>
      <HistoryTable rows={rows} />
    </section>
  );
}

function BacktestView({ backtest, setBacktest }) {
  const [form, setForm] = useState({ season: new Date().getFullYear(), market_type: 'moneyline', start_date: '', end_date: '' });
  const [running, setRunning] = useState(false);
  async function run() {
    setRunning(true);
    try {
      setBacktest(await api.backtest(form));
    } finally {
      setRunning(false);
    }
  }
  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-line bg-white p-4 shadow-soft">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm font-semibold">Season<input className="rounded-md border border-line px-3 py-2" type="number" value={form.season} onChange={(event) => setForm({ ...form, season: Number(event.target.value) })} /></label>
          <label className="grid gap-1 text-sm font-semibold">Start date<input className="rounded-md border border-line px-3 py-2" type="date" value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} /></label>
          <label className="grid gap-1 text-sm font-semibold">End date<input className="rounded-md border border-line px-3 py-2" type="date" value={form.end_date} onChange={(event) => setForm({ ...form, end_date: event.target.value })} /></label>
          <label className="grid gap-1 text-sm font-semibold">Market<select className="rounded-md border border-line px-3 py-2" value={form.market_type} onChange={(event) => setForm({ ...form, market_type: event.target.value })}><option value="moneyline">Moneyline</option><option value="totals">Totals</option></select></label>
          <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white" onClick={run} type="button">{running ? 'Running...' : 'Run backtest'}</button>
          <a className="rounded-md border border-line px-4 py-2 text-sm font-semibold" href={exportUrl('backtest')}>Export CSV</a>
        </div>
      </div>
      <BacktestTable result={backtest} />
    </section>
  );
}

export default function App() {
  const data = useDashboardData();
  const [activeTab, setActiveTab] = useState('Today');
  const [saving, setSaving] = useState(false);

  async function saveSettings() {
    setSaving(true);
    try {
      await api.saveSettings(data.settings);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">MLB Stats Bot</p>
            <h1 className="text-2xl font-bold text-ink">Prediction Control Center</h1>
          </div>
          <nav className="flex flex-wrap gap-2">
            {tabs.map((tab) => (
              <button key={tab} className={`rounded-md px-3 py-2 text-sm font-semibold ${activeTab === tab ? 'bg-blue-600 text-white' : 'border border-line bg-white text-ink'}`} onClick={() => setActiveTab(tab)} type="button">
                {tab}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-5">
        {data.error ? <div className="mb-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">{data.error}</div> : null}
        {activeTab === 'Today' ? <TodayView {...data} /> : null}
        {activeTab === 'History' ? <HistoryView history={data.history} /> : null}
        {activeTab === 'Backtest' ? <BacktestView backtest={data.backtest} setBacktest={data.setBacktest} /> : null}
        {activeTab === 'Performance' ? <PerformanceSummary performance={data.performance} /> : null}
        {activeTab === 'Settings' ? <SettingsPanel settings={data.settings || {}} onChange={data.setSettings} onSave={saveSettings} saving={saving} /> : null}
        <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-500">
          <PredictionBadge>{data.loading ? 'Loading' : 'Ready'}</PredictionBadge>
          <PredictionBadge>{data.source}</PredictionBadge>
          <span>Auto-refresh is conservative and uses the configured interval.</span>
        </div>
      </div>
    </main>
  );
}
