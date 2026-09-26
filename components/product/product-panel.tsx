'use client';

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Database, GitCompareArrows, Package, SearchX, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { EmptyState } from '@/components/common/empty-state';
import { PanelHeader } from '@/components/common/panel-header';
import { ProductDetailDialog } from '@/components/product/product-detail-dialog';
import { CategoryBar } from '@/components/product/category-bar';
import { ProductGrid } from '@/components/product/product-grid';
import { SortControl } from '@/components/product/sort-control';
import { useCatalogData } from '@/components/providers/catalog-data-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SEARCH_RESULT_ID_LIMIT, SEARCH_RESULT_LIMIT } from '@/lib/agent/events';
import { loadBrowseProducts } from '@/lib/catalog/browse-products';
import {
  recallResolvedProduct,
  rememberResolvedProducts,
  resolveDetailProduct,
} from '@/lib/catalog/client-products';
import { applyLiveOverride } from '@/lib/justoneapi/overrides';
import {
  applyServerOrder,
  EXPAND_PAGE_SIZE,
  expansionPlanOf,
  expansionViewOf,
  needsFullSetForSort,
  productPanelStateOf,
  sortProducts,
} from '@/lib/product-panel-state';
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

  /**
   * 中栏**就地展开**（2026-09-26）：把「展示集」从 Agent 的工作集里拆出来。
   *
   * 边界：`searchResults` 是 Agent 的工作集（SSE 快照 / 回复上下文 / 金额核对 / 对比 /
   * 内联卡都在消费它），**不为了多展示放大它**、也不改它的长度。多出来的部分由客户端
   * 按需解析（`loadBrowseProducts`，与浏览视图同一个目录 chunk，不进 SSE）：
   * 有筛选条件 → 本轮下发的命中 id（≤120）在目录里查；无筛选条件 → 整个目录（420）现算。
   *
   * 三层状态：
   * - `plan`：这一轮能追加什么、追加到几件为止（纯函数，见 lib/product-panel-state.ts）；
   * - `visible`：已展开到的条数（默认 = 首屏 `SEARCH_RESULT_LIMIT` 件）；
   * - `expanded`：客户端算出的完整集（未加载 / 加载失败为 null → 回落首屏 12 件）。
   *
   * ⚠️ 收口（同轮）：面板头原先的「查看全部 N 件 →」入口已删（连同 `PanelHeader` 的
   * `subtitleAction` 槽位）—— 展开就在本栏完成，不再换视图；浏览视图只剩目录浏览两条来源。
   */
  const plan = useMemo(() => expansionPlanOf(snapshot), [snapshot]);
  const [expanded, setExpanded] = useState<Product[] | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [expandError, setExpandError] = useState(false);
  const [visible, setVisible] = useState(SEARCH_RESULT_LIMIT);

  /**
   * 本轮结果的指纹：SSE 一轮 4–5 帧会换新对象，但同一轮的结果内容不变 —— 用内容做键，
   * 才不会在帧与帧之间把用户已展开的窗口折叠回 12 件；新一轮检索（内容变了）则重置。
   */
  const resultKey = [
    snapshot?.intent ?? '',
    snapshot?.searchTotal ?? 0,
    snapshot?.searchResultIds.join(',') ?? '',
    snapshot?.searchResults.map((product) => product.id).join(',') ?? '',
  ].join('|');
  /** 最新一轮的指纹：异步加载回来时用它判断「我这份结果还算不算数」 */
  const roundRef = useRef(resultKey);

  useEffect(() => {
    roundRef.current = resultKey;
    setExpanded(null);
    setExpanding(false);
    setExpandError(false);
    setVisible(SEARCH_RESULT_LIMIT);
  }, [resultKey]);

  /** 服务端这一轮的结果顺序（无筛选 → 评分→销量；也用于「按价格从低到高」这类条件） */
  const serverSort = snapshot?.searchFilters.sort;

  /**
   * 追加数据的统一加载路径（排序前的载入也走这里，不新增第二条）。
   * 失败返回 null：**保留已显示的首屏 12 件**，界面上只多一行「更多结果加载失败 + 重试」。
   */
  const loadFull = useCallback(async (): Promise<Product[] | null> => {
    if (!plan || expanding) return null;
    const round = roundRef.current;
    setExpanding(true);
    setExpandError(false);
    const list = await loadBrowseProducts(plan.source);
    // 新一轮已经到达：丢掉这次结果，避免把上一轮的列表挂到新结果上
    if (roundRef.current !== round) return null;
    setExpanding(false);
    if (list === null) {
      setExpandError(true);
      return null;
    }
    // 目录顺序 ≠ 检索顺序（无筛选 → 评分→销量），对齐后 `expanded` 的前 12 件
    // 才与服务端下发的 `searchResults` 逐件一致（否则展开会让前 12 件变样）
    const ordered = plan.source.kind === 'all' ? applyServerOrder(list, serverSort) : list;
    setExpanded(ordered);
    return ordered;
  }, [plan, expanding, serverSort]);

  /**
   * 「加载更多」：首屏之外的点一次追加一屏（`EXPAND_PAGE_SIZE`），直到该轮可得上限。
   * 完整集未加载时先加载 —— 加载成功才推进窗口（失败则停在已显示的 12 件）。
   */
  const handleLoadMore = useCallback(() => {
    if (!plan) return;
    if (expanded) {
      setVisible((count) => count + EXPAND_PAGE_SIZE);
      return;
    }
    void loadFull().then((list) => {
      if (list) setVisible((count) => count + EXPAND_PAGE_SIZE);
    });
  }, [plan, expanded, loadFull]);

  /**
   * 排序必须作用于**完整结果集**：完整集尚未载入时先载入再排（`needsFullSetForSort`），
   * 否则「按价格排」只排了 12 件 —— 第 13 件起更便宜的还藏着，那是假象。
   * 载入期间先不重排（见下面的 `awaitingFullSet`），避免中途给出「已排好」的错顺序。
   */
  const handleSort = useCallback(
    (next: SortKey) => {
      setSort(next);
      if (needsFullSetForSort(next, expanded !== null, plan)) void loadFull();
    },
    [expanded, plan, loadFull],
  );

  const awaitingFullSet = needsFullSetForSort(sort, expanded !== null, plan);

  // 实时覆盖：只在**展示层**套用（价格/库存等级），排序仍按快照值走——
  // 「不改筛选 / 排序 / 推荐」这条边界不能因为多了实时价就被打破。
  const liveOverrides = snapshot?.liveOverrides;
  const liveAt = snapshot?.liveFetchedAt ?? null;
  const liveIds = useMemo(
    () => new Set(Object.keys(liveOverrides ?? {})),
    [liveOverrides],
  );

  /**
   * 中栏实际渲染的窗口（单一实现）：搜索结果走就地展开（未加载 / 失败回落首屏 12 件），
   * 其余态（为你推荐）仍渲染首屏精选。
   */
  const view = useMemo(() => {
    if (hasResults && snapshot) {
      return expansionViewOf({
        sseResults: snapshot.searchResults,
        expanded,
        visible,
        // 完整集没载入时先按服务端顺序显示（不排那 12 件，避免「只排了 12 件」的假象）
        sort: awaitingFullSet ? 'relevance' : sort,
        ceiling: plan?.ceiling ?? snapshot.searchResults.length,
      });
    }
    const list = sortProducts(featured, sort);
    return { products: list, shown: list.length, remaining: 0 };
  }, [hasResults, snapshot, expanded, visible, sort, awaitingFullSet, plan, featured]);

  const products = useMemo(
    () => view.products.map((product) => applyLiveOverride(product, liveOverrides)),
    [view, liveOverrides],
  );

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
   * 「件数对不上」的澄清（2026-09-26）：面板里的 420 是**目录总量**，而中栏首屏只给
   * `SEARCH_RESULT_LIMIT` 件（点「加载更多」随时间增长，见就地展开）—— 所以命中数大于
   * **当前展示数**时必须把两个数字都写出来（「共 30 件 · 展示前 24 件」），否则用户会把
   * 展示条数当成命中的总数；全都显示出来时不写「展示前 N 件」（避免「共 3 件 · 展示前 3 件」）。
   */
  const shownCount = view.shown;
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
        actions={<SortControl value={sort} onChange={handleSort} />}
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
            <>
              <ProductGrid products={products} liveIds={liveIds} liveAt={liveAt} />
              {/* 就地展开的收尾行（只在本轮确实有「没显示出来的部分」时出现）。
                  失败态**不动已显示的 12 件**：只加一行说明 + 重试。 */}
              {hasResults && plan && (
                <div className="flex flex-col items-center gap-2 pt-1">
                  {expandError ? (
                    <>
                      <p className="text-[12px] text-muted-foreground">
                        更多结果加载失败{awaitingFullSet ? ' · 排序需要完整结果集' : ''}
                      </p>
                      <Button variant="secondary" size="sm" onClick={handleLoadMore}>
                        重试
                      </Button>
                    </>
                  ) : view.remaining > 0 ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={expanding}
                      onClick={handleLoadMore}
                    >
                      {expanding
                        ? '正在加载…'
                        : `加载更多（已显示 ${view.shown}/${plan.ceiling}）`}
                    </Button>
                  ) : plan.truncated ? (
                    <p className="text-[12px] text-muted-foreground">
                      已显示前 {plan.ceiling} 件（单次上限 {SEARCH_RESULT_ID_LIMIT} 件）
                    </p>
                  ) : (
                    <p className="text-[12px] text-muted-foreground">
                      已显示全部 {plan.ceiling} 件
                    </p>
                  )}
                </div>
              )}
            </>
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

      {/* 浏览视图（覆盖层，按需 chunk）：**只用于无对话时的目录浏览**（品类 chip / 看全量），
          数据走客户端目录的按需 chunk —— 零 LLM 依赖，不碰 SSE。
          搜索结果的展开在中栏就地完成（上面的「加载更多」），不再进入本视图。
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
