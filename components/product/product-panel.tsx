'use client';

import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Database, GitCompareArrows, Package, SearchX, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { EmptyState } from '@/components/common/empty-state';
import { PanelHeader } from '@/components/common/panel-header';
import { ProductDetailDialog } from '@/components/product/product-detail-dialog';
import { CategoryBar } from '@/components/product/category-bar';
import { ProductGrid } from '@/components/product/product-grid';
import { SortControl, sortProducts } from '@/components/product/sort-control';
import { useCatalogData } from '@/components/providers/catalog-data-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  recallResolvedProduct,
  rememberResolvedProducts,
  resolveDetailProduct,
} from '@/lib/catalog/client-products';
import { applyLiveOverride } from '@/lib/justoneapi/overrides';
import { hasEffectiveFilters, isSearchIntent, productPanelStateOf } from '@/lib/product-panel-state';
import type { BrowseSource } from '@/lib/catalog/browse-products';
import type { Product, SortKey } from '@/lib/types';
import { useAgentStore } from '@/store/use-agent-store';
import { useUiStore } from '@/store/use-ui-store';

/**
 * 浏览视图按需加载：**先点开才下载它的 chunk**（组件只有 `browseSource` 非空时才挂载）。
 * 这样「中栏浏览」既不进首屏 bundle，也不在页面加载时白下载 —— 与目录 chunk 同一套思路。
 * 用 React 自带的 `lazy` 而不是 `next/dynamic`：后者会把它的运行时也带进首屏（实测 +2 kB）。
 */
const BrowseView = lazy(() =>
  import('@/components/product/browse-view').then((module) => ({ default: module.BrowseView })),
);

/** 按需 chunk 加载期间的占位（与视图同尺寸的中栏覆盖层，不是空白） */
function BrowseViewLoading() {
  return (
    <section
      aria-label="正在打开浏览视图"
      className="absolute inset-0 z-30 flex items-center justify-center bg-background"
    >
      <p className="text-[12px] text-muted-foreground">正在打开浏览视图…</p>
    </section>
  );
}

export function ProductPanel() {
  const [sort, setSort] = useState<SortKey>('relevance');
  const snapshot = useAgentStore((s) => s.snapshot);
  const thinking = useAgentStore((s) => s.thinking);
  const compareSelection = useAgentStore((s) => s.compareSelection);
  // 首屏推荐与目录元信息都由服务端注入（客户端不再 import 服务端目录模块）
  const { meta, featured } = useCatalogData();
  const detailProductId = useUiStore((s) => s.detailProductId);
  const closeProductDetail = useUiStore((s) => s.closeProductDetail);
  const compareIds = useUiStore((s) => s.compareIds);
  const clearCompare = useUiStore((s) => s.clearCompare);
  // 浏览视图是否打开：只订阅布尔值（打开时才挂载按需 chunk 的组件）
  const browseOpen = useUiStore((s) => s.browseSource !== null);
  const openBrowse = useUiStore((s) => s.openBrowse);

  /**
   * 「查看全部 N 件」入口的数据来源（2026-09-26）。
   *
   * 两个门挡：本轮必须是**搜索类意图**（闲聊 / 加购 / 对比轮不出现入口 —— 那些轮次的
   * searchTotal 是上一轮的历史值），且命中数**多于**展示数（没有藏起来的部分就不需要入口）。
   *
   * 来源二选一，与服务端 `searchProducts` 的写入口径**同源**（`hasEffectiveFilters`）：
   * - 无有效筛选条件（如「看看所有商品」命中 420）→ 客户端目录全量，420 个 id 不进 SSE；
   * - 有筛选条件（如「图书 · 小说」命中 30）→ 本轮下发的命中 id 列表（上限 120）。
   */
  const browseAllSource: BrowseSource | null = useMemo(() => {
    if (!snapshot || !isSearchIntent(snapshot.intent)) return null;
    if (snapshot.searchTotal <= snapshot.searchResults.length) return null;
    if (!hasEffectiveFilters(snapshot.searchFilters)) return { kind: 'all' };
    return snapshot.searchResultIds.length > 0
      ? { kind: 'ids', ids: snapshot.searchResultIds, total: snapshot.searchTotal }
      : null;
  }, [snapshot]);

  // 三态（唯一判据在 lib/product-panel-state.ts）：搜索结果 / 搜索无结果 / 为你推荐。
  // 「搜索类意图 + 0 命中」原先会静默回落成推荐位，用户分不清「没搜到」还是「被当成闲聊」；
  // 闲聊轮回落推荐是刻意行为，没有改。
  const panelState = productPanelStateOf({
    intent: snapshot?.intent ?? null,
    total: snapshot?.searchTotal ?? 0,
    shown: snapshot?.searchResults.length ?? 0,
  });
  const hasResults = panelState === 'results';
  const emptySearch = panelState === 'empty-search';
  const searched = hasResults || emptySearch;
  const hasFilters =
    snapshot !== null && Object.keys(snapshot.searchFilters).length > 1;

  // 实时覆盖：只在**展示层**套用（价格/库存等级），排序仍按快照值走——
  // 「不改筛选 / 排序 / 推荐」这条边界不能因为多了实时价就被打破。
  const liveOverrides = snapshot?.liveOverrides;
  const liveAt = snapshot?.liveFetchedAt ?? null;
  const liveIds = useMemo(
    () => new Set(Object.keys(liveOverrides ?? {})),
    [liveOverrides],
  );

  const products = useMemo(() => {
    const base = hasResults && snapshot ? snapshot.searchResults : featured;
    return sortProducts(base, sort).map((product) =>
      applyLiveOverride(product, liveOverrides),
    );
  }, [hasResults, snapshot, sort, liveOverrides, featured]);

  // 渲染过的商品记进会话缓存：详情弹窗按 id 复用。列表随检索变化时（含回复流中途更新），
  // 已打开弹窗的那件商品仍在缓存里，不会因为「列表换掉了」而解析不到。
  useEffect(() => {
    rememberResolvedProducts(products);
  }, [products]);

  // 详情弹窗的商品来自调用方（弹窗组件本身就是 `product: Product | null` 签名），不再从目录反查：
  // 解析顺序 = 当前渲染的列表（已是叠加过实时覆盖的对象）→ 会话内已解析过的内联卡商品。
  // 「从哪张卡片点开就显示哪张卡片的商品」，实时价与「实时 · HH:mm」标注因此不会在弹窗里丢失。
  const lookup = useCallback(
    (id: string) => products.find((product) => product.id === id) ?? recallResolvedProduct(id),
    [products],
  );
  const detailProduct = useMemo(
    () => resolveDetailProduct(detailProductId, lookup, liveOverrides),
    [detailProductId, lookup, liveOverrides],
  );
  const condition = snapshot && hasFilters ? snapshot.conditionText : null;

  /**
   * 中栏副标题的展示口径（单一处实现）。
   *
   * 「件数对不上」的澄清（2026-09-26）：面板里的 420 是**目录总量**，而中栏单次最多展示
   * `SEARCH_RESULT_LIMIT` 件 —— 所以命中数大于展示数时必须把两个数字都写出来
   * （「共 30 件 · 展示前 12 件」），否则用户会把展示条数当成命中的总数；
   * 命中数不多时不写「展示前 N 件」（避免「共 3 件 · 展示前 12 件」这种废话）。
   */
  const shownCount = snapshot?.searchResults.length ?? 0;
  const hitCount = snapshot?.searchTotal ?? 0;
  const resultLabel =
    hitCount > shownCount
      ? `共 ${hitCount} 件 · 展示前 ${shownCount} 件`
      : `${shownCount} 件商品`;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PanelHeader
        icon={Package}
        title={
          emptySearch
            ? '没有找到符合条件的商品'
            : hasResults
              ? '搜索结果'
              : '为你推荐'
        }
        subtitle={
          emptySearch
            ? '试试放宽条件（价格 / 品类），或看看下面的推荐'
            : hasResults
              ? `${resultLabel}${condition ? ` · ${condition}` : ''}`
              : `目录共 ${meta.count} 件 · 按评分与销量精选 ${featured.length} 件`
        }
        subtitleAction={
          browseAllSource && (
            <Button
              variant="link"
              onClick={() => openBrowse(browseAllSource)}
              className="h-auto gap-0.5 p-0 text-[12px] font-medium [&_svg]:size-3"
            >
              查看全部 {snapshot?.searchTotal} 件
              <ArrowRight />
            </Button>
          )
        }
        className="bg-sidebar"
        status={
          <span className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="neutral" className="gap-1">
                  <Database className="size-2.5" />
                  {meta.source === 'real' ? '真实数据' : '演示数据'}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                {meta.provider} · 目录共 {meta.count} 件
                {meta.generatedAt ? ` · 快照于 ${meta.generatedAt.slice(0, 10)}` : ''}
                {meta.note ? `\n${meta.note}` : ''}
              </TooltipContent>
            </Tooltip>
            {snapshot?.llmEnabled === false && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="warning" className="gap-1">
                    <Sparkles className="size-2.5" />
                    规则兜底
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>未配置 LLM，意图解析与回复走规则与模板</TooltipContent>
              </Tooltip>
            )}
          </span>
        }
        actions={<SortControl value={sort} onChange={setSort} />}
      />

      <CategoryBar />

      <ScrollArea className="min-h-0 flex-1">
        <div className="@container space-y-4 p-4 md:p-5">
          {!searched && !thinking && (
            <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Sparkles className="size-3.5" />
              在左侧对话区描述需求后，这里会展示检索结果
            </p>
          )}

          {/* 搜索无结果：不空白页，下方仍给精选推荐（标题与说明已在面板头部写明） */}
          {emptySearch && (
            <p className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
              <Sparkles className="size-3.5" />
              为你推荐
            </p>
          )}

          {thinking && !searched ? (
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
          ) : products.length > 0 ? (
            <ProductGrid products={products} liveIds={liveIds} liveAt={liveAt} />
          ) : (
            <EmptyState
              icon={SearchX}
              title="没有找到符合条件的商品"
              description={
                condition
                  ? `当前条件：${condition}。可以放宽预算、换品类，或说「再便宜一点的」让我自动调整。`
                  : '换个说法试试，例如「500 元以内、透气、适合夜跑的跑鞋」。'
              }
            />
          )}
        </div>
      </ScrollArea>

      {/* 浏览视图（覆盖层，按需 chunk）：品类 chip / 「查看全部 N 件」共用同一个组件，
          数据走客户端目录的按需 chunk —— 零 LLM 依赖，不碰 SSE。
          只有真正打开时才挂载（否则连它的 chunk 都不下载）。
          放在对比条之前渲染；对比条带 z-40，选中商品后操作条仍浮在覆盖层之上 */}
      {browseOpen && (
        <Suspense fallback={<BrowseViewLoading />}>
          <BrowseView />
        </Suspense>
      )}

      {/* 对比选择操作条 */}
      <AnimatePresence>
        {compareIds.length >= 2 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="relative z-40 flex shrink-0 items-center gap-2 border-t border-border bg-surface px-4 py-2.5"
          >
            <GitCompareArrows className="size-4 shrink-0 text-primary-ink" />
            <p className="text-[13px] text-foreground">
              已选 <span className="font-semibold text-primary-ink">{compareIds.length}</span> 件
              <span className="text-muted-foreground"> · 最多 4 件</span>
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearCompare}
              className="ml-auto text-muted-foreground"
            >
              清空
            </Button>
            <Button
              size="sm"
              disabled={thinking}
              onClick={() => void compareSelection()}
              className="gap-1.5"
            >
              发起对比
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      <ProductDetailDialog
        product={detailProduct}
        liveAt={detailProduct && liveIds.has(detailProduct.id) ? liveAt : null}
        open={detailProductId !== null}
        onOpenChange={(open) => {
          if (!open) closeProductDetail();
        }}
      />
    </div>
  );
}
