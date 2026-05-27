import { cn } from '../../lib/utils.js';

export function Input({ className = '', ...props }) {
  return (
    <input
      className={cn(
        'h-10 rounded-md border-3 border-ink bg-white px-3 text-sm font-semibold text-ink shadow-neo-sm outline-none transition focus:bg-paper focus:ring-4 focus:ring-accent-yellow',
        className
      )}
      {...props}
    />
  );
}

export function Select({ className = '', children, ...props }) {
  return (
    <select
      className={cn(
        'h-10 rounded-md border-3 border-ink bg-white px-3 text-sm font-semibold text-ink shadow-neo-sm outline-none transition focus:bg-paper focus:ring-4 focus:ring-accent-yellow',
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Field({ label, helper, children, className = '' }) {
  return (
    <label className={cn('grid gap-1.5 text-sm font-black uppercase tracking-tight text-ink', className)}>
      {label}
      {children}
      {helper ? <span className="text-xs font-semibold normal-case text-ink/70">{helper}</span> : null}
    </label>
  );
}

export function Switch({ checked, onChange, label, helper }) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-md border-3 border-ink bg-paper px-4 py-3 shadow-neo-sm">
      <span>
        <span className="block text-sm font-black uppercase tracking-tight text-ink">{label}</span>
        {helper ? <span className="mt-1 block text-xs font-semibold text-ink/70">{helper}</span> : null}
      </span>
      <input
        aria-label={label}
        type="checkbox"
        className="h-5 w-5 accent-black"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function Progress({ value = 0, className = '' }) {
  const width = Math.max(0, Math.min(100, Number(value) || 0));
  const color = width >= 85 ? 'bg-accent-green' : width >= 60 ? 'bg-accent-yellow' : 'bg-accent-red';
  return (
    <div className={cn('h-3 overflow-hidden rounded-full border-2 border-ink bg-white', className)}>
      <div className={cn('h-full transition-all', color)} style={{ width: `${width}%` }} />
    </div>
  );
}
