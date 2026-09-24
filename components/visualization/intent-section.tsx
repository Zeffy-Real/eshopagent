'use client';

import { SlidersHorizontal } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { useAgentStore } from '@/store/use-agent-store';
import { INTENT_LABEL, type SortKey } from '@/lib/types';

const SORT_LABEL: Record<SortKey, string> = {
  relevance: '综合排序',
  price_asc: '价格从低到高',
  price_desc: '价格从高到低',
  rating: '评分优先',
  sales: '销量优先',
};

interface FilterTag {
  label: string;
  value: string;
}

/** 意图解析：把自然语言解析出的筛选条件以标签形式呈现 */
export function IntentSection() {
  const snapshot = useAgentStore((s) => s.snapshot);
  const filters = snapshot?.searchFilters;

  if (!snapshot || !filters) {
    return (
      <EmptyState
        compact
        icon={SlidersHorizontal}
        title="尚未解析出筛选条件"
        description="品类、价格区间、品牌偏好与功能需求会以标签形式呈现。"
      />
    );
  }

  const tags: FilterTag[] = [];
  if (filters.category) tags.push({ label: '品类', value: filters.category });
  for (const keyword of filters.keywords ?? []) {
    tags.push({ label: '关键词', value: keyword });
  }
  for (const tag of filters.tags ?? []) tags.push({ label: '功能', value: tag });
  for (const brand of filters.brands ?? []) tags.push({ label: '品牌', value: brand });

  if (filters.minPrice !== undefined && filters.maxPrice !== undefined) {
    tags.push({ label: '价格', value: `¥${filters.minPrice} - ¥${filters.maxPrice}` });
  } else if (filters.maxPrice !== undefined) {
    tags.push({ label: '预算', value: `≤ ¥${filters.maxPrice}` });
  } else if (filters.minPrice !== undefined) {
    tags.push({ label: '价格', value: `≥ ¥${filters.minPrice}` });
  }
  if (filters.minRating !== undefined) {
    tags.push({ label: '评分', value: `${filters.minRating} 分以上` });
  }
  if (filters.sort) tags.push({ label: '排序', value: SORT_LABEL[filters.sort] });

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="rounded-[var(--radius-sm)] border border-primary/25 bg-primary-soft px-1.5 py-0.5 text-[11px] font-medium text-primary-ink">
          {INTENT_LABEL[snapshot.intent]}
        </span>
        {filters.rawQuery && (
          <p className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
            「{filters.rawQuery}」
          </p>
        )}
      </div>

      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={`${tag.label}-${tag.value}`}
              className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-0.5 text-[11px] leading-4"
            >
              <span className="text-muted-foreground">{tag.label}</span>
              <span className="font-medium text-foreground">{tag.value}</span>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[11.5px] text-muted-foreground">
          本次未提取到硬性条件，可继续补充预算、品类或功能要求。
        </p>
      )}
    </div>
  );
}
