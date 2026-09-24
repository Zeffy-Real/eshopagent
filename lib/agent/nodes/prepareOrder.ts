import { interrupt } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { AgentStateUpdate, AgentStateValue } from '@/lib/agent/state';
import { buildOrderDraft, generateOrderId } from '@/lib/agent/tools/cartTools';
import { createLogEntry } from '@/lib/agent/utils';
import { formatPrice } from '@/lib/utils';

/** 中断载荷：前端据此弹出订单确认弹窗 */
export interface OrderInterruptPayload {
  type: 'confirm_order';
  order: NonNullable<AgentStateValue['pendingOrder']>;
}

/**
 * 订单准备节点（human-in-the-loop 中断点）。
 *
 * interrupt() 会抛出中断信号，LangGraph 落一次 checkpoint 并暂停图执行；
 * 用户在前端确认后，用 Command({ resume }) 恢复，节点会从头重新执行，
 * interrupt() 这一次直接返回用户的决策值。
 *
 * 注意两个坑：
 * 1. 节点会被执行两次，所以订单号必须由 seed 确定性生成（见 generateOrderId）；
 * 2. interrupt() 之前节点不能靠 return 写状态（返回值会被丢弃），
 *    因此购物车与金额都在恢复之后才写入 pendingOrder。
 */
export async function prepareOrderNode(
  state: AgentStateValue,
  config?: RunnableConfig,
): Promise<AgentStateUpdate> {
  const startedAt = Date.now();
  const threadId = String(config?.configurable?.thread_id ?? 'default');
  // seed 需要同时满足两点：
  // 1. 节点重入（interrupt → resume）时保持一致 —— 否则弹窗里的单号与最终落单不一致；
  // 2. 同一会话的不同订单之间必须不同 —— 否则连下两单会撞号。
  // messages.length 在同一轮的两次执行中相同，跨轮会增长，正好满足两个约束。
  const seed = `${threadId}:${state.messages.length}:${state.cart
    .map((item) => `${item.product.id}x${item.quantity}`)
    .join(',')}`;

  const draft = buildOrderDraft(state.cart, { orderId: generateOrderId(seed) });
  if (!draft.ok) {
    return {
      pendingOrder: null,
      toolCallLog: [
        createLogEntry({
          kind: 'tool',
          name: 'create_order',
          title: '无法生成订单',
          detail: draft.message,
          status: 'error',
          startedAt,
        }),
      ],
    };
  }

  const decision = interrupt<OrderInterruptPayload, string>({
    type: 'confirm_order',
    order: draft.order,
  });

  if (decision === 'confirm') {
    return {
      pendingOrder: draft.order,
      toolCallLog: [
        createLogEntry({
          kind: 'tool',
          name: 'create_order',
          title: `订单已确认：${draft.order.id}`,
          detail: `${draft.order.items.length} 种商品，实付 ${formatPrice(draft.order.total)}`,
          status: 'done',
          startedAt,
        }),
      ],
    };
  }

  return {
    pendingOrder: null,
    toolCallLog: [
      createLogEntry({
        kind: 'tool',
        name: 'create_order',
        title: '已取消下单',
        detail: '购物车内容保持不变，可继续调整后再结算',
        status: 'done',
        startedAt,
      }),
    ],
  };
}
