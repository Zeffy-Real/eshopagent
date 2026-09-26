'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DatabaseZap, LayoutGrid, PackageOpen, X } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { ProductGrid } from '@/components/product/product-grid';
import { SortControl, sortProducts } from '@/components/product/sort-control';
import { useCatalogData } from '@/components/providers/catalog-data-provider';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { SEARCH_RESULT_ID_LIMIT } from '@/lib/agent/events';
import { loadBrowseProducts, type BrowseSource } from '@/lib/catalog/browse-products';
import { browseWindow } from '@/lib/product-panel-state';
import type { Product, SortKey } from '@/lib/types';
import { useUiStore } from '@/store/use-ui-store';

/**
 * 中栏浏览视图（覆盖层）——**同一个组件，三种数据来源**（见 `BrowseSource`）：
 * 品类 chip 的全量、整个目录、对话命中的 id 列表。
 *
 * 三条设计边界：
 * 1. **零 LLM 依赖**：数据走客户端目录的按需 chunk（`lib/catalog/client-products.ts`），
 *    不经对话、不碰 SSE —— 没有 API Key 时它同样完整可用；
 * 2. **不恢复目录静态 import**：目录 chunk 只在打开视图时才下载，首屏 bundle 不变；
 * 3. **排序复用中栏的排序控件**（`sortProducts` 与控件同源一处实现），只做展示层重排。
 *
 * 退出方式两个：头部关闭按钮与 ESC。窄屏下它是这一栏的全宽覆盖层，
 * 不改变 Tab + 抽屉的结构。
 */

/** 每次「加载更多」新增的件数：一屏左右（网格最多 4 列） */
const BROWSE_PAGE = 24;

/** 头部口径：标题 + 副标题（件数以加载结果为准，加载中回落到服务端注入的计数） */
function headingOf(
  source: BrowseSource,
  total: number,
  shownCount: number,
  remaining: number,
): { title: string; subtitle: string } {
  const progress = remaining > 0 ? `已显示 ${shownCount} 件` : '已全部显示';
  if (source.kind === 'category') {
    return {
      title: `${source.category} · 全部商品`,
      subtitle: `目录里该品类共 ${total} 件 · ${progress}`,
    };
  }
  if (source.kind === 'ids') {
    // 命中数超过单次下发上限时如实注明：视图里只有前 N 件，不假装是全部
    const total = source.total ?? source.ids.length;
    const truncated = total > source.ids.length;
    return {
      title: `本轮命中 ${total} 件`,
      subtitle: truncated
        ? `按本轮检索的命中结果展示 · 显示前 ${source.ids.length} 件（单次上限 ${SEARCH_RESULT_ID_LIMIT} 件）`
        : `按本轮检索的命中结果展示 · ${progress}`,
    };
  }
  return { title: '全部商品', subtitle: `目录共 ${total} 件 · ${progress}` };
}

export function BrowseView() {
  const source = useUiStore((s) => s.browseSource);
  const closeBrowse = useUiStore((s) => s.closeBrowse);
  // 服务端按当前源算好的计数：加载期间也能说出「共多少件」，不显示假的 0
  const { meta, categoryCounts } = useCatalogData();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [sort, setSort] = useState<SortKey>('relevance');
  const [visible, setVisible] = useState(BROWSE_PAGE);

  // 数据加载：来源变化（或重试）时重载。`products === null` 即加载中。
  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    setProducts(null);
    setFailed(false);
    setVisible(BROWSE_PAGE);
    void loadBrowseProducts(source).then((list) => {
      if (cancelled) return;
      if (list === null) setFailed(true);
      else setProducts(list);
    });
    return () => {
      cancelled = true;
    };
  }, [source, attempt]);

  // ESC 退出（与关闭按钮同一条出口）
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeBrowse();
    },
    [closeBrowse],
  );
  useEffect(() => {
    if (!source) return;
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [source, onKeyDown]);

  const sorted = useMemo(() => (products ? sortProducts(products, sort) : []), [products, sort]);
  const { shown, remaining } = browseWindow(sorted, visible);

  if (!source) return null;

  const expected =
    source.kind === 'ids'
      ? source.ids.length
      : source.kind === 'category'
        ? categoryCounts[source.category]
        : meta.count;
  const total = products?.length ?? expected;
  const { title, subtitle } = failed
    ? { title: '目录数据加载失败', subtitle: '按需加载的目录没有取到，可以重试' }
    : products === null
      ? { title: '正在加载目录…', subtitle: `目录共 ${expected} 件 · 按需加载，不进首屏` }
      : headingOf(source, total, shown.length, remaining);

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-label={title}
      className="absolute inset-0 z-30 flex flex-col bg-background"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-sidebar px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
            <LayoutGrid className="size-4 text-primary-ink" />
            {title}
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SortControl value={sort} onChange={setSort} />
          <Button variant="outline" size="sm" onClick={closeBrowse} className="gap-1.5">
            <X />
            退出浏览
          </Button>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="@container space-y-4 p-4 md:p-5">
          {failed ? (
            <EmptyState
              icon={DatabaseZap}
              title="目录数据加载失败"
              description="浏览视图的目录是按需加载的（不进首屏）。检查网络后重试，或退出浏览继续对话。"
            >
              <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                重试
              </Button>
            </EmptyState>
          ) : products === null ? (
            <div className="grid grid-cols-2 gap-3 @lg:grid-cols-3 @3xl:grid-cols-4">
              {Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={index}
                  className="overflow-hidden rounded-[var(--radius-lg)] bg-surface p-2 shadow-card"
                >
                  <Skeleton className="aspect-[4/3] w-full rounded-[var(--radius-md)]" />
                  <div className="space-y-2 px-1 pb-1 pt-3">
                    <Skeleton className="h-3.5 w-4/5" />
                    <Skeleton className="h-5 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : products.length === 0 ? (
            <EmptyState
              icon={PackageOpen}
              title="这里还没有商品"
              description="换一个品类，或退出浏览继续对话。"
            />
          ) : (
            <>
              <ProductGrid products={shown} />
              <div className="flex items-center justify-center pt-1">
                {remaining > 0 ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setVisible((n) => n + BROWSE_PAGE)}
                  >
                    加载更多（已显示 {shown.length}/{total}）
                  </Button>
                ) : (
                  <p className="text-[12px] text-muted-foreground">已显示全部 {total} 件</p>
                )}
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </section>
  );
}