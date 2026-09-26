import { describe, expect, it } from 'vitest';
import { SEARCH_RESULT_LIMIT } from '@/lib/agent/events';
import type { AgentStateSnapshot } from '@/lib/agent/events';
import { filterProducts } from '@/lib/agent/tools/productTools';
import { selectBrowseProducts } from '@/lib/catalog/browse-products';
import { PRODUCTS } from '@/lib/catalog/products';
import {
  applyServerOrder,
  browseWindow,
  EXPAND_PAGE_SIZE,
  expansionPlanOf,
  expansionViewOf,
  hasEffectiveFilters,
  isSearchIntent,
  needsFullSetForSort,
  productPanelStateOf,
} from '@/lib/product-panel-state';
import type { AgentIntent, Product, SearchFilters, SortKey } from '@/lib/types';

/**
 * 中栏三态判定的边界。
 *
 * 背景（2026-09-26 解冻轮收尾）：两态时「搜索类意图 + 0 命中」会回落成「为你推荐」，
 * 用户分不清「没搜到」还是「被当成闲聊」。这里锁住三种态各自的进入条件，尤其是
 * **闲聊轮必须仍然回落推荐位**（这条是刻意的，不是遗漏）。
 */
describe('productPanelStateOf：中栏三态', () => {
  it('有结果 → 搜索结果（与意图无关：上一轮列表还在时不该翻脸）', () => {
    expect(productPanelStateOf({ intent: 'search', total: 30, shown: 12 })).toBe('results');
    expect(productPanelStateOf({ intent: 'chat', total: 0, shown: 3 })).toBe('results');
    expect(productPanelStateOf({ intent: null, total: 5, shown: 5 })).toBe('results');
  });

  it('搜索类意图 + 0 命中 → 搜索无结果态（本轮新增）', () => {
    expect(productPanelStateOf({ intent: 'search', total: 0, shown: 0 })).toBe('empty-search');
    expect(productPanelStateOf({ intent: 'refine', total: 0, shown: 0 })).toBe('empty-search');
  });

  it('非搜索意图 + 0 命中 → 为你推荐（闲聊轮行为不变）', () => {
    expect(productPanelStateOf({ intent: 'chat', total: 0, shown: 0 })).toBe('recommend');
    expect(productPanelStateOf({ intent: 'compare', total: 0, shown: 0 })).toBe('recommend');
    expect(productPanelStateOf({ intent: 'cart', total: 0, shown: 0 })).toBe('recommend');
    expect(productPanelStateOf({ intent: 'checkout', total: 0, shown: 0 })).toBe('recommend');
    expect(productPanelStateOf({ intent: null, total: 0, shown: 0 })).toBe('recommend');
  });

  it('搜索类意图的集合只有 search / refine', () => {
    expect(isSearchIntent('search')).toBe(true);
    expect(isSearchIntent('refine')).toBe(true);
    expect(isSearchIntent('compare')).toBe(false);
    expect(isSearchIntent('cart')).toBe(false);
    expect(isSearchIntent('checkout')).toBe(false);
    expect(isSearchIntent('chat')).toBe(false);
    expect(isSearchIntent(null)).toBe(false);
  });
});

/**
 * 浏览视图的分页窗口（品类 60 件 / 全量 420 件不能一次全画）。
 * `visible` 是「加载更多」累计到的条数；余量用于按钮文案与「已显示全部」的收尾态。
 */
describe('browseWindow：浏览视图的展示窗口', () => {
  const items = Array.from({ length: 60 }, (_, index) => index);

  it('首屏窗口 = 前 visible 件，余量是剩余件数', () => {
    expect(browseWindow(items, 24)).toEqual({ shown: items.slice(0, 24), remaining: 36 });
  });

  it('visible 超过总数 → 全部显示、余量 0（再点也点不出更多）', () => {
    expect(browseWindow(items, 900)).toEqual({ shown: items, remaining: 0 });
    expect(browseWindow(items, 60)).toEqual({ shown: items, remaining: 0 });
  });

  it('visible 为 0 / 负数 / 空列表 → 空窗口，不抛错', () => {
    expect(browseWindow(items, 0)).toEqual({ shown: [], remaining: 60 });
    expect(browseWindow(items, -3)).toEqual({ shown: [], remaining: 60 });
    expect(browseWindow([], 24)).toEqual({ shown: [], remaining: 0 });
  });
});

/**
 * 「有没有有效筛选条件」是服务端（要不要下发命中 id）与客户端（中栏就地展开走目录还是走 id）
 * 共用的唯一判据 —— 两边不一致就会出现「有按钮、点开却少件」。
 */
describe('hasEffectiveFilters：服务端与客户端共用的判据', () => {
  it('八类筛选字段任一生效即为真', () => {
    expect(hasEffectiveFilters({ category: '图书' })).toBe(true);
    expect(hasEffectiveFilters({ keywords: ['小说'] })).toBe(true);
    expect(hasEffectiveFilters({ tags: ['悬疑'] })).toBe(true);
    expect(hasEffectiveFilters({ brands: ['Sony'] })).toBe(true);
    expect(hasEffectiveFilters({ minPrice: 100 })).toBe(true);
    expect(hasEffectiveFilters({ maxPrice: 500 })).toBe(true);
    expect(hasEffectiveFilters({ minRating: 4.5 })).toBe(true);
  });

  it('只有 rawQuery / sort（或空条件 / null）时为假 —— 「看看所有商品」这类全量命中', () => {
    expect(hasEffectiveFilters({})).toBe(false);
    expect(hasEffectiveFilters({ rawQuery: '让我看看所有420件商品' })).toBe(false);
    expect(hasEffectiveFilters({ rawQuery: '最便宜的', sort: 'price_asc' })).toBe(false);
    expect(hasEffectiveFilters(null)).toBe(false);
    expect(hasEffectiveFilters(undefined)).toBe(false);
  });

  it('空数组不算生效（清空后残留的空列表不构成筛选）', () => {
    expect(hasEffectiveFilters({ keywords: [], tags: [], brands: [] })).toBe(false);
  });
});

/* ============================================================
   中栏就地展开（2026-09-26）：把「展示集」从 Agent 的工作集里拆出来
   —— searchResults（12 件）不动，多出来的部分由客户端按需解析
   ============================================================ */

function product(id: string, patch: Partial<Product> = {}): Product {
  return {
    id,
    name: `商品 ${id}`,
    brand: 'TestBrand',
    category: '数码',
    price: 100,
    originalPrice: 120,
    rating: 4.5,
    reviews: 10,
    sales: 100,
    stock: 50,
    image: '',
    description: '',
    specifications: {},
    tags: [],
    ...patch,
  };
}

/** 只写与本组测试相关的字段，其余按「没有快照」之外的空值补齐 */
function snapshot(patch: {
  intent?: AgentIntent;
  searchFilters?: SearchFilters;
  searchResults?: Product[];
  searchTotal?: number;
  searchResultIds?: string[];
}): AgentStateSnapshot {
  return {
    intent: patch.intent ?? 'search',
    searchFilters: patch.searchFilters ?? {},
    conditionText: '',
    searchResults: patch.searchResults ?? [],
    searchTotal: patch.searchTotal ?? 0,
    searchResultIds: patch.searchResultIds ?? [],
    liveOverrides: {},
    liveFetchedAt: null,
    compareTargets: [],
    comparison: null,
    cart: [],
    toolCallLog: [],
    pendingOrder: null,
    reply: '',
    replyProductIds: [],
    profilePatch: [],
    profileGeneration: 0,
    llmEnabled: true,
  };
}

const results12 = Array.from({ length: SEARCH_RESULT_LIMIT }, (_, index) =>
  product(`p${index}`),
);

/**
 * 与服务端 `filterProducts` 的顺序对齐 —— 这是「展开后前 12 件不变样」的前提：
 * 客户端拿目录现算的完整集若用目录原始顺序，拼在服务端那 12 件后面就会露馅。
 * 断言直接与服务端纯函数的输出逐件比对（服务端排序若变，这里会红）。
 */
describe('applyServerOrder：与服务端检索顺序的 parity', () => {
  it('无关键词的 relevance = 评分→销量（前 12 件与服务端逐件一致）', () => {
    const server = filterProducts({}, SEARCH_RESULT_LIMIT).items.map((item) => item.id);
    const client = applyServerOrder(PRODUCTS, undefined)
      .slice(0, SEARCH_RESULT_LIMIT)
      .map((item) => item.id);
    expect(client).toEqual(server);
    expect(client).toEqual(filterProducts({ sort: 'relevance' }, SEARCH_RESULT_LIMIT).items.map((i) => i.id));
  });

  it('显式排序键同样逐件一致（价格升 / 降、评分、销量）', () => {
    for (const key of ['price_asc', 'price_desc', 'rating', 'sales'] as SortKey[]) {
      const server = filterProducts({ sort: key }, SEARCH_RESULT_LIMIT).items.map((i) => i.id);
      const client = applyServerOrder(PRODUCTS, key)
        .slice(0, SEARCH_RESULT_LIMIT)
        .map((i) => i.id);
      expect(client).toEqual(server);
    }
  });

  it('返回新数组、不改入参', () => {
    const list = [product('a', { rating: 3 }), product('b', { rating: 5 })];
    const ordered = applyServerOrder(list, undefined);
    expect(list.map((p) => p.id)).toEqual(['a', 'b']);
    expect(ordered.map((p) => p.id)).toEqual(['b', 'a']);
  });
});

/**
 * `ids` 源保序（`selectBrowseProducts` 按 id 查目录）：命中 id 列表是服务端结果顺序的
 * 前缀，所以「加载更多」追加进来的就是首屏 12 件的后续 —— 不重排、不重复、不丢件。
 */
describe('ids 源：展开的前 12 件与首屏逐件一致', () => {
  it('真实目录 + 有筛选的检索结果 → 两者的前 12 件 id 完全相同', () => {
    const outcome = filterProducts({ keywords: ['小说'] }, SEARCH_RESULT_LIMIT);
    expect(outcome.total).toBeGreaterThan(SEARCH_RESULT_LIMIT);
    const expanded = selectBrowseProducts(PRODUCTS, {
      kind: 'ids',
      ids: outcome.ids,
      total: outcome.total,
    });
    expect(expanded.slice(0, SEARCH_RESULT_LIMIT).map((p) => p.id)).toEqual(
      outcome.items.map((p) => p.id),
    );
  });
});

describe('expansionPlanOf：这一轮能追加什么', () => {
  it('非搜索意图（闲聊 / 加购 / 结算 / 对比轮）→ null：不出现「加载更多」', () => {
    for (const intent of ['chat', 'cart', 'checkout', 'compare'] as AgentIntent[]) {
      expect(
        expansionPlanOf(
          snapshot({ intent, searchTotal: 420, searchResults: results12, searchResultIds: [] }),
        ),
      ).toBeNull();
    }
  });

  it('有筛选且命中的 id 列表非空 → ids 源，上限 = id 条数', () => {
    const ids = Array.from({ length: 30 }, (_, index) => `p${index}`);
    expect(
      expansionPlanOf(
        snapshot({
          intent: 'search',
          searchFilters: { category: '图书' },
          searchTotal: 30,
          searchResults: results12,
          searchResultIds: ids,
        }),
      ),
    ).toEqual({ source: { kind: 'ids', ids, total: 30 }, ceiling: 30, truncated: false });
  });

  it('命中多于下发上限（120）→ truncated：展开到底要注明单次上限', () => {
    const ids = Array.from({ length: 120 }, (_, index) => `p${index}`);
    const plan = expansionPlanOf(
      snapshot({
        intent: 'refine',
        searchFilters: { keywords: ['跑鞋'] },
        searchTotal: 300,
        searchResults: results12,
        searchResultIds: ids,
      }),
    );
    expect(plan?.ceiling).toBe(120);
    expect(plan?.truncated).toBe(true);
  });

  it('无有效筛选条件 + 命中多于展示 → all 源（420 个 id 不进 SSE）', () => {
    expect(
      expansionPlanOf(
        snapshot({
          searchFilters: { rawQuery: '让我看看所有420件商品' },
          searchTotal: 420,
          searchResults: results12,
          searchResultIds: [],
        }),
      ),
    ).toEqual({ source: { kind: 'all' }, ceiling: 420, truncated: false });
  });

  it('两者都拿不到 → null（不给一个点了没反应的按钮）', () => {
    // 有筛选条件、却没有下发 id（客户端要保守：没有数据来源就不给按钮）
    expect(
      expansionPlanOf(
        snapshot({
          searchFilters: { category: '图书' },
          searchTotal: 30,
          searchResults: results12,
          searchResultIds: [],
        }),
      ),
    ).toBeNull();
    // 没有「藏起来的部分」
    expect(
      expansionPlanOf(
        snapshot({
          searchFilters: { category: '图书' },
          searchTotal: SEARCH_RESULT_LIMIT,
          searchResults: results12,
          searchResultIds: [],
        }),
      ),
    ).toBeNull();
    // 序数轮（「换成第二件」）：只展示一件，total = 1
    expect(
      expansionPlanOf(
        snapshot({ intent: 'refine', searchTotal: 1, searchResults: [product('p0')] }),
      ),
    ).toBeNull();
    // 无快照
    expect(expansionPlanOf(null)).toBeNull();
  });

  it('「加载更多」的步长与浏览视图分页同源（24）', () => {
    expect(EXPAND_PAGE_SIZE).toBe(24);
  });
});

describe('needsFullSetForSort：排序前是否要先载入完整集', () => {
  const plan = expansionPlanOf(
    snapshot({ searchTotal: 420, searchResults: results12, searchResultIds: [] }),
  );

  it('综合（relevance）永远不需要：首屏 12 件就是完整集的前 12 件', () => {
    expect(needsFullSetForSort('relevance', false, plan)).toBe(false);
  });

  it('显式排序 + 有追加计划 + 完整集未载入 → 需要（否则只排了 12 件，是假象）', () => {
    expect(needsFullSetForSort('price_asc', false, plan)).toBe(true);
    expect(needsFullSetForSort('price_desc', false, plan)).toBe(true);
    expect(needsFullSetForSort('sales', false, plan)).toBe(true);
  });

  it('已载入 / 没有追加计划 → 不需要', () => {
    expect(needsFullSetForSort('price_asc', true, plan)).toBe(false);
    expect(needsFullSetForSort('price_asc', false, null)).toBe(false);
  });
});

describe('expansionViewOf：就地展开的渲染窗口', () => {
  // 服务端给的前 3 件（顺序即服务端顺序），完整集另有 2 件更便宜的
  const sse = [product('s1', { price: 300 }), product('s2', { price: 100 }), product('s3', { price: 200 })];
  const full = [...sse, product('s4', { price: 50 }), product('s5', { price: 150 })];

  it('完整集未载入 / 加载失败 → 回落首屏（保留已显示的，不清空）', () => {
    const view = expansionViewOf({
      sseResults: sse,
      expanded: null,
      visible: EXPAND_PAGE_SIZE,
      sort: 'relevance',
      ceiling: 60,
    });
    expect(view.products.map((p) => p.id)).toEqual(['s1', 's2', 's3']);
    expect(view.shown).toBe(3);
    expect(view.remaining).toBe(57); // 余量以「可得上限」为分母，不是已载入条数
  });

  it('已载入 → 追加到 visible 条，余量递减', () => {
    const view = expansionViewOf({
      sseResults: sse,
      expanded: full,
      visible: 5,
      sort: 'relevance',
      ceiling: 60,
    });
    expect(view.products.map((p) => p.id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(view.remaining).toBe(55);
  });

  it('排序作用于完整集：首件是全局最低价（不是那 12 件里的最低价）', () => {
    const view = expansionViewOf({
      sseResults: sse,
      expanded: full,
      visible: full.length,
      sort: 'price_asc',
      ceiling: 60,
    });
    const prices = view.products.map((p) => p.price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(prices[0]).toBe(50); // s4 —— 只排首屏 3 件时它根本不在列表里
  });

  it('到顶：remaining 归零（「已显示全部 N 件」的判据）', () => {
    const view = expansionViewOf({
      sseResults: sse,
      expanded: full,
      visible: 999,
      sort: 'relevance',
      ceiling: full.length,
    });
    expect(view.products).toHaveLength(full.length);
    expect(view.remaining).toBe(0);
  });
});