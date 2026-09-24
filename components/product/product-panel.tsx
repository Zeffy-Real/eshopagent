'use client';

import { useMemo, useState } from 'react';
import { Database, GitCompareArrows, Package, SearchX, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { EmptyState } from '@/components/common/empty-state';
import { PanelHeader } from '@/components/common/panel-header';
import { CategoryBar } from '@/components/product/category-bar';
import { ProductDetailDialog } from '@/components/product/product-detail-dialog';
import { ProductGrid } from '@/components/product/product-grid';
import { SortControl } from '@/components/product/sort-control';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CATALOG_META, getFeaturedProducts, getProductById } from '@/lib/catalog/products';
import type { Product, SortKey } from '@/lib/types';
import { useAgentStore } from '@/store/use-agent-store';
import { useUiStore } from '@/store/use-ui-store';

const FEATURED = getFeaturedProducts(12);

function sortProducts(products: Product[], sort: SortKey): Product[] {
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

export function ProductPanel() {
  const [sort, setSort] = useState<SortKey>('relevance');
  const snapshot = useAgentStore((s) => s.snapshot);
  const thinking = useAgentStore((s) => s.thinking);
  const compareSelection = useAgentStore((s) => s.compareSelection);
  const detailProductId = useUiStore((s) => s.detailProductId);
  const closeProductDetail = useUiStore((s) => s.closeProductDetail);
  const compareIds = useUiStore((s) => s.compareIds);
  const clearCompare = useUiStore((s) => s.clearCompare);

  const searched = snapshot !== null && snapshot.searchResults.length > 0;
  const hasFilters =
    snapshot !== null && Object.keys(snapshot.searchFilters).length > 1;

  const products = useMemo(() => {
    const base = searched ? snapshot.searchResults : FEATURED;
    return sortProducts(base, sort);
  }, [searched, snapshot, sort]);

  const detailProduct = detailProductId ? getProductById(detailProductId) ?? null : null;
  const condition = snapshot && hasFilters ? snapshot.conditionText : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        icon={Package}
        title={searched ? '搜索结果' : '为你推荐'}
        subtitle={
          searched
            ? `${snapshot.searchResults.length} 件商品${condition ? ` · ${condition}` : ''}`
            : '默认展示高评分、高销量商品'
        }
        className="bg-sidebar"
        status={
          <span className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="neutral" className="gap-1">
                  <Database className="size-2.5" />
                  {CATALOG_META.source === 'real' ? '真实数据' : '演示数据'}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                {CATALOG_META.provider} · {CATALOG_META.count} 件商品
                {CATALOG_META.generatedAt
                  ? ` · 快照于 ${CATALOG_META.generatedAt.slice(0, 10)}`
                  : ''}
                {CATALOG_META.note ? `\n${CATALOG_META.note}` : ''}
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
            <ProductGrid products={products} />
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

      {/* 对比选择操作条 */}
      <AnimatePresence>
        {compareIds.length >= 2 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-4 py-2.5"
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
        open={detailProductId !== null}
        onOpenChange={(open) => {
          if (!open) closeProductDetail();
        }}
      />
    </div>
  );
}
