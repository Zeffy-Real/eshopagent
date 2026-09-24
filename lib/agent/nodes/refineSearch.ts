import { describeFilters, loosenFilters, relaxFilters } from '@/lib/agent/ruleParser';
import { MAX_REFINE_ROUNDS, type AgentStateUpdate, type AgentStateValue } from '@/lib/agent/state';
import { createLogEntry, lastHumanText } from '@/lib/agent/utils';

/**
 * 条件细化 / 放宽节点。
 *
 * 两种触发方式：
 * 1. 用户主动细化（intent=refine）：「再便宜一点的」→ 价格上限下调 30%；
 * 2. 检索结果为空时由条件边进入 → 规则放宽不生效时强制放宽一个维度
 *    （先去标签，再去关键词，然后放大价格上限，最后去掉品类）。
 *
 * 随后回到 searchProducts 重新检索；refineCount 由 MAX_REFINE_ROUNDS 封顶，
 * 保证环一定收敛。
 */
export async function refineSearchNode(
  state: AgentStateValue,
): Promise<AgentStateUpdate> {
  const startedAt = Date.now();
  const text = lastHumanText(state.messages);
  const round = state.refineCount + 1;
  const before = describeFilters(state.searchFilters);

  const relaxed = relaxFilters(state.searchFilters, text);
  const changed = describeFilters(relaxed) !== before;
  const filters = changed ? relaxed : loosenFilters(state.searchFilters);

  return {
    searchFilters: filters,
    refineCount: round,
    needsRefine: false,
    toolCallLog: [
      createLogEntry({
        kind: 'tool',
        name: 'refine_search',
        title: `第 ${round}/${MAX_REFINE_ROUNDS} 轮调整条件`,
        detail: `${before} → ${describeFilters(filters)}`,
        status: 'done',
        startedAt,
      }),
    ],
  };
}
