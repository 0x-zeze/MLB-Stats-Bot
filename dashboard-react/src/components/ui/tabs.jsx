import { cn } from '../../lib/utils.js';

export function Tabs({ tabs, active, onChange, className = '' }) {
  return (
    <div className={cn('flex gap-2 overflow-x-auto scrollbar-none', className)}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            'whitespace-nowrap rounded-md border-3 border-ink px-4 py-2.5 text-sm font-black uppercase tracking-tight text-ink transition-all duration-150',
            active === tab.id
              ? 'bg-accent-yellow shadow-neo-sm'
              : 'bg-paper hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-accent-blue hover:shadow-neo-sm'
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
