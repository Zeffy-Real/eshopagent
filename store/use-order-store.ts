'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { appendConfirmedOrder } from '@/lib/order-history';
import type { Order } from '@/lib/types';

/**
 * 订单历史（localStorage）。
 *
 * 为什么存客户端：项目没有账号体系，服务端存了也无法归属到人；订单的**事实源**仍是
 * 图状态里的 `pendingOrder`（`confirmOrder` 写回、随 SSE 快照下发），这里只是把
 * 「真实确认过的那一单」按 id 落一份可长期查看的列表 —— 与购物车存 localStorage 同构。
 *
 * 写入点只有一处：`store/use-agent-store.ts` 的 `applySnapshot`，当快照里的
 * `pendingOrder.status === 'confirmed'` 时调用 `recordOrder`。**不接受任何前端拼装的订单**。
 */
interface OrderState {
  /** 下单历史：最新在前，最多 `MAX_ORDER_HISTORY` 条 */
  orders: Order[];
  /** 记一条订单（幂等：只接受 confirmed，按 id upsert；内容未变时不触发 setState） */
  recordOrder: (order: Order) => void;
}

export const useOrderStore = create<OrderState>()(
  persist(
    (set, get) => ({
      orders: [],
      recordOrder: (order) => {
        const next = appendConfirmedOrder(get().orders, order);
        if (next !== get().orders) set({ orders: next });
      },
    }),
    {
      name: 'eshop-orders',
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      // 只持久化 orders：仓储里不存别的状态（会话级标记放在 use-agent-store）
      partialize: (state) => ({ orders: state.orders }),
    },
  ),
);