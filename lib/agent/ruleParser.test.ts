import { describe, expect, it } from 'vitest';
import {
  describeFilters,
  detectSort,
  extractFiltersByRules,
  guessIntentByRules,
  loosenFilters,
  parsePriceRange,
  relaxFilters,
} from '@/lib/agent/ruleParser';

/**
 * 规则解析器是「无 API Key」时的主路径，也是 LLM 失败后的兜底。
 * 它的词表全部从商品目录派生，所以这里同时锁住「不会解析出库里没有的词」这个性质。
 */

describe('guessIntentByRules：意图分类', () => {
  it('对比 / 结算 / 加购 / 细化 / 搜索分别命中对应意图', () => {
    expect(guessIntentByRules('帮我对比这几款')).toBe('compare');
    expect(guessIntentByRules('结算')).toBe('checkout');
    expect(guessIntentByRules('加入购物车')).toBe('cart');
    expect(guessIntentByRules('再便宜一点')).toBe('refine');
    expect(guessIntentByRules('想买一双跑鞋')).toBe('search');
  });

  it('空输入与无关输入落到 chat', () => {
    expect(guessIntentByRules('')).toBe('chat');
    expect(guessIntentByRules('今天天气不错')).toBe('chat');
  });

  it('对比优先于搜索：同时出现「推荐」和「对比」时判为对比', () => {
    expect(guessIntentByRules('推荐几款并帮我对比')).toBe('compare');
  });
});

describe('parsePriceRange：价格区间', () => {
  it('「以内 / 以下」只给上限', () => {
    expect(parsePriceRange('500 元以内')).toEqual({ minPrice: undefined, maxPrice: 500 });
  });

  it('「左右 / 上下」给出上下浮动 20% 的区间', () => {
    expect(parsePriceRange('2000 左右的耳机')).toEqual({ minPrice: 1600, maxPrice: 2400 });
  });

  it('区间表达按大小归位，顺序写反也能纠正', () => {
    expect(parsePriceRange('800 到 300 元')).toEqual({ minPrice: 300, maxPrice: 800 });
  });

  it('没有价格信息时两个边界都是 undefined', () => {
    expect(parsePriceRange('推荐几本书')).toEqual({
      minPrice: undefined,
      maxPrice: undefined,
    });
  });
});

describe('extractFiltersByRules：自然语言 → 筛选条件', () => {
  it('品类词同时确定 category 与规范化关键词', () => {
    const filters = extractFiltersByRules('500 元以内的跑鞋');
    expect(filters.category).toBe('运动');
    expect(filters.maxPrice).toBe(500);
  });

  it('图书走「书」这个词（不依赖英文类目）', () => {
    const filters = extractFiltersByRules('推荐几本书');
    expect(filters.category).toBe('图书');
  });

  it('关键词只可能来自目录里真实存在的词', () => {
    const filters = extractFiltersByRules('帮我找一下不存在的东西xyzzy');
    expect(filters.category).toBeUndefined();
    for (const keyword of filters.keywords ?? []) {
      expect(keyword).not.toContain('xyzzy');
    }
  });
});

describe('detectSort：排序意图', () => {
  it('识别价格 / 评分 / 销量排序', () => {
    expect(detectSort('最便宜的')).toBe('price_asc');
    expect(detectSort('评分最高的')).toBe('rating');
    expect(detectSort('销量最高')).toBe('sales');
  });

  it('没有排序意图时返回 undefined', () => {
    expect(detectSort('推荐几本书')).toBeUndefined();
  });
});

describe('relaxFilters：细化场景的增量调整', () => {
  it('「再便宜一点」把价格上限下调 30%', () => {
    const next = relaxFilters({ maxPrice: 500 }, '再便宜一点');
    expect(next.maxPrice).toBe(350);
  });

  it('没有上限时按下限 +200 兜底', () => {
    const next = relaxFilters({ minPrice: 300 }, '再便宜一点');
    expect(next.maxPrice).toBe(500);
  });

  it('「轻一点」追加轻量标签且不丢原标签', () => {
    const next = relaxFilters({ tags: ['透气'] }, '要轻一点的');
    expect(next.tags).toEqual(['透气', '轻量']);
  });

  it('无相对表述时条件保持不变（只更新 rawQuery）', () => {
    const next = relaxFilters({ maxPrice: 500 }, '随便看看');
    expect(next.maxPrice).toBe(500);
  });
});

describe('loosenFilters：检索为空时逐级放宽', () => {
  it('放宽顺序为 标签 → 关键词 → 价格 → 品类', () => {
    expect(loosenFilters({ tags: ['透气'], keywords: ['跑鞋'] }).tags).toBeUndefined();
    expect(loosenFilters({ keywords: ['跑鞋'], maxPrice: 500 }).keywords).toBeUndefined();
    expect(loosenFilters({ maxPrice: 500, category: '运动' }).maxPrice).toBe(750);
    expect(loosenFilters({ category: '运动' }).category).toBeUndefined();
  });

  it('已无任何条件时原样返回，不会死循环', () => {
    expect(loosenFilters({})).toEqual({});
  });
});

describe('describeFilters：条件回显', () => {
  it('空条件显示「全部商品」', () => {
    expect(describeFilters({})).toBe('全部商品');
  });

  it('拼出品类、关键词、价格与评分', () => {
    const text = describeFilters({
      category: '运动',
      keywords: ['跑鞋'],
      maxPrice: 500,
      minRating: 4.5,
    });
    expect(text).toContain('运动');
    expect(text).toContain('跑鞋');
    expect(text).toContain('¥500 以内');
    expect(text).toContain('4.5 分以上');
  });
});
