'use client';

import { ArrowDownWideNarrow, ArrowUpNarrowWide, Sparkles } from 'lucide-react';
import type { Product, SortKey } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface SortControlProps {
  value: SortKey;
  onChange: (value: SortKey) => void;
  className?: string;
}

const OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'relevance', label: '综合' },
  { key: 'price_asc', label: '价格' },
  { key: 'rating', label: '评分' },
  { key: 'sales', label: '销量' },
];

/**
 * 纯客户端重排（价格 / 评分 / 销量；`relevance` 保持目录或检索自身的顺序）。
 *
 * 放在控件旁边而不是各调用点各写一份：升 / 降序的切换规则在这个控件里
 * （点「价格」在 `price_asc` 与 `price_desc` 之间切换），重排规则跟着它走，
 * 才不会出现「控件显示价格降序、列表却按升序排」这类第二份实现的分叉。
 * 只做展示层排序，不改任何检索 / 推荐结果集。
 */
export function sortProducts(products: Product[], sort: SortKey): Product[] {
  const list = products.slice();
  switch (sort) {
    case 'price_asc':
      return list.sort((a, b) => a.price - b.price);
    case 'price_desc':
      return list.sort((a, b) => b.price - a.price);
    case 'rating':
      return list.sort((a, b) => b.rating - a.rating || b.sales - a.sales);
    case 'sales':
      return list.sort((a, b) => b.sales - a.sales);
    default:
      return list;
  }
}

/** 排序切换：点击「价格」在升序/降序之间切换 */
export function SortControl({ value, onChange, className }: SortControlProps) {
  const priceActive = value === 'price_asc' || value === 'price_desc';

  return (
    <div
      role="radiogroup"
      aria-label="排序方式"
      className={cn(
        'flex items-center gap-0.5 rounded-[var(--radius-md)] border border-border bg-surface p-0.5',
        className,
      )}
    >
      {OPTIONS.map((option) => {
        const active = option.key === 'relevance' ? value === 'relevance' : option.key === 'price_asc' ? priceActive : value === option.key;
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => {
              if (option.key === 'price_asc') {
                onChange(value === 'price_asc' ? 'price_desc' : 'price_asc');
                return;
              }
              onChange(option.key);
            }}
            className={cn(
              'flex h-7 items-center gap-1 rounded-[var(--radius-sm)] px-2 text-[12px] font-medium transition-colors duration-150',
              active
                ? 'bg-primary-soft text-primary-ink'
                : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
            )}
          >
            {option.key === 'relevance' && <Sparkles className="size-3" />}
            {option.label}
            {option.key === 'price_asc' &&
              (value === 'price_desc' ? (
                <ArrowDownWideNarrow className="size-3" />
              ) : (
                <ArrowUpNarrowWide className="size-3" />
              ))}
          </button>
        );
      })}
    </div>
  );
}
