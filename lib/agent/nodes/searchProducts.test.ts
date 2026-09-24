import { describe, expect, it } from 'vitest';
import { searchProductsNode } from '@/lib/agent/nodes/searchProducts';
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
