import { Badge } from '@/components/ui/badge';
import { STOCK_LABEL, stockLevelOf } from '@/lib/types';

const VARIANT = {
  in_stock: 'success',
  low: 'warning',
  out: 'danger',
} as const;

export interface StockBadgeProps {
  stock: number;
  className?: string;
}

/**
 * 库存状态标签：有货 / 库存紧张 / 缺货。
 *
 * 只展示**等级**，不展示件数：真实数据源里没有任何一件商品带真实库存件数
 * （只有 Shopee 有 stock 字段，而当前目录已无 Shopee 商品），目录里的件数
 * 全部由 `21 + hash % 480` 派生。把派生数字摆在用户面前与「真实数据」的
 * 定位自相矛盾，所以件数只作为内部可用性模型（缺货不可加购、加购上限）使用。
 */
export function StockBadge({ stock, className }: StockBadgeProps) {
  const level = stockLevelOf(stock);
  return (
    <Badge variant={VARIANT[level]} className={className}>
      {STOCK_LABEL[level]}
    </Badge>
  );
}
