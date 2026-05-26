import { cn } from '../../lib/utils.js';

export function Tabs({ tabs, active, onChange, className = '' }) {
  return (
    <div className={cn('flex gap-1 overflow-x-auto scrollbar-none', className)}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            'whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-all duration-200 rounded-lg',
            active === tab.id
              ? 'bg-accent-blue/10 text-accent-blue border border-accent-blue/20'
              : 'text-slate-400 hover:text-white hover:bg-white/5 border border-transparent'
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ active, id, children }) {
  if (active !== id) return null;
  return <div className="animate-fade-in">{children}</div>;
}
