import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * 卡片两种形态二选一（不同时使用边框 + 阴影）：
 * - outline：1px 细边框，用于结构化容器（面板、分组）
 * - elevated：仅轻阴影，用于浮起的商品卡片
 */
const cardVariants = cva('rounded-[var(--radius-lg)] bg-surface', {
  variants: {
    variant: {
      outline: 'border border-border',
      elevated: 'shadow-card',
      plain: '',
    },
  },
  defaultVariants: { variant: 'outline' },
});

export interface CardProps
  extends React.ComponentProps<'div'>,
    VariantProps<typeof cardVariants> {}

export function Card({ className, variant, ...props }: CardProps) {
  return <div className={cn(cardVariants({ variant }), className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-start justify-between gap-3 px-4 pt-4 pb-2', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return (
    <h3
      className={cn('text-[15px] font-semibold leading-5 text-foreground', className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p className={cn('text-[13px] text-muted-foreground', className)} {...props} />
  );
}

export function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('px-4 pb-4', className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div className={cn('flex items-center gap-2 px-4 pb-4', className)} {...props} />
  );
}

export { cardVariants };
