import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border-2 border-ink px-2.5 py-0.5 text-xs font-black uppercase tracking-tight text-ink shadow-neo-sm',
  {
    variants: {
      variant: {
        default: 'bg-accent-blue',
        value: 'badge-value',
        lean: 'badge-lean',
        nobet: 'badge-nobet',
        lowdata: 'badge-lowdata',
        live: 'badge-live',
        final: 'badge-final',
        success: 'bg-accent-green',
        warning: 'bg-accent-yellow',
        danger: 'bg-accent-red',
        neutral: 'bg-stone-200',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export function Badge({ className, variant, ...props }) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}

export function LiveBadge() {
  return (
    <span className="badge-live inline-flex items-center gap-1.5 rounded-md px-2.5 py-0.5 text-xs font-black uppercase shadow-neo-sm">
      <span className="h-1.5 w-1.5 rounded-full border border-ink bg-ink animate-pulse-slow" />
      LIVE
    </span>
  );
}

export { badgeVariants };
