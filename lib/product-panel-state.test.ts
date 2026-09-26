import { describe, expect, it } from 'vitest';
import {
  browseWindow,
  hasEffectiveFilters,
  isSearchIntent,
  productPanelStateOf,
} from '@/lib/product-panel-state';

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
 * 「有没有有效筛选条件」是服务端（要不要下发命中 id）与客户端（浏览视图走目录还是走 id）
 * 共用的唯一判据 —— 两边不一致就会出现「入口在、点开却少件」。
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