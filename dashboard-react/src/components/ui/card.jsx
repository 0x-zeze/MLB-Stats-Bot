import { cn } from '../../lib/utils.js';

export function Card({ className = '', ...props }) {
  return <section className={cn('glass-card text-ink', className)} {...props} />;
}

export function CardHeader({ className = '', ...props }) {
  return <div className={cn('border-b-3 border-ink bg-accent-yellow px-5 py-4', className)} {...props} />;
}

export function CardTitle({ className = '', ...props }) {
  return <h3 className={cn('text-base font-black uppercase tracking-tight text-ink', className)} {...props} />;
}

export function CardDescription({ className = '', ...props }) {
  return <p className={cn('mt-1 text-sm font-semibold text-ink/75', className)} {...props} />;
}

export function CardContent({ className = '', ...props }) {
  return <div className={cn('p-5 text-ink', className)} {...props} />;
}
