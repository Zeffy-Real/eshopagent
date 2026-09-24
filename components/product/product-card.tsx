'use client';

import { memo } from 'react';
import { Check, GitCompareArrows, Plus } from 'lucide-react';
import { motion } from 'framer-motion';
import { ProductImage } from '@/components/product/product-image';
import { RatingStars } from '@/components/product/rating-stars';
import { StockBadge } from '@/components/product/stock-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAgentStore } from '@/store/use-agent-store';
import { useCartStore } from '@/store/use-cart-store';
import { MAX_COMPARE, useUiStore } from '@/store/use-ui-store';
import { STOCK_LABEL, stockLevelOf, type Product } from '@/lib/types';
import { cn, discountLabel, formatCount, formatPrice, hasRealSales } from '@/lib/utils';

export interface ProductCardProps {
  product: Product;
}

function ProductCardBase({ product }: ProductCardProps) {
  const openProductDetail = useUiStore((s) => s.openProductDetail);
  const compareIds = useUiStore((s) => s.compareIds);
  const toggleCompare = useUiStore((s) => s.toggleCompare);
  const addItem = useCartStore((s) => s.addItem);
  // Agent 执行期间服务端会用状态里的购物车覆盖本地，此时改购物车会被静默丢弃
  const thinking = useAgentStore((s) => s.thinking);

  const off = discountLabel(product.price, product.originalPrice);
  const level = stockLevelOf(product.stock);
  const inCompare = compareIds.includes(product.id);
  const compareFull = compareIds.length >= MAX_COMPARE && !inCompare;
  const soldOut = level === 'out';

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="group flex flex-col overflow-hidden rounded-[var(--radius-lg)] bg-surface shadow-card transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-raised"
    >
      <button
        type="button"
        onClick={() => openProductDetail(product.id)}
        aria-label={`查看 ${product.name} 详情`}
        className="relative block aspect-[4/3] w-full overflow-hidden bg-surface-muted"
      >
        <ProductImage
          src={product.image}
          alt={product.name}
          fallbackText={product.name}
          className="size-full transition-transform duration-300 group-hover:scale-[1.04]"
        />
        <span className="absolute left-2 top-2 flex items-center gap-1">
          {off && <Badge variant="danger">{off}</Badge>}
        </span>
        <span className="absolute right-2 top-2">
          <StockBadge stock={product.stock} className="bg-surface/95 backdrop-blur-[1px]" />
        </span>
      </button>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <button
          type="button"
          onClick={() => openProductDetail(product.id)}
          className="line-clamp-2 text-left text-[13px] font-medium leading-5 text-foreground transition-colors hover:text-primary-ink"
        >
          {product.name}
        </button>

        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {product.rating > 0 ? (
            <>
              <RatingStars rating={product.rating} />
              <span className="font-medium text-foreground">{product.rating}</span>
            </>
          ) : (
            <span>暂无评分</span>
          )}
          <span className="text-border-strong">|</span>
          {/* 来源没有销量字段时改展示真实评价数，而不是把 0 当成销量 */}
          <span>
            {hasRealSales(product.sales)
              ? `销量 ${formatCount(product.sales)}`
              : `评价 ${formatCount(product.reviews)} 条`}
          </span>
        </div>

        <div className="mt-auto flex items-end justify-between gap-2 pt-1">
          <div className="min-w-0">
            <p className="text-[16px] font-semibold leading-6 text-primary-ink">
              {formatPrice(product.price)}
            </p>
            {product.originalPrice > product.price && (
              <p className="text-[11px] leading-4 text-muted-foreground line-through">
                {formatPrice(product.originalPrice)}
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={inCompare ? 'primary' : 'secondary'}
                  size="icon-sm"
                  aria-label={inCompare ? '取消对比' : '加入对比'}
                  aria-pressed={inCompare}
                  disabled={compareFull}
                  onClick={() => toggleCompare(product.id)}
                  className={cn(compareFull && 'cursor-not-allowed')}
                >
                  {inCompare ? <Check /> : <GitCompareArrows />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {inCompare
                  ? '取消对比'
                  : compareFull
                    ? `最多对比 ${MAX_COMPARE} 件商品`
                    : '加入对比'}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  aria-label={`将 ${product.name} 加入购物车`}
                  disabled={soldOut || thinking}
                  onClick={() => addItem(product)}
                  className="transition-transform active:scale-90"
                >
                  <Plus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {soldOut
                  ? `${STOCK_LABEL[level]}，无法加购`
                  : thinking
                    ? 'Agent 正在执行，稍后再加购'
                    : '加入购物车'}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </motion.article>
  );
}

export const ProductCard = memo(ProductCardBase);
