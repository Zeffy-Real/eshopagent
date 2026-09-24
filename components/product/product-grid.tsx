'use client';

import { memo } from 'react';
import { AnimatePresence } from 'framer-motion';
import { ProductCard } from '@/components/product/product-card';
import type { Product } from '@/lib/types';

export interface ProductGridProps {
  products: Product[];
  /** 价格来自实时覆盖的商品 id 集合（用于在卡片上打「实时」标注） */
  liveIds?: ReadonlySet<string>;
  /** 实时拉取时刻（毫秒），配合 liveIds 使用 */
  liveAt?: number | null;
}

/**
 * 商品卡片网格。
 * 列数用「容器查询」而不是视口断点：中栏宽度取决于左右两栏是否展开，
 * 用视口断点会出现「800px 视口下 424px 宽的中栏硬塞 3 列」的挤压。
 */
function ProductGridBase({ products, liveIds, liveAt }: ProductGridProps) {
  return (
    <div className="grid grid-cols-2 gap-3 @lg:grid-cols-3 @3xl:grid-cols-4">
      <AnimatePresence initial={false} mode="popLayout">
        {products.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            liveAt={liveIds?.has(product.id) ? liveAt : null}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

export const ProductGrid = memo(ProductGridBase);
