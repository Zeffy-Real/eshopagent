import { compareProducts } from '@/lib/agent/tools/productTools';
import type { AgentStateUpdate, AgentStateValue } from '@/lib/agent/state';
import { createLogEntry } from '@/lib/agent/utils';
import { formatPrice } from '@/lib/utils';

/** 未显式选择时，默认对比搜索结果的前 N 件 */
const DEFAULT_COMPARE_SIZE = 3;
const MIN_COMPARE_SIZE = 2;

/**
 * 商品对比节点。
 *
 * 对比对象来源优先级：
 * 1. 商品区多选后提交的 compareTargets（客户端作为图输入注入）；
 * 2. 用户说「对比前 3 件」时，取 searchResults 的前 3 件。
 *
 * 对比结果写入 state.comparison，右栏对比表格与决策推荐面板直接消费。
 */
export async function compareProductsNode(
  state: AgentStateValue,
): Promise<AgentStateUpdate> {
  const startedAt = Date.now();
  const targets =
    state.compareTargets.length >= MIN_COMPARE_SIZE
      ? state.compareTargets
      : state.searchResults.slice(0, DEFAULT_COMPARE_SIZE);

  if (targets.length < MIN_COMPARE_SIZE) {
    return {
      comparison: null,
      toolCallLog: [
        createLogEntry({
          kind: 'tool',
          name: 'compare_products',
          title: '无法发起对比',
          detail: `至少需要 2 件商品，当前可用 ${targets.length} 件。先搜索或勾选商品再试。`,
          status: 'error',
          startedAt,
        }),
      ],
    };
  }

  const result = compareProducts(targets.map((product) => product.id));
  const diffCount = result.rows.filter((row) => row.diff).length;
  const bestValue = result.products.find(
    (product) => product.id === result.highlights.bestValueId,
  );

  return {
    compareTargets: result.products,
    comparison: result,
    toolCallLog: [
      createLogEntry({
        kind: 'tool',
        name: 'compare_products',
        title: `对比 ${result.products.length} 件商品`,
        detail: `共 ${result.rows.length} 项参数，其中 ${diffCount} 项存在差异${
          bestValue ? ` · 性价比最高：${bestValue.name}（${formatPrice(bestValue.price)}）` : ''
        }`,
        status: 'done',
        startedAt,
      }),
    ],
  };
}
