import { describe, expect, it } from 'vitest';
import { normalizeSnapshot, type AgentStateSnapshot } from '@/lib/agent/events';
import { toSnapshot } from '@/lib/agent/sse';
import {
  makeCartItem,
  makeComparison,
  makeOrder,
  makeProduct,
  makeState,
} from '@/lib/test-utils/factories';

/**
 * 快照恢复期的形状归一化 —— 修的是「旧持久化快照缺新字段」这一类崩溃（2026-09-26）。
 *
 * 复现（真机，dev 3000）：`snapshot` 随 store 持久化进 localStorage，而 zustand 的
 * rehydrate 是浅合并、无形状校验 ——
 *   ① 删掉 `searchResultIds` 再刷新 → `product-panel.tsx` 的 `.length` 抛错、**整页白屏**；
 *   ② 只删 `searchTotal` → 不崩，但中栏写成「12 件商品」、入口写成「查看全部  件」。
 * 所以这里锁两件事：旧快照补默认值后**可用**，完整快照**原样通过**（不丢字段、不改值）。
 */

describe('normalizeSnapshot：非对象一律视为「没有快照」', () => {
  it('undefined / null / 字符串 / 数字 / 数组 → null', () => {
    expect(normalizeSnapshot(undefined)).toBeNull();
    expect(normalizeSnapshot(null)).toBeNull();
    expect(normalizeSnapshot('字符串')).toBeNull();
    expect(normalizeSnapshot(42)).toBeNull();
    // 数组是对象但不是快照：`.length` 会骗过类型，必须当「没有快照」
    expect(normalizeSnapshot([])).toBeNull();
  });
});

describe('normalizeSnapshot：旧快照补默认值', () => {
  /** 旧版本写下的快照：有筛选条件、有 12 件结果，但缺本轮新增的两个字段 */
  const legacySnapshot = {
    intent: 'search',
    searchFilters: { category: '图书', keywords: ['小说'] },
    conditionText: '图书 · 小说',
    searchResults: [makeProduct({ id: 'bk-1' })],
    replyProductIds: ['bk-1'],
    liveOverrides: {},
    liveFetchedAt: null,
    compareTargets: [],
    comparison: null,
    cart: [],
    toolCallLog: [],
    pendingOrder: null,
    reply: '找到 1 件',
    profilePatch: [],
    profileGeneration: 0,
    llmEnabled: true,
  };

  it('缺 searchResultIds（本次崩溃场景）→ 补齐为 []，「查看全部」入口因此不出现', () => {
    const snapshot = normalizeSnapshot(legacySnapshot);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.searchResultIds).toEqual([]);
    // 已有的字段原样保留（不重解释）
    expect(snapshot?.intent).toBe('search');
    expect(snapshot?.searchFilters).toEqual({ category: '图书', keywords: ['小说'] });
    expect(snapshot?.replyProductIds).toEqual(['bk-1']);
  });

  it('缺 searchTotal → 用 searchResults.length 兜底（不写「共 0 件 · 展示前 12 件」）', () => {
    const twelve = Array.from({ length: 12 }, (_, index) => makeProduct({ id: `p-${index}` }));
    const snapshot = normalizeSnapshot({
      ...legacySnapshot,
      searchResults: twelve,
    });

    expect(snapshot?.searchTotal).toBe(12);
    expect(normalizeSnapshot({})?.searchTotal).toBe(0);
  });

  it('空对象 → 每个字段都落到安全默认值（含 intent=chat、llmEnabled=true）', () => {
    const snapshot = normalizeSnapshot({});

    expect(snapshot).toMatchObject({
      intent: 'chat',
      searchFilters: {},
      conditionText: '',
      searchResults: [],
      searchTotal: 0,
      searchResultIds: [],
      replyProductIds: [],
      liveOverrides: {},
      liveFetchedAt: null,
      compareTargets: [],
      comparison: null,
      cart: [],
      toolCallLog: [],
      pendingOrder: null,
      reply: '',
      profilePatch: [],
      profileGeneration: 0,
      llmEnabled: true,
    });
  });

  it('数组字段类型不对时退回空数组（localStorage 是不可信边界）', () => {
    const snapshot = normalizeSnapshot({
      searchResults: 'oops',
      searchResultIds: { a: 1 },
      toolCallLog: 7,
      profilePatch: null,
    });

    expect(snapshot?.searchResults).toEqual([]);
    expect(snapshot?.searchResultIds).toEqual([]);
    expect(snapshot?.toolCallLog).toEqual([]);
    expect(snapshot?.profilePatch).toEqual([]);
  });
});

describe('normalizeSnapshot：完整快照原样通过', () => {
  const richState = makeState({
    intent: 'refine',
    searchFilters: { rawQuery: '500 元以内的商品', maxPrice: 500 },
    searchResults: [makeProduct({ id: 'p-1' }), makeProduct({ id: 'p-2' })],
    searchTotal: 361,
    searchResultIds: ['p-1', 'p-2'],
    liveOverrides: { 'p-1': makeProduct({ id: 'p-1', price: 199 }) },
    liveFetchedAt: 1790400000000,
    compareTargets: [makeProduct({ id: 'p-1' }), makeProduct({ id: 'p-2' })],
    comparison: makeComparison({ products: [makeProduct({ id: 'p-1' })] }),
    cart: [makeCartItem(makeProduct({ id: 'p-1' }), 2)],
    pendingOrder: makeOrder({ status: 'confirmed' }),
    profilePatch: [{ kind: 'category', value: '图书', source: 'browse' }],
    profileGeneration: 3,
  });

  it('当前版本产出的快照 → toEqual 原值（不丢字段、不改值、null 与 0 都不被替换）', () => {
    const full: AgentStateSnapshot = toSnapshot(richState, Date.now(), 0);
    expect(normalizeSnapshot(full)).toEqual(full);
  });

  it('显式 false / 0 / 空串都按「已有值」保留，不会被默认值顶掉', () => {
    const snapshot = normalizeSnapshot({
      llmEnabled: false,
      searchTotal: 0,
      conditionText: '',
      liveFetchedAt: 0,
      comparison: null,
    });

    expect(snapshot?.llmEnabled).toBe(false);
    expect(snapshot?.searchTotal).toBe(0);
    expect(snapshot?.conditionText).toBe('');
    expect(snapshot?.liveFetchedAt).toBe(0);
    expect(snapshot?.comparison).toBeNull();
  });

  it('字段清单：空对象归一化后每个字段都有默认值（新增字段忘了补默认值时这条会失败）', () => {
    // 字段清单从「完整快照的键」推导，因此新增字段会自动出现在这里 —— 不需要手工维护名单
    const keys = Object.keys(toSnapshot(richState, Date.now(), 0));
    const normalized = normalizeSnapshot({}) as unknown as Record<string, unknown>;

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(
        normalized[key],
        `快照字段 ${key} 没有默认值：新增字段时必须同步 normalizeSnapshot（见 events.ts 的约定注释）`,
      ).not.toBeUndefined();
    }
  });
});