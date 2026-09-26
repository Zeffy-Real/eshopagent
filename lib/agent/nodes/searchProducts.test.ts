import { describe, expect, it } from 'vitest';
import { searchProductsNode } from '@/lib/agent/nodes/searchProducts';
import { SEARCH_RESULT_LIMIT } from '@/lib/agent/events';
import type { AgentStateUpdate } from '@/lib/agent/state';
import { PRODUCTS } from '@/lib/catalog/products';
import type { ProfileSignal } from '@/lib/profile';
import type { Product, ToolLogEntry } from '@/lib/types';
import { makeState } from '@/lib/test-utils/factories';

/**
 * searchProducts 负责消费序数指代的产物 focusProductId：
 * 「换成第二件」不该重新检索，而是把结果收窄到那一件。
 */

/** LangGraph 的 Update 类型会把字段放宽为 `T | OverwriteValue<T>`，这里做带守卫的窄化 */
function resultsOf(update: AgentStateUpdate): Product[] {
  const value = update.searchResults;
  if (!Array.isArray(value)) throw new Error('searchProductsNode 未返回 searchResults');
  return value;
}

function firstLogOf(update: AgentStateUpdate): ToolLogEntry | undefined {
  const value = update.toolCallLog;
  if (!Array.isArray(value)) throw new Error('searchProductsNode 未返回 toolCallLog');
  return value[0];
}

function patchOf(update: AgentStateUpdate): ProfileSignal[] {
  const value = update.profilePatch;
  if (!Array.isArray(value)) throw new Error('searchProductsNode 未返回 profilePatch');
  return value;
}

function totalOf(update: AgentStateUpdate): number {
  const value = update.searchTotal;
  if (typeof value !== 'number') throw new Error('searchProductsNode 未返回 searchTotal');
  return value;
}

const books = PRODUCTS.filter((product) => product.category === '图书');

describe('searchProductsNode：序数指代收窄结果集', () => {
  it('focusProductId 命中时收窄为单件，并消费掉该字段', async () => {
    const target = books[1];
    expect(target).toBeDefined();

    const update = await searchProductsNode(
      makeState({ focusProductId: target?.id ?? null, searchFilters: { category: '图书' } }),
    );

    expect(resultsOf(update)).toEqual([target]);
    // 必须消费掉：否则同一轮里 refine 再进来会一直被卡在单件上
    expect(update.focusProductId).toBeNull();
    expect(update.needsRefine).toBe(false);
  });

  it('focusProductId 指向不存在的商品时回落到正常检索，且同样消费掉', async () => {
    const update = await searchProductsNode(
      makeState({ focusProductId: 'not-a-real-id', searchFilters: { category: '图书' } }),
    );

    expect(resultsOf(update).length).toBeGreaterThan(1);
    expect(update.focusProductId).toBeNull();
  });

  it('没有 focusProductId 时走正常检索', async () => {
    const update = await searchProductsNode(makeState({ searchFilters: { category: '图书' } }));
    expect(resultsOf(update).length).toBeGreaterThan(1);
    expect(update.focusProductId).toBeNull();
  });

  it('收窄时也写一条可读的时间线，便于确认切到了哪一件', async () => {
    const target = books[0];
    const update = await searchProductsNode(
      makeState({ focusProductId: target?.id ?? null }),
    );
    const log = firstLogOf(update);
    expect(log?.title).toBe('切换到指定商品');
    expect(log?.detail).toContain(target?.name ?? '');
  });
});

describe('searchProductsNode：画像信号', () => {
  it('从真实检索行为提取信号（条件 + 实际命中的商品）', async () => {
    const update = await searchProductsNode(
      makeState({ searchFilters: { category: '图书' } }),
    );
    expect(patchOf(update)).toContainEqual({
      kind: 'category',
      value: '图书',
      source: 'browse',
    });
  });

  it('追加而不覆盖本轮已有信号（同一轮多个节点的信号会累积）', async () => {
    const existing: ProfileSignal[] = [
      { kind: 'brand', value: '测试出版社', source: 'cart' },
    ];
    const update = await searchProductsNode(
      makeState({ searchFilters: { category: '图书' }, profilePatch: existing }),
    );
    expect(patchOf(update)[0]).toEqual(existing[0]);
  });

  it('条件为空且结果混品类 → 不产出信号（不替用户总结）', async () => {
    const update = await searchProductsNode(makeState({ searchFilters: {} }));
    expect(patchOf(update)).toEqual([]);
  });
});

/**
 * `searchTotal`（命中总数，截断前）的写入口径。
 *
 * 背景（2026-09-26 Bug B）：数据快照面板里的 420 是**目录总量**，而中栏单次最多展示
 * `SEARCH_RESULT_LIMIT` 件 —— 界面原先只写「12 件商品」，看起来与 420 / 品类 chip 的 60
 * 对不上。修法是把命中总数单独下发，由中栏渲染「共 N 件 · 展示前 M 件」。
 * 这里锁三件事：截断关系、refine 后必须更新（不能是历史值）、序数定位同步为 1。
 */
describe('searchProductsNode：searchTotal 是本轮命中数（截断前）', () => {
  it('命中数多于展示上限 → searchResults 截断到上限，searchTotal 仍是真实命中数', async () => {
    // 图书品类在默认目录里是 60 件（7 品类 × 60）
    const update = await searchProductsNode(makeState({ searchFilters: { category: '图书' } }));

    expect(totalOf(update)).toBe(books.length);
    expect(resultsOf(update)).toHaveLength(SEARCH_RESULT_LIMIT);
    expect(SEARCH_RESULT_LIMIT).toBe(12);
  });

  it('命中数少于一屏 → 不截断，两个数字一致（界面不写「展示前 12 件」）', async () => {
    // 题材标签「悬疑」在图书里只命中个位数 —— 命中数 < 展示上限的情形
    const update = await searchProductsNode(
      makeState({ searchFilters: { category: '图书', tags: ['悬疑'] } }),
    );

    const total = totalOf(update);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(SEARCH_RESULT_LIMIT);
    expect(resultsOf(update)).toHaveLength(total);
  });

  it('refine 换条件后 searchTotal 跟着变（不是上一轮的历史值）', async () => {
    const wide = await searchProductsNode(makeState({ searchFilters: { category: '图书' } }));
    const narrow = await searchProductsNode(
      makeState({ searchFilters: { category: '图书', tags: ['悬疑'] } }),
    );

    expect(totalOf(wide)).toBeGreaterThan(totalOf(narrow));
  });

  it('命中为 0 → 两个数字都是 0（并置 needsRefine 交给放宽条件）', async () => {
    const update = await searchProductsNode(
      makeState({ searchFilters: { category: '图书', minPrice: 99999 } }),
    );

    expect(totalOf(update)).toBe(0);
    expect(resultsOf(update)).toHaveLength(0);
    expect(update.needsRefine).toBe(true);
  });

  it('序数定位（focusProductId）→ 收窄为 1 件，searchTotal 同步为 1', async () => {
    const target = books[0];
    expect(target).toBeDefined();

    const update = await searchProductsNode(
      makeState({ focusProductId: target?.id ?? null, searchFilters: { category: '图书' } }),
    );

    expect(resultsOf(update)).toHaveLength(1);
    expect(totalOf(update)).toBe(1);
  });
});