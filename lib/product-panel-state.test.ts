import { describe, expect, it } from 'vitest';
import { isSearchIntent, productPanelStateOf } from '@/lib/product-panel-state';

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