import { cn } from '@/lib/utils';

export interface MeterProps {
  /** 0 - 100 */
  value: number;
  tone?: 'primary' | 'success' | 'warning' | 'neutral';
  className?: string;
  label?: string;
}

const toneClass: Record<NonNullable<MeterProps['tone']>, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  neutral: 'bg-border-strong',
};

/** 细条形评分/进度指示（用于决策理由可视化） */
export function Meter({ value, tone = 'primary', className, label }: MeterProps) {
  const safe = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={safe}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-muted', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500 ease-out', toneClass[tone])}
        style={{ width: `${safe}%` }}
      />
    </div>
  );
}
