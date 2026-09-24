'use client';

import { Table2 } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { ProductImage } from '@/components/product/product-image';
import { useAgentStore } from '@/store/use-agent-store';
import { useUiStore } from '@/store/use-ui-store';
import { cn } from '@/lib/utils';

/** 对比分析：多商品参数差异表，差异项标记、最优项高亮 */
export function CompareSection() {
  const comparison = useAgentStore((s) => s.snapshot?.comparison ?? null);
  const openProductDetail = useUiStore((s) => s.openProductDetail);

  if (!comparison || comparison.products.length < 2) {
    return (
      <EmptyState
        compact
        icon={Table2}
        title="未发起对比"
        description="勾选 2 - 4 件商品后点「发起对比」，或在对话里说「对比前 3 件」。"
      />
    );
  }

  const { products, rows } = comparison;

  return (
    <div className="space-y-2">
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-[1] min-w-[54px] bg-surface pb-2 pr-2 text-left align-bottom font-medium text-muted-foreground">
                参数
              </th>
              {products.map((product) => (
                <th key={product.id} className="min-w-[74px] px-1 pb-2 align-bottom">
                  <button
                    type="button"
                    onClick={() => openProductDetail(product.id)}
                    className="flex w-full flex-col items-center gap-1 text-center"
                  >
                    <ProductImage
                      src={product.image}
                      alt={product.name}
                      fallbackText={product.name}
                      className="size-9 rounded-[var(--radius-sm)]"
                    />
                    <span className="line-clamp-2 text-[10.5px] font-medium leading-4 text-foreground">
                      {product.name}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-border">
                <th className="sticky left-0 z-[1] min-w-[54px] bg-surface py-1.5 pr-2 text-left font-normal text-muted-foreground">
                  <span className="inline-flex items-center gap-1 whitespace-nowrap">
                    {row.diff && (
                      <span
                        aria-label="存在差异"
                        className="size-1.5 shrink-0 rounded-full bg-primary"
                      />
                    )}
                    {row.key}
                  </span>
                </th>
                {row.values.map((value, index) => (
                  <td
                    key={`${row.key}-${products[index]?.id ?? index}`}
                    className={cn(
                      'px-1 py-1.5 text-center leading-4',
                      row.best.includes(index)
                        ? 'rounded-[4px] bg-success-soft font-medium text-success'
                        : 'text-foreground',
                    )}
                  >
                    {value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        <span className="mr-1 inline-block size-1.5 rounded-full bg-primary align-middle" />
        标记为存在差异；绿色底为该维度最优
      </p>
    </div>
  );
}
