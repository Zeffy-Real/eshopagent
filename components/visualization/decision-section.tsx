'use client';

import { useMemo } from 'react';
import { Target } from 'lucide-react';
import { PriceRatingScatter } from '@/components/charts/price-rating-scatter';
import { EmptyState } from '@/components/common/empty-state';
import { Meter } from '@/components/ui/meter';
import { buildDecisionReasons } from '@/lib/decision';
import type { Product } from '@/lib/types';
import { useAgentStore } from '@/store/use-agent-store';
import { useUiStore } from '@/store/use-ui-store';
import { formatPrice, hasRealSales } from '@/lib/utils';

/** 稳定的空数组引用：选择器里返回新数组会让 useSyncExternalStore 判定快照持续变化 */
const EMPTY_PRODUCTS: Product[] = [];

/** 决策推荐：把「为什么推荐它」拆成可量化的理由，配合价格 × 评分分布图 */
export function DecisionSection() {
  const comparison = useAgentStore((s) => s.snapshot?.comparison ?? null);
  const searchResults = useAgentStore((s) => s.snapshot?.searchResults ?? EMPTY_PRODUCTS);
  const openProductDetail = useUiStore((s) => s.openProductDetail);

  const reasons = useMemo(
    () => (comparison ? buildDecisionReasons(comparison) : []),
    [comparison],
  );
  // 用字符串做依赖：每次渲染新建数组会让图表 option 变化 → 每帧重新播放动画
  const highlightKey = reasons.map((reason) => reason.productId).join(',');
  const highlightIds = useMemo(
    () => (highlightKey ? highlightKey.split(',') : []),
    [highlightKey],
  );

  // 必须 memo：`searchResults.slice(0, 8)` 每次渲染都是新数组，
  // 作为 PriceRatingScatter 的 props 会让它的 option useMemo 依赖失效，
  // 于是图表每帧重建、动画反复重播（与 highlightIds 同一类问题）
  const chartProducts = useMemo(
    () => comparison?.products ?? searchResults.slice(0, 8),
    [comparison, searchResults],
  );
  // 与图表内部的气泡度量规则保持一致：有真实销量按销量，否则按真实评价数
  const chartMetricLabel = chartProducts.some((product) => hasRealSales(product.sales))
    ? '销量'
    : '评价数';

  if (reasons.length === 0 && chartProducts.length === 0) {
    return (
      <EmptyState
        compact
        icon={Target}
        title="暂无可推荐依据"
        description="搜索或对比商品后，这里会给出量化推荐理由（性价比、评分、口碑、库存）。"
      />
    );
  }

  return (
    <div className="space-y-3">
      {reasons.length > 0 ? (
        <ul className="space-y-2.5">
          {reasons.map((reason) => (
            <li key={reason.label}>
              <button
                type="button"
                onClick={() => openProductDetail(reason.productId)}
                className="w-full text-left"
              >
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="text-[11.5px] font-medium text-foreground">
                    {reason.label}
                  </span>
                  <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
                    {reason.score} 分
                  </span>
                </div>
                <Meter value={reason.score} tone={reason.tone} label={reason.label} />
                <p className="mt-1 truncate text-[11px] text-foreground/85">
                  {reason.productName}
                </p>
                <p className="truncate text-[10.5px] text-muted-foreground">{reason.detail}</p>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11.5px] text-muted-foreground">
          选中 2 件以上商品发起对比后，会给出各维度的量化推荐理由。
        </p>
      )}

      {chartProducts.length >= 2 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            价格 × 评分分布（气泡大小 = {chartMetricLabel}，点击查看详情）
          </p>
          <div className="rounded-[var(--radius-md)] border border-border bg-surface p-1">
            <PriceRatingScatter
              products={chartProducts}
              highlightIds={highlightIds}
              onSelect={openProductDetail}
            />
          </div>
          {chartProducts[0] && (
            <p className="text-[10.5px] text-muted-foreground">
              价格区间 {formatPrice(Math.min(...chartProducts.map((p) => p.price)))} -{' '}
              {formatPrice(Math.max(...chartProducts.map((p) => p.price)))}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
