import { describe, expect, it } from 'vitest';
import {
  PROFILE_WEIGHT,
  RECENT_SEARCH_LIMIT,
  applyProfilePatch,
  buildProfileHint,
  categoryScores,
  clearProfile,
  createEmptyProfile,
  extractProfileSignals,
  hasProfileSignals,
  mergeProfile,
  profileRecall,
  profileSummaryLines,
  type UserProfile,
} from '@/lib/profile';
import { makeCartItem, makeProduct } from '@/lib/test-utils/factories';

/**
 * 画像的三条硬约束（对应 docs/memory-plan.md §3.3.8）：
 * 1. **没有真实行为就没有字段** —— 凭空生成偏好与「派生库存冒充真实库存」同类，
 *    会击穿「数据真实」这条卖点；
 * 2. **合并必须幂等** —— 一轮里每个节点结束都会推同一份 patch，interrupt 恢复轮
 *    还会把上一轮的 patch 再带一遍；
 * 3. **旧 generation 的 patch 必须被丢弃** —— 否则「清除画像」会被在途 patch 复活。
 */

const book = makeProduct({
  id: 'p-book',
  name: '测试小说',
  brand: '测试出版社',
  category: '图书',
  price: 39,
});

const earphone = makeProduct({
  id: 'p-earphone',
  name: '测试耳机',
  brand: '测试音频',
  category: '数码',
  price: 499,
});

describe('extractProfileSignals：只从真实行为产生信号', () => {
  it('没有任何行为 → 空 patch', () => {
    expect(extractProfileSignals({ kind: 'search', filters: {}, hits: [] })).toEqual([]);
  });

  it('仅浏览（未加购）→ 只产出品类与检索词，不产出品牌', () => {
    const signals = extractProfileSignals({
      kind: 'search',
      filters: { keywords: ['耳机'], category: '数码', rawQuery: '推荐点耳机' },
      hits: [earphone],
    });
    expect(signals).toContainEqual({ kind: 'category', value: '数码', source: 'browse' });
    expect(signals).toContainEqual({ kind: 'keyword', value: '耳机', source: 'browse' });
    expect(signals.some((signal) => signal.kind === 'brand')).toBe(false);
  });

  it('检索结果混品类时不推导品类（用户还没聚焦，不替他总结）', () => {
    expect(
      extractProfileSignals({ kind: 'search', filters: {}, hits: [book, earphone] }),
    ).toEqual([]);
  });

  it('检索结果同属一个品类时可以由结果推导品类', () => {
    const signals = extractProfileSignals({ kind: 'search', filters: {}, hits: [book] });
    expect(signals).toContainEqual({ kind: 'category', value: '图书', source: 'browse' });
  });

  it('只采信用户显式给出的价格上下界，不用商品价格反推', () => {
    const signals = extractProfileSignals({
      kind: 'search',
      filters: { category: '图书', maxPrice: 500 },
      hits: [book],
    });
    expect(signals).toContainEqual({ kind: 'price', value: 500, source: 'browse' });
    expect(signals.some((signal) => signal.kind === 'price' && signal.value === book.price)).toBe(
      false,
    );
  });

  it('加购 → 产出品牌信号（来源为加购）', () => {
    expect(extractProfileSignals({ kind: 'cart', product: book })).toContainEqual({
      kind: 'brand',
      value: '测试出版社',
      source: 'cart',
    });
  });

  it('成交 → 权重最高', () => {
    expect(PROFILE_WEIGHT.order).toBeGreaterThan(PROFILE_WEIGHT.cart);
    expect(PROFILE_WEIGHT.cart).toBeGreaterThan(PROFILE_WEIGHT.browse);

    const ordered = mergeProfile(
      createEmptyProfile(),
      extractProfileSignals({ kind: 'order', items: [makeCartItem(book, 2)] }),
    );
    expect(ordered.preferredCategories['图书']).toBe(PROFILE_WEIGHT.order);
    expect(ordered.brands['测试出版社']).toBe(PROFILE_WEIGHT.order);
  });

  it('成交的多件商品都产生信号', () => {
    const signals = extractProfileSignals({
      kind: 'order',
      items: [makeCartItem(book), makeCartItem(earphone)],
    });
    const categories = signals.filter((signal) => signal.kind === 'category');
    expect(categories).toHaveLength(2);
  });
});

describe('mergeProfile：幂等与合并规则', () => {
  it('重复应用同一 patch 结果一致，且返回同一引用', () => {
    const patch = extractProfileSignals({ kind: 'order', items: [makeCartItem(book)] });
    const once = mergeProfile(createEmptyProfile(), patch);
    const twice = mergeProfile(once, patch);
    expect(twice).toEqual(once);
    // 引用相同 → 前端 applySnapshot 不会因为重复推送而反复写入 localStorage
    expect(twice).toBe(once);
  });

  it('空 patch 不改动画像', () => {
    const profile = mergeProfile(
      createEmptyProfile(),
      extractProfileSignals({ kind: 'cart', product: book }),
    );
    expect(mergeProfile(profile, [])).toBe(profile);
  });

  it('检索词去重、最新在前、最多 RECENT_SEARCH_LIMIT 条', () => {
    let profile = createEmptyProfile();
    for (let index = 0; index < RECENT_SEARCH_LIMIT + 5; index += 1) {
      profile = mergeProfile(profile, [{ kind: 'keyword', value: `词${index}`, source: 'browse' }]);
    }
    expect(profile.recentSearches).toHaveLength(RECENT_SEARCH_LIMIT);
    expect(profile.recentSearches[0]).toBe(`词${RECENT_SEARCH_LIMIT + 4}`);

    // 已存在的词应被移到最前，而不是重复添加
    profile = mergeProfile(profile, [{ kind: 'keyword', value: '词9', source: 'browse' }]);
    expect(profile.recentSearches.filter((item) => item === '词9')).toHaveLength(1);
    expect(profile.recentSearches[0]).toBe('词9');
    expect(profile.recentSearches).toHaveLength(RECENT_SEARCH_LIMIT);
  });

  it('priceRange 取并集（min 取下界、max 取上界）', () => {
    let profile = createEmptyProfile();
    profile = mergeProfile(profile, [{ kind: 'price', value: 500, source: 'browse' }]);
    expect(profile.priceRange).toEqual({ min: 500, max: 500 });

    profile = mergeProfile(profile, [{ kind: 'price', value: 1600, source: 'browse' }]);
    expect(profile.priceRange).toEqual({ min: 500, max: 1600 });

    profile = mergeProfile(profile, [{ kind: 'price', value: 2400, source: 'browse' }]);
    expect(profile.priceRange).toEqual({ min: 500, max: 2400 });
  });

  it('加购不会覆盖已成交的分值（取最高权重，不累加）', () => {
    const ordered = mergeProfile(
      createEmptyProfile(),
      extractProfileSignals({ kind: 'order', items: [makeCartItem(book)] }),
    );
    const profile = mergeProfile(
      ordered,
      extractProfileSignals({ kind: 'cart', product: book }),
    );
    expect(profile.preferredCategories['图书']).toBe(PROFILE_WEIGHT.order);
    expect(profile.brands['测试出版社']).toBe(PROFILE_WEIGHT.order);
  });

  it('超长检索词不进入画像（多半是整句话，不是偏好词）', () => {
    const profile = mergeProfile(createEmptyProfile(), [
      { kind: 'keyword', value: '这是一句很长的用户输入不应该被当成检索词', source: 'browse' },
    ]);
    expect(profile.recentSearches).toEqual([]);
  });
});

describe('applyProfilePatch：generation 校验', () => {
  it('generation 一致时正常合并', () => {
    const patch = extractProfileSignals({ kind: 'cart', product: book });
    const profile = createEmptyProfile(3);
    expect(applyProfilePatch(profile, patch, 3)).not.toBe(profile);
  });

  it('旧 generation 的 patch 被丢弃：清除画像后不会被在途 patch 复活', () => {
    const inFlight = extractProfileSignals({ kind: 'cart', product: book });
    // 在途请求发出的那一刻，客户端 generation 还是 0
    const beforeClear = mergeProfile(createEmptyProfile(0), inFlight);

    const cleared = clearProfile(beforeClear);
    expect(cleared.generation).toBe(beforeClear.generation + 1);
    expect(hasProfileSignals(cleared)).toBe(false);

    // 在途 patch 到达：携带旧 generation，必须原样保留空画像
    const afterClear = applyProfilePatch(cleared, inFlight, beforeClear.generation);
    expect(afterClear).toBe(cleared);
    expect(hasProfileSignals(afterClear)).toBe(false);
  });
});

describe('画像展示与提示', () => {
  it('没有信号时不产出任何提示（不硬提偏好）', () => {
    const empty = createEmptyProfile();
    expect(buildProfileHint(empty)).toBe('');
    expect(profileRecall(empty)).toBeNull();
    expect(profileSummaryLines(empty)).toEqual([]);
  });

  it('提示语带出品类与来源动作', () => {
    const profile = mergeProfile(
      createEmptyProfile(),
      extractProfileSignals({ kind: 'order', items: [makeCartItem(book)] }),
    );
    expect(profileRecall(profile)).toEqual({ label: '图书', source: 'order' });
    expect(buildProfileHint(profile)).toBe('注意到你之前买过图书，需要我按这个方向再找找吗？');
  });

  it('没有品类信号时退到品牌（有信号就要能用上）', () => {
    const profile: UserProfile = {
      ...createEmptyProfile(),
      brands: { 测试出版社: PROFILE_WEIGHT.cart },
    };
    expect(profileRecall(profile)).toEqual({ label: '测试出版社', source: 'cart' });
    expect(buildProfileHint(profile)).toContain('加购过测试出版社');
  });

  it('prompt 摘要只给偏好本身，不带内部字段', () => {
    const profile = mergeProfile(
      createEmptyProfile(),
      extractProfileSignals({ kind: 'order', items: [makeCartItem(book)] }),
    );
    const lines = profileSummaryLines(profile);
    expect(lines.some((line) => line.includes('图书'))).toBe(true);
    expect(lines.some((line) => line.includes('generation'))).toBe(false);
    expect(lines.some((line) => line.includes('source'))).toBe(false);
  });

  it('被改写的 localStorage 里出现非目录品类时，不进展示也不进 prompt', () => {
    const tampered: UserProfile = {
      ...createEmptyProfile(),
      preferredCategories: { 不存在品类: 5 } as UserProfile['preferredCategories'],
    };
    expect(categoryScores(tampered)).toEqual([]);
    expect(buildProfileHint(tampered)).toBe('');
    expect(profileSummaryLines(tampered)).toEqual([]);
  });
});