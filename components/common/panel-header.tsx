import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface PanelHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  /** 标题右侧的实时状态点（如在线状态） */
  status?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** 三栏统一的区块头：图标 + 标题 + 说明 + 右侧动作 */
export function PanelHeader({
  icon: Icon,
  title,
  subtitle,
  status,
  actions,
  className,
}: PanelHeaderProps) {
  return (
    <header
      className={cn(
        'flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4',
        className,
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-primary-soft text-primary-ink">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold leading-tight text-foreground">
            {title}
          </h2>
          {status}
        </div>
        {subtitle && (
          <p className="truncate text-[12px] leading-tight text-muted-foreground">
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}
