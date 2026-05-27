import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils.js';

const buttonVariants = cva(
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-md border-3 border-ink text-sm font-black uppercase tracking-tight text-ink shadow-neo-sm transition-all duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent-yellow disabled:pointer-events-none disabled:translate-x-0 disabled:translate-y-0 disabled:opacity-60 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-neo active:translate-x-0.5 active:translate-y-0.5 active:shadow-none',
  {
    variants: {
      variant: {
        default: 'bg-paper hover:bg-accent-yellow',
        primary: 'bg-accent-yellow hover:bg-accent-green',
        secondary: 'bg-accent-blue hover:bg-accent-yellow',
        ghost: 'bg-transparent shadow-none hover:bg-paper hover:shadow-neo-sm',
        danger: 'bg-accent-red hover:bg-accent-yellow',
        success: 'bg-accent-green hover:bg-accent-yellow',
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
