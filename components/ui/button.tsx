import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-[background-color,color,border-color,box-shadow,transform] duration-150 outline-none disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 active:scale-[0.97]',
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground hover:brightness-[0.94] shadow-[0_1px_2px_rgba(0,0,0,0.08)]',
        secondary:
          'bg-surface-muted text-foreground border border-border hover:border-border-strong',
        outline:
          'bg-transparent text-foreground border border-border hover:bg-surface-muted',
        ghost: 'bg-transparent text-foreground hover:bg-surface-muted',
        danger: 'bg-danger-soft text-danger border border-danger/30 hover:bg-danger/15',
        link: 'bg-transparent text-primary-ink underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 rounded-[var(--radius-sm)] px-3 text-[13px] [&_svg]:size-3.5',
        md: 'h-9 rounded-[var(--radius-md)] px-4 text-sm [&_svg]:size-4',
        lg: 'h-11 rounded-[var(--radius-md)] px-6 text-[15px] [&_svg]:size-4',
        icon: 'size-9 rounded-[var(--radius-md)] [&_svg]:size-4',
        'icon-sm': 'size-7 rounded-[var(--radius-sm)] [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
