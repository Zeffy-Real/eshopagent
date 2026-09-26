'use client';

import { LayoutGrid } from 'lucide-react';
import { useCatalogData } from '@/components/providers/catalog-data-provider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CATEGORIES, type Category } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useAgentStore } from '@/store/use-agent-store';
import { useUiStore } from '@/store/use-ui-store';

/**
 * 按品类浏览入口（中栏顶部）。
 *
 * 点击后**直接打开中栏浏览视图**（`components/product/browse-view.tsx`），
 * 不走对话：视图数据由客户端目录的按需 chunk 现算，因此没有 LLM 依赖、
 * 不产生 SSE 请求、也不会带上任何上一轮残留的筛选条件（此前 chip 走对话时，
 * 「100 元以内」之后点品类会把价格条件一起带进去，命中从 60 缩到 4）。
 *
 * 对话入口没有消失：输入「帮我看看<品类>的商品」仍会走 parseIntent → searchProducts，
 * 想要「带条件的品类检索」时用它。
 */
export function CategoryBar() {
  const snapshot = useAgentStore((s) => s.snapshot);
  const openBrowse = useUiStore((s) => s.openBrowse);
  // 件数由服务端按当前源算好注入（real 各 60 / justoneapi 各 4 / mock 各不同）
  const { categoryCounts } = useCatalogData();
  // 高亮只表示「对话当前用的品类」，与浏览视图无关（后者自带标题与口径）
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
          <Tooltip key={category}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={isActive}
                // 纯客户端浏览：Agent 执行中也随时可点（不给服务端加负载、零 LLM 依赖）
                onClick={() => openBrowse({ kind: 'category', category })}
                className={cn(
                  'flex items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-1 text-[12px] leading-4 transition-colors duration-150',
                  'outline-none focus-visible:border-primary',
                  isActive
                    ? 'border-primary/30 bg-primary-soft text-primary-ink'
                    : 'border-border bg-surface text-foreground hover:border-border-strong hover:bg-surface-muted',
                )}
              >
                {category}
                <span className="tabular-nums text-[10px] text-muted-foreground">
                  {categoryCounts[category]}
                </span>
              </button>
            </TooltipTrigger>
            {/* 数字是**目录总量**（服务端按当前源算好），不是某次检索的命中数；
                点开浏览视图能看到该品类全部这些件数 */}
            <TooltipContent>
              浏览该品类全部 {categoryCounts[category]} 件（不进对话、无残留条件）
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}