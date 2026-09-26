import type { Order } from '@/lib/types';

/** 历史最多保留的订单条数（localStorage 有配额，而每单都带着商品快照） */
export const MAX_ORDER_HISTORY = 20;

/**
 * 把一条**真实确认过**的订单并进历史（纯函数，幂等）。
 *
 * 规则（都有单测锁定）：
 * - 只接受 `status === 'confirmed'`：pending / cancelled 不是「下单记录」，直接返回原数组；
 * - 按 `id` upsert、**最新在前**：同一轮里快照会被推多次，确认之后的每一轮也还会带回
 *   同一个 `pendingOrder`，重复写入必须只有一条；同 id 再次出现时用新对象覆盖；
 * - 内容没变时返回**原数组引用**（`recordOrder` 据此跳过 setState，避免每轮快照都触发重渲染）；
 * - 超过上限从尾部（最旧）截断。
 */
export function appendConfirmedOrder(history: Order[], order: Order): Order[] {
  if (order.status !== 'confirmed') return history;

  const head = history[0];
  if (
    head &&
    head.id === order.id &&
    head.status === order.status &&
    head.total === order.total &&
    head.createdAt === order.createdAt
  ) {
    return history;
  }

  const rest = history.filter((item) => item.id !== order.id);
  return [order, ...rest].slice(0, MAX_ORDER_HISTORY);
}