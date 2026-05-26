import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold border',
  {
    variants: {
      variant: {
        default: 'bg-accent-blue/15 text-accent-blue border-accent-blue/30',
        value: 'badge-value',
        lean: 'badge-lean',
        nobet: 'badge-nobet',
        lowdata: 'badge-lowdata',
        live: 'badge-live',
        final: 'badge-final',
        success: 'bg-accent-green/15 text-accent-green border-accent-green/30',
        warning: 'bg-accent-yellow/15 text-accent-yellow border-accent-yellow/30',
        danger: 'bg-accent-red/15 text-accent-red border-accent-red/30',
        neutral: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
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
    <span className="badge-live inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold">
      <span className="h-1.5 w-1.5 rounded-full bg-accent-green animate-pulse-slow" />
      LIVE
    </span>
  );
}

export { badgeVariants };
