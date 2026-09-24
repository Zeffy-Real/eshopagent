'use client';

import { ProductImage } from '@/components/product/product-image';
import { RatingStars } from '@/components/product/rating-stars';
import { useUiStore } from '@/store/use-ui-store';
import type { Product } from '@/lib/types';
import { formatPrice } from '@/lib/utils';

export interface InlineProductCardProps {
  product: Product;
}

/** 对话区内联商品卡片：缩略图 + 名称 + 价格 + 评分，点击展开详情 */
export function InlineProductCard({ product }: InlineProductCardProps) {
  const openProductDetail = useUiStore((s) => s.openProductDetail);

  return (
    <button
      type="button"
      onClick={() => openProductDetail(product.id)}
      className="flex w-full items-center gap-2.5 rounded-[var(--radius-md)] border border-border bg-surface p-2 text-left transition-colors duration-150 hover:border-primary/40 hover:bg-primary-soft/40"
    >
      <ProductImage
        src={product.image}
        alt={product.name}
        fallbackText={product.name}
        className="size-11 shrink-0 rounded-[var(--radius-sm)]"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-foreground">
          {product.name}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className="text-[13px] font-semibold text-primary-ink">
            {formatPrice(product.price)}
          </span>
          <RatingStars rating={product.rating} size={10} />
        </span>
      </span>
    </button>
  );
}
