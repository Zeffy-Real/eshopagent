import type { AgentStateUpdate, AgentStateValue } from '@/lib/agent/state';
import { createLogEntry } from '@/lib/agent/utils';
import { extractProfileSignals } from '@/lib/profile';
import { formatPrice } from '@/lib/utils';

/**
 * 订单确认节点（interrupt 恢复后执行）。
 *
 * 走到这里说明用户已经确认下单：把订单置为 confirmed 并清空购物车
 * （与真实电商一致——下单成功后购物车不再保留已购商品）。
 * 前端依据 pendingOrder.status === 'confirmed' 展示下单成功动画与订单号。
 */
export async function confirmOrderNode(
  state: AgentStateValue,
): Promise<AgentStateUpdate> {
  const startedAt = Date.now();
  const order = state.pendingOrder;
  if (!order) {
    return {
      toolCallLog: [
        createLogEntry({
          kind: 'node',
          name: 'confirmOrder',
          title: '没有待确认订单',
          detail: '请先在购物车中加入商品再结算',
          status: 'error',
          startedAt,
        }),
      ],
    };
  }

  const confirmed = { ...order, status: 'confirmed' as const };

  return {
    pendingOrder: confirmed,
    cart: [],
    // 画像信号：成交是权重最高的来源，只从**实际下单的商品**提取
    profilePatch: [
      ...state.profilePatch,
      ...extractProfileSignals({ kind: 'order', items: confirmed.items }),
    ],
    toolCallLog: [
      createLogEntry({
        kind: 'node',
        name: 'confirmOrder',
        title: `下单成功：${confirmed.id}`,
        detail: `${confirmed.items.length} 种商品，实付 ${formatPrice(confirmed.total)}，已清空购物车`,
        status: 'done',
        startedAt,
      }),
    ],
  };
}
