'use client';

import { ReceiptText } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { Badge } from '@/components/ui/badge';
import { useOrderStore } from '@/store/use-order-store';
import { formatPrice } from '@/lib/utils';

/**
 * 订单历史（抽屉「订单历史」Tab 的内容）。
 *
 * 数据来源只有一个：`useOrderStore.orders` —— 由 `applySnapshot` 从 SSE 快照里的
 * `pendingOrder`（`confirmOrder` 的真实落单结果）幂等写入，**前端不拼装任何订单**。
 * 因此这里只做展示：订单号 / 时间 / 商品 / 实付 / 状态。
 */

/** 订单时间：本地时区、精确到分钟（ISO 字符串非法时原样显示） */
function formatOrderTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function OrderHistorySection() {
  const orders = useOrderStore((s) => s.orders);

  if (orders.length === 0) {
    return (
      <EmptyState
        compact
        icon={ReceiptText}
        title="还没有订单"
        description="在购物车里点「去结算」，并在确认弹窗里点「确认下单」后，订单会记在这里。"
      />
    );
  }

  return (
    <ul className="space-y-2">
      {orders.map((order) => (
        <li
          key={order.id}
          className="space-y-1.5 rounded-[var(--radius-md)] border border-border bg-surface p-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[11.5px] text-foreground">{order.id}</span>
            <Badge variant="success">已确认 · 待发货</Badge>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {formatOrderTime(order.createdAt)} · {order.items.length} 种商品
          </p>
          <ul className="space-y-0.5 text-[11.5px] text-muted-foreground">
            {order.items.map((item) => (
              <li key={item.product.id} className="flex items-baseline justify-between gap-2">
                <span className="truncate text-foreground/90">{item.product.name}</span>
                <span className="shrink-0 tabular-nums">× {item.quantity}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-border pt-1.5 text-[12px]">
            <span className="text-muted-foreground">实付</span>
            <span className="font-semibold text-primary-ink">{formatPrice(order.total)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}