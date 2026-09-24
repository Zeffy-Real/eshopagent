import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  children?: ReactNode;
  className?: string;
  compact?: boolean;
}

/** 统一的空状态：线性图标 + 左对齐文案，不使用插画占位 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-2 rounded-[var(--radius-md)] border border-dashed border-border bg-surface-muted/40 px-4',
        compact ? 'py-3' : 'py-5',
        className,
      )}
    >
      <span className="flex size-7 items-center justify-center rounded-[var(--radius-sm)] bg-surface text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="space-y-0.5">
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        {description && (
          <p className="text-[12px] leading-5 text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}
