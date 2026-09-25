'use client';

import { LayoutGrid } from 'lucide-react';
import { useCatalogData } from '@/components/providers/catalog-data-provider';
import { CATEGORIES, type Category } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useAgentStore } from '@/store/use-agent-store';

/**
 * 按品类浏览入口（中栏顶部）。
 *
 * 为什么点击后是「发一句话」而不是直接改筛选条件：筛选条件（`searchFilters`）只存在于
 * 服务端图状态里，客户端没有第二条写入路径。让它走与对话完全相同的入口
 * （`parseIntent → searchProducts`），才能保证「点分类搜出来的结果」与「说品类搜出来的结果」
 * 一模一样 —— 不新增一套并行的筛选实现，也就不会有第二处口径。
 */
export function CategoryBar() {
  const snapshot = useAgentStore((s) => s.snapshot);
  const thinking = useAgentStore((s) => s.thinking);
  const sendMessage = useAgentStore((s) => s.sendMessage);
  // 件数由服务端按当前源算好注入（real 各 60 / justoneapi 各 4 / mock 各不同）
  const { categoryCounts } = useCatalogData();
  const active: Category | undefined = snapshot?.searchFilters.category;

  return (
    <div
      role="group"
      aria-label="按品类浏览商品"
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border bg-sidebar px-4 py-2"
    >
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <LayoutGrid className="size-3" />
        按品类浏览
      </span>

      {CATEGORIES.map((category) => {
        const isActive = category === active;
        return (
          <button
            key={category}
            type="button"
            aria-pressed={isActive}
            // 已选中的品类再点一次没有意义：同一条请求会白跑一轮
            disabled={thinking || isActive}
            onClick={() => void sendMessage(`帮我看看${category}的商品`)}
            className={cn(
              'flex items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-1 text-[12px] leading-4 transition-colors duration-150',
              'outline-none focus-visible:border-primary',
              isActive
                ? 'border-primary/30 bg-primary-soft text-primary-ink'
                : 'border-border bg-surface text-foreground hover:border-border-strong hover:bg-surface-muted',
              // 执行中整体置灰；已选中项保持常态外观（只不可再点），避免被误读成「失效」
              thinking ? 'cursor-not-allowed opacity-50' : '',
              isActive && !thinking ? 'cursor-default' : '',
            )}
          >
            {category}
            <span className="tabular-nums text-[10px] text-muted-foreground">
              {categoryCounts[category]}
            </span>
          </button>
        );
      })}
    </div>
  );
}