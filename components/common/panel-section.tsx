import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface PanelSectionProps {
  icon: LucideIcon;
  title: string;
  /** 标题右侧的计数/状态标记 */
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Agent 面板内的分区容器：仅用 1px 边框与间距构建层级 */
export function PanelSection({
  icon: Icon,
  title,
  meta,
  actions,
  children,
  className,
}: PanelSectionProps) {
  return (
    <section
      className={cn(
        'rounded-[var(--radius-lg)] border border-border bg-surface',
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
        {meta && <div className="ml-0.5">{meta}</div>}
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}
