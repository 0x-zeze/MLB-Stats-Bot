import { RefreshCw } from 'lucide-react';
import { Button } from './ui/button.jsx';
import PredictionBadge from './PredictionBadge.jsx';
import { relativeTime } from '../utils.js';

export default function Navbar({ tabs, activeTab, onTabChange, lastUpdated, loading, onRefresh }) {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-ink">MLB Dashboard</h1>
            <PredictionBadge tone="blue">{loading ? 'Loading' : 'Ready'}</PredictionBadge>
          </div>
          <p className="mt-1 text-sm text-slate-500">Today's prediction slate</p>
        </div>
        <div className="flex flex-col gap-3 lg:items-end">
          <nav className="flex gap-1 overflow-x-auto rounded-md bg-slate-100 p-1">
            {tabs.map((tab) => (
              <button
                key={tab}
                className={`h-9 whitespace-nowrap rounded px-3 text-sm font-semibold transition ${
                  activeTab === tab ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-ink'
                }`}
                onClick={() => onTabChange(tab)}
                type="button"
              >
                {tab}
              </button>
            ))}
          </nav>
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span>Updated {relativeTime(lastUpdated)}</span>
            <Button variant="ghost" size="sm" type="button" onClick={onRefresh}>
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
              Refresh
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
