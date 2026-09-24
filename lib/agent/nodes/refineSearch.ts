import { describeFilters, loosenFilters, relaxFilters } from '@/lib/agent/ruleParser';
import { MAX_REFINE_ROUNDS, type AgentStateUpdate, type AgentStateValue } from '@/lib/agent/state';
import { createLogEntry, lastHumanText } from '@/lib/agent/utils';

/**
 * 条件细化 / 放宽节点。
 *
 * 两种触发方式，语义**不同**，必须分开处理：
 * 1. 用户主动细化（intent=refine）：「再便宜一点的」→ 价格上限下调 30%；
 * 2. 检索结果为空时由条件边进入（needsRefine=true）→ 放宽一个维度
 *    （先去标签，再去关键词，然后放大价格上限，最后去掉品类）。
 *
 * 关键区分：只有第 2 种情况才该放宽。第 1 种情况下若识别不出相对表述，
 * 必须**保持原条件**——曾经这里无条件落到 loosenFilters，于是「换成第二件」
 * 被丢掉了「小说」关键词，检索范围从 8 件放宽到 16 件。
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
  const filters = changed
    ? relaxed
    : state.needsRefine
      ? loosenFilters(state.searchFilters)
      : state.searchFilters;

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
