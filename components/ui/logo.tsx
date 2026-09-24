import { cn } from '@/lib/utils';

/** 品牌标识：购物袋 + 智能节点（纯矢量，无位图依赖） */
export function Logo({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="智能购物助手"
      className={cn('shrink-0', className)}
    >
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <path
        d="M11 12.5h10l1.2 9.2a1.6 1.6 0 0 1-1.6 1.8h-9.2a1.6 1.6 0 0 1-1.6-1.8L11 12.5Z"
        stroke="var(--brand-contrast)"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M13.6 12.5v-1.6a2.4 2.4 0 0 1 4.8 0v1.6"
        stroke="var(--brand-contrast)"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <circle cx="22.4" cy="9.4" r="2.6" fill="var(--brand-contrast)" />
      <circle cx="22.4" cy="9.4" r="0.9" fill="var(--brand)" />
    </svg>
  );
}
