import { filterProducts } from '@/lib/agent/tools/productTools';
import { getProductById } from '@/lib/catalog/products';
import { describeFilters } from '@/lib/agent/ruleParser';
import type { AgentStateUpdate, AgentStateValue } from '@/lib/agent/state';
import { createLogEntry } from '@/lib/agent/utils';
import { formatPrice } from '@/lib/utils';

/** 单次检索返回的最大商品数（中栏网格一屏可展示的数量） */
export const SEARCH_LIMIT = 12;

/**
 * 商品检索节点。
 *
 * 直接调用工具层的纯函数 filterProducts（强类型、可单测），
 * 结果写入 searchResults；命中为空时置 needsRefine=true，
 * 由条件边交给 refineSearch 放宽条件后再检索一次。
 *
 * 另外负责消费 `focusProductId`（序数指代的产物，见 AgentState 的注释）：
 * 「换成第二件」这类输入不该重新检索，而是把结果收窄到指定的那一件。
 */
export async function searchProductsNode(
  state: AgentStateValue,
): Promise<AgentStateUpdate> {
  const startedAt = Date.now();

  // 序数指代：收窄到 parseIntent 定位出的那一件。
  // 无论成功与否都要写回 null 消费掉，否则同一轮里 refine 再次进入本节点时
  // 会一直被卡在单件上，无法放宽条件。
  if (state.focusProductId) {
    const target = getProductById(state.focusProductId);
    if (target) {
      return {
        searchResults: [target],
        focusProductId: null,
        needsRefine: false,
        toolCallLog: [
          createLogEntry({
            kind: 'tool',
            name: 'search_products',
            title: '切换到指定商品',
            detail: `${target.name} · ${formatPrice(target.price)} · ${target.rating} 分`,
            status: 'done',
            startedAt,
          }),
        ],
      };
    }
  }

  const condition = describeFilters(state.searchFilters);
  const outcome = filterProducts(state.searchFilters, SEARCH_LIMIT);

  return {
    searchResults: outcome.items,
    focusProductId: null,
    needsRefine: outcome.total === 0,
    toolCallLog: [
      createLogEntry({
        kind: 'tool',
        name: 'search_products',
        title: `检索「${condition}」`,
        detail:
          outcome.total > 0
            ? `命中 ${outcome.total} 件，展示前 ${outcome.items.length} 件`
            : '没有命中商品，尝试放宽条件',
        status: 'done',
        startedAt,
      }),
    ],
  };
}
