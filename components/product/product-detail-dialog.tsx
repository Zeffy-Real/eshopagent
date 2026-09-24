'use client';

import { Check, GitCompareArrows, Plus, ShieldCheck, Truck } from 'lucide-react';
import { ProductImage } from '@/components/product/product-image';
import { RatingStars } from '@/components/product/rating-stars';
import { StockBadge } from '@/components/product/stock-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useCartStore } from '@/store/use-cart-store';
import { useUiStore } from '@/store/use-ui-store';
import { stockLevelOf, type Product } from '@/lib/types';
import { discountLabel, formatCount, formatPrice, hasRealSales } from '@/lib/utils';

export interface ProductDetailDialogProps {
  product: Product | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 商品详情弹窗：规格参数 + 加购 + 加入对比 */
export function ProductDetailDialog({
  product,
  open,
  onOpenChange,
}: ProductDetailDialogProps) {
  const addItem = useCartStore((s) => s.addItem);
  const compareIds = useUiStore((s) => s.compareIds);
  const toggleCompare = useUiStore((s) => s.toggleCompare);

  if (!product) return null;

  const off = discountLabel(product.price, product.originalPrice);
  const soldOut = stockLevelOf(product.stock) === 'out';
  const inCompare = compareIds.includes(product.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(760px,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle className="pr-8">{product.name}</DialogTitle>
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
            <Badge variant="neutral">{product.category}</Badge>
            <span>{product.brand}</span>
            <span className="text-border-strong">|</span>
            {/* 没有真实销量来源时不展示销量（避免与下面的评价数重复，也避免展示编造值） */}
            {hasRealSales(product.sales) && (
              <>
                <span>销量 {formatCount(product.sales)}</span>
                <span className="text-border-strong">|</span>
              </>
            )}
            <span>{formatCount(product.reviews)} 条评价</span>
          </div>
        </DialogHeader>

        <ScrollArea className="max-h-[62vh]">
          <div className="grid gap-5 p-5 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
            <div className="space-y-3">
              <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface-muted">
                <ProductImage
                  src={product.image}
                  alt={product.name}
                  fallbackText={product.name}
                  className="aspect-[4/3] w-full"
                />
              </div>
              <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                {product.rating > 0 ? (
                  <>
                    <RatingStars rating={product.rating} size={13} />
                    <span className="font-medium text-foreground">{product.rating}</span>
                    <span>分</span>
                  </>
                ) : (
                  <span>暂无评分</span>
                )}
              </div>
              <div className="space-y-1.5 rounded-[var(--radius-md)] border border-border bg-surface-muted/50 p-2.5 text-[12px] text-muted-foreground">
                <p className="flex items-center gap-1.5">
                  <Truck className="size-3.5" />
                  现价合计满 99 元包邮
                </p>
                <p className="flex items-center gap-1.5">
                  <ShieldCheck className="size-3.5" />
                  7 天无理由退换（演示数据）
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-[var(--radius-md)] border border-border bg-surface p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <span className="text-[26px] font-semibold leading-8 text-primary-ink">
                    {formatPrice(product.price)}
                  </span>
                  {product.originalPrice > product.price && (
                    <span className="pb-1 text-[13px] text-muted-foreground line-through">
                      {formatPrice(product.originalPrice)}
                    </span>
                  )}
                  {off && <Badge variant="danger">{off}</Badge>}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <StockBadge stock={product.stock} />
                  {product.stock > 0 && hasRealSales(product.sales) && (
                    <span className="text-[12px] text-muted-foreground">
                      已售 {formatCount(product.sales)}
                    </span>
                  )}
                </div>
              </div>

              <p className="text-[13px] leading-6 text-foreground/90">{product.description}</p>

              <div className="flex flex-wrap gap-1.5">
                {product.tags.map((tag) => (
                  <Badge key={tag} variant="primary">
                    {tag}
                  </Badge>
                ))}
              </div>

              <div>
                <h4 className="mb-2 text-[13px] font-semibold text-foreground">规格参数</h4>
                <dl className="divide-y divide-border overflow-hidden rounded-[var(--radius-md)] border border-border">
                  {Object.entries(product.specifications).map(([key, value]) => (
                    <div key={key} className="flex gap-3 px-3 py-2 text-[12px]">
                      <dt className="w-24 shrink-0 text-muted-foreground">{key}</dt>
                      <dd className="min-w-0 flex-1 text-foreground">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </div>
        </ScrollArea>

        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          <Button
            variant={inCompare ? 'primary' : 'secondary'}
            onClick={() => toggleCompare(product.id)}
            className="gap-1.5"
          >
            {inCompare ? <Check /> : <GitCompareArrows />}
            {inCompare ? '已加入对比' : '加入对比'}
          </Button>
          <Button
            disabled={soldOut}
            onClick={() => addItem(product)}
            className="ml-auto gap-1.5 transition-transform active:scale-[0.97]"
          >
            <Plus />
            {soldOut ? '暂时缺货' : `加入购物车 · ${formatPrice(product.price)}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
