import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils.js';

const buttonVariants = cva(
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/50 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-accent-blue/20 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/30 hover:shadow-glow',
        primary: 'bg-accent-blue text-navy-900 font-bold hover:bg-accent-blue/90 shadow-glow',
        secondary: 'border border-white/10 bg-navy-700/50 text-slate-300 hover:bg-navy-600/50 hover:text-white',
        ghost: 'text-slate-400 hover:bg-white/5 hover:text-white',
        danger: 'bg-accent-red/20 text-accent-red border border-accent-red/30 hover:bg-accent-red/30 hover:shadow-glow-red',
        success: 'bg-accent-green/20 text-accent-green border border-accent-green/30 hover:bg-accent-green/30 hover:shadow-glow-green',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4',
        lg: 'h-11 px-6',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  }
);

const Button = forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
});

Button.displayName = 'Button';

export { Button, buttonVariants };
