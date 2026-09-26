import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { refineSearchNode } from '@/lib/agent/nodes/refineSearch';
import type { AgentStateUpdate } from '@/lib/agent/state';
import type { SearchFilters } from '@/lib/types';
import { makeState } from '@/lib/test-utils/factories';

/**
 * refineSearch 有两条进入路径，语义完全不同，必须分开：
 *   1. 用户主动细化（intent=refine）→ 只应用相对表述的调整，识别不出就保持原条件；
 *   2. 检索为空（needsRefine=true）→ 才该放宽一个维度。
 *
 * 曾经这里无条件落到 loosenFilters，导致「换成第二件」把「小说」关键词丢掉，
 * 检索范围从 8 件放宽到 16 件。
 */

const baseFilters = { category: '图书' as const, keywords: ['小说'], maxPrice: 200 };

/**
 * 取节点返回的筛选条件。
 * LangGraph 的 `Update` 类型把每个字段放宽为 `T | OverwriteValue<T>`，
 * 而本节点的 reducer 是浅合并、运行时一定是普通对象，这里做一次带守卫的窄化。
 */
function filtersOf(update: AgentStateUpdate): SearchFilters {
  const value = update.searchFilters;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('refineSearchNode 未返回 searchFilters');
  }
  return value as SearchFilters;
}

function stateWith(text: string, overrides = {}) {
  return makeState({
    messages: [new HumanMessage(text)],
    searchFilters: baseFilters,
    ...overrides,
  });
}

describe('refineSearchNode：用户主动细化（needsRefine = false）', () => {
  it('识别不出相对表述时保持原条件，绝不放宽', async () => {
    const update = await refineSearchNode(stateWith('换成第二件'));
    expect(filtersOf(update)).toEqual(baseFilters);
  });

  it('「再便宜一点」把价格上限下调 30%', async () => {
    const filters = filtersOf(await refineSearchNode(stateWith('再便宜一点')));
    expect(filters.maxPrice).toBe(140);
    // 关键词不能被顺手丢掉
    expect(filters.keywords).toEqual(['小说']);
  });

  it('「轻一点」追加标签而不是替换条件', async () => {
    const filters = filtersOf(await refineSearchNode(stateWith('要轻一点的')));
    expect(filters.tags).toEqual(['轻量']);
    expect(filters.keywords).toEqual(['小说']);
  });

  it('轮次递增且重置 needsRefine', async () => {
    const update = await refineSearchNode(stateWith('换成第二件', { refineCount: 1 }));
    expect(update.refineCount).toBe(2);
    expect(update.needsRefine).toBe(false);
  });

  it('轮次文案是「本轮第 N/2 轮」（refineCount 每轮由 parseIntent 重置，N ≤ 2 恒成立）', async () => {
    const titleOf = (update: AgentStateUpdate): string => {
      const value = update.toolCallLog;
      return Array.isArray(value) ? (value[0]?.title ?? '') : '';
    };
    expect(titleOf(await refineSearchNode(stateWith('换成第二件')))).toBe(
      '本轮第 1/2 轮调整条件',
    );
    expect(
      titleOf(await refineSearchNode(stateWith('换成第二件', { refineCount: 1 }))),
    ).toBe('本轮第 2/2 轮调整条件');
  });

  it('反向区间在节点入口被 clamp（relaxFilters 兜底，检索不会因反向区间必空）', async () => {
    const filters = filtersOf(
      await refineSearchNode(
        makeState({
          messages: [new HumanMessage('再便宜点')],
          searchFilters: { minPrice: 100000, maxPrice: 100200 },
        }),
      ),
    );
    expect(filters.maxPrice).toBe(100000);
    expect(filters.minPrice).toBe(100000);
  });
});

describe('refineSearchNode：检索为空触发放宽（needsRefine = true）', () => {
  it('放宽一个维度：先丢关键词', async () => {
    const filters = filtersOf(
      await refineSearchNode(stateWith('随便看看', { needsRefine: true })),
    );
    expect(filters.keywords).toBeUndefined();
    // 品类与价格保留，只放宽最受限的那一维
    expect(filters.category).toBe('图书');
    expect(filters.maxPrice).toBe(200);
  });

  it('放宽路径同样尊重相对表述（「再便宜一点」优先按价格调整）', async () => {
    const filters = filtersOf(
      await refineSearchNode(stateWith('再便宜一点', { needsRefine: true })),
    );
    expect(filters.maxPrice).toBe(140);
  });
});
