import { Activity, Calendar, RefreshCw, Send, Zap } from 'lucide-react';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'games', label: 'Games' },
  { id: 'predictions', label: 'Predictions' },
  { id: 'moneyline', label: 'Moneyline' },
  { id: 'totals', label: 'Totals' },
  { id: 'yrfi', label: 'YRFI / NRFI' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'memory', label: 'Memory' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'settings', label: 'Settings' },
];

export default function Navbar({ activeTab, onTabChange, onRefresh, date, onDateChange }) {
  return (
    <nav className="glass-navbar sticky top-0 z-50">
      <div className="mx-auto max-w-[1600px] px-4">
        <div className="flex h-14 items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-accent-red/20 border border-accent-red/30 flex items-center justify-center">
                <Activity className="h-4 w-4 text-accent-red" />
              </div>
              <span className="text-sm font-bold text-white hidden sm:block">MLB Stats Bot</span>
            </div>

            <div className="hidden lg:flex items-center gap-0.5 overflow-x-auto">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.id}
                  onClick={() => onTabChange(item.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-200 whitespace-nowrap ${
                    activeTab === item.id
                      ? 'bg-accent-blue/10 text-accent-blue'
                      : 'text-slate-400 hover:text-white hover:bg-white/5'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2">
              <Calendar className="h-3.5 w-3.5 text-slate-400" />
              <input
                type="date"
                value={date}
                onChange={(e) => onDateChange(e.target.value)}
                className="glass-input px-2 py-1 text-xs w-32"
              />
            </div>

            <button
              onClick={onRefresh}
              className="h-8 w-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-all"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>

            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-green/10 border border-accent-green/20 px-2 py-0.5 text-[10px] font-medium text-accent-green">
                <Send className="h-2.5 w-2.5" />
                TG
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-blue/10 border border-accent-blue/20 px-2 py-0.5 text-[10px] font-medium text-accent-blue">
                <Zap className="h-2.5 w-2.5" />
                Agent
              </span>
            </div>
          </div>
        </div>

        <div className="flex lg:hidden items-center gap-1 overflow-x-auto pb-2 -mx-4 px-4 scrollbar-none">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all whitespace-nowrap ${
                activeTab === item.id
                  ? 'bg-accent-blue/10 text-accent-blue'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
