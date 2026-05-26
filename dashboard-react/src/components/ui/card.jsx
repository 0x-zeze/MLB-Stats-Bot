import { cn } from '../../lib/utils.js';

export function Card({ className = '', ...props }) {
  return <section className={cn('glass-card', className)} {...props} />;
}

export function CardHeader({ className = '', ...props }) {
  return <div className={cn('border-b border-white/[0.06] px-5 py-4', className)} {...props} />;
}

export function CardTitle({ className = '', ...props }) {
  return <h3 className={cn('text-base font-bold text-white', className)} {...props} />;
}

export function CardDescription({ className = '', ...props }) {
  return <p className={cn('mt-1 text-sm text-slate-400', className)} {...props} />;
}

export function CardContent({ className = '', ...props }) {
  return <div className={cn('p-5', className)} {...props} />;
}
