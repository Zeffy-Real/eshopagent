import { filterProducts } from '@/lib/agent/tools/productTools';
import { describeFilters } from '@/lib/agent/ruleParser';
import type { AgentStateUpdate, AgentStateValue } from '@/lib/agent/state';
import { createLogEntry } from '@/lib/agent/utils';

/** 单次检索返回的最大商品数（中栏网格一屏可展示的数量） */
export const SEARCH_LIMIT = 12;

/**
 * 商品检索节点。
 *
 * 直接调用工具层的纯函数 filterProducts（强类型、可单测），
 * 结果写入 searchResults；命中为空时置 needsRefine=true，
 * 由条件边交给 refineSearch 放宽条件后再检索一次。
 */
export async function searchProductsNode(
  state: AgentStateValue,
): Promise<AgentStateUpdate> {
  const startedAt = Date.now();
  const condition = describeFilters(state.searchFilters);
  const outcome = filterProducts(state.searchFilters, SEARCH_LIMIT);

  return {
    searchResults: outcome.items,
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
