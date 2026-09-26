import { describe, expect, it } from 'vitest';
import {
  describeFilters,
  detectClearAll,
  detectSort,
  extractFiltersByRules,
  guessIntentByRules,
  loosenFilters,
  parseOrdinalIndex,
  parsePriceRange,
  relaxFilters,
} from '@/lib/agent/ruleParser';
import { CATEGORIES } from '@/lib/types';

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

  it('序数 / 替换类指代判为 refine（判成 search 会丢掉上一轮条件、放宽范围）', () => {
    expect(guessIntentByRules('换成第二件')).toBe('refine');
    expect(guessIntentByRules('换个便宜的')).toBe('refine');
    expect(guessIntentByRules('要第三个')).toBe('refine');
  });

  it('明确说出新品类时不能被替换规则吞成 refine', () => {
    // 「换成耳机」是明确的新目标，必须走搜索语义；若被误判为 refine，
    // 会沿用上一轮的图书条件，用户要耳机却拿到书
    expect(guessIntentByRules('推荐点耳机')).toBe('search');
    expect(guessIntentByRules('换成耳机')).not.toBe('refine');
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

describe('parseOrdinalIndex：序数指代', () => {
  it('识别中文与阿拉伯数字的序数', () => {
    expect(parseOrdinalIndex('换成第二件')).toBe(2);
    expect(parseOrdinalIndex('要第 3 个')).toBe(3);
    expect(parseOrdinalIndex('换成第2款')).toBe(2);
    expect(parseOrdinalIndex('第三本')).toBe(3);
  });

  it('没有「第」字前缀时不算序数（「3 件」是数量）', () => {
    expect(parseOrdinalIndex('要 3 件')).toBeNull();
    expect(parseOrdinalIndex('推荐几本书')).toBeNull();
  });

  it('越界或无法识别时返回 null', () => {
    expect(parseOrdinalIndex('第 99 件')).toBeNull();
    expect(parseOrdinalIndex('第 0 件')).toBeNull();
    expect(parseOrdinalIndex('第很多件')).toBeNull();
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

  // 2026-09-26（③ 同轮）：乘法放宽没有上限保证，「¥100000 以上」再「再便宜点」
  // 会产出 minPrice 100000 > maxPrice 70140 —— 反向区间检索必然为空，且像「放宽反而清空」。
  it('反向区间被 clamp 成单点区间，不再出现 min > max', () => {
    const next = relaxFilters({ minPrice: 100000, maxPrice: 100200 }, '再便宜点');
    expect(next.maxPrice).toBe(100000);
    expect(next.minPrice).toBe(100000);
  });

  it('正常区间不受 clamp 影响', () => {
    const next = relaxFilters({ minPrice: 300, maxPrice: 500 }, '再便宜点');
    expect(next.maxPrice).toBe(350);
    expect(next.minPrice).toBe(300);
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

/* ============================================================
   「看全部 / 清空条件」判据（2026-09-26 修 §8-37）

   背景：脏会话里「让我看看所有 420 件商品」不清空上一轮的「数码」——
   判据原来只有「新目标 → 重置细分条件」与「否则 → 全量继承」两支，
   「用户要看全部」落在缝隙里（实测 LLM 不回写时旧条件照样残留）。
   判据只看**用户原话**，因此下面这组用例同时是产品词表的锁定。
   ============================================================ */
describe('detectClearAll：看全部 / 清空条件判据', () => {
  it('正例：浏览动词 + 聚合词', () => {
    expect(detectClearAll('让我看看所有420件商品')).toBe(true);
    expect(detectClearAll('不限品类，看看全部商品')).toBe(true);
    expect(detectClearAll('看看所有商品')).toBe(true);
    expect(detectClearAll('我想浏览全部商品')).toBe(true);
    expect(detectClearAll('显示所有商品')).toBe(true);
    expect(detectClearAll('列出整个目录')).toBe(true);
    expect(detectClearAll('看看 420 件商品')).toBe(true);
  });

  it('正例：清空类动词单出现即命中', () => {
    expect(detectClearAll('清空条件')).toBe(true);
    expect(detectClearAll('重置')).toBe(true);
    expect(detectClearAll('从头开始')).toBe(true);
    expect(detectClearAll('重新开始')).toBe(true);
    expect(detectClearAll('随便看看')).toBe(true);
    expect(detectClearAll('随便逛逛')).toBe(true);
    expect(detectClearAll('都行')).toBe(true);
  });

  it('边界 22 / 23：字段级重置不支持 —— 「重置预算」「不限品牌」清空的是整份条件', () => {
    expect(detectClearAll('重置预算')).toBe(true);
    expect(detectClearAll('不限品牌')).toBe(true);
  });

  it('反例：排除词（问数量 / 金额）不清空', () => {
    expect(detectClearAll('所有商品加起来多少钱')).toBe(false);
    expect(detectClearAll('所有商品的平均评分是多少')).toBe(false);
    expect(detectClearAll('一共有几件商品')).toBe(false);
    expect(detectClearAll('帮我统计所有商品')).toBe(false);
    expect(detectClearAll('所有商品的总价')).toBe(false);
  });

  it('反例：原话点名了东西就不算「看全部」（边界 21）', () => {
    expect(detectClearAll('看看所有小说')).toBe(false);
    expect(detectClearAll('推荐几本小说')).toBe(false);
    expect(detectClearAll('帮我看看数码的商品')).toBe(false);
  });

  it('反例：无聚合词 / 浏览动词的句子不清空', () => {
    expect(detectClearAll('换成第二件')).toBe(false);
    expect(detectClearAll('再便宜点')).toBe(false);
    expect(detectClearAll('全部加入购物车')).toBe(false);
    expect(detectClearAll('对比前 3 件')).toBe(false);
    expect(detectClearAll('看看 20 件商品')).toBe(false);
    expect(detectClearAll('今天天气不错')).toBe(false);
  });

  it('目录里的商品名含「所有」不构成伪点名（「适用于所有车辆」/「适合所有肤质」）', () => {
    // n-gram 会把「所有」当关键词（目录里确有两个商品名含它），但触发词不算检索目标：
    // 解析器已剔除（2026-09-26），否则「看看所有商品」会被判成「点名了某个词」而漏掉清空
    expect(extractFiltersByRules('看看所有商品').keywords ?? []).not.toContain('所有');
    expect(detectClearAll('看看所有商品')).toBe(true);
  });

  it('触发词被剔除后，统计类句子也不会把「所有」当条件带进检索', () => {
    expect(extractFiltersByRules('所有商品加起来多少钱').keywords ?? []).toEqual([]);
    expect(extractFiltersByRules('所有商品的平均评分是多少').keywords ?? []).toEqual([]);
  });
});

describe('guessIntentByRules：清空类表达强制 search（无 Key 降级路径）', () => {
  it('「看看所有商品」「清空条件」「不限品牌」判为 search', () => {
    expect(guessIntentByRules('看看所有商品')).toBe('search');
    // 「清空」会撞上加购词表的「清空」，必须靠清空判据前置抢回
    expect(guessIntentByRules('清空条件')).toBe('search');
    expect(guessIntentByRules('不限品牌')).toBe('search');
    expect(guessIntentByRules('都行')).toBe('search');
  });

  it('加购 / 对比 / 细化不受影响（只接 detectClearAll，不扩充通用词表）', () => {
    expect(guessIntentByRules('全部加入购物车')).toBe('cart');
    expect(guessIntentByRules('把购物车清空')).toBe('cart');
    expect(guessIntentByRules('对比前 3 件')).toBe('compare');
    expect(guessIntentByRules('换成第二件')).toBe('refine');
    expect(guessIntentByRules('再便宜一点')).toBe('refine');
  });
});

describe('品类名与规则路径的品类浏览（2026-09-26 修）', () => {
  it('7 个品类名都能解析出对应 category 与 search 意图（品类 chip 在无 Key 下可用）', () => {
    for (const category of CATEGORIES) {
      const text = `帮我看看${category}的商品`;
      expect(guessIntentByRules(text)).toBe('search');
      expect(extractFiltersByRules(text).category).toBe(category);
    }
  });

  it('闲聊不会被品类规则误判成搜索', () => {
    expect(guessIntentByRules('你好')).toBe('chat');
    expect(guessIntentByRules('谢谢')).toBe('chat');
  });

  it('回归：「推荐几本小说」仍是 search（规则路径「小说」进 tags，字段名差异见 §8-20）', () => {
    expect(guessIntentByRules('推荐几本小说')).toBe('search');
    const filters = extractFiltersByRules('推荐几本小说');
    // 规则路径不推品类（「小说」不是品类词，不加词表扩展）；「图书 + 小说」是 LLM 路径的输出。
    // 「小说」落进 tags 是规则解析器的既有语义（意图面板显示「功能 小说」，§8-20 刻意不改）。
    expect(filters.category).toBeUndefined();
    expect(filters.tags).toContain('小说');
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

  // 2026-09-25：同一 thread 先走 LLM 解析、再走规则解析时，同一题材词会同时落在
  // keywords 与 tags，条件串曾出现「图书 · 小说 · 小说」（见 demo-rehearsal.md §6.2 C1）。
  it('跨列表重复词只出现一次（同词同时在 keywords 与 tags）', () => {
    expect(describeFilters({ category: '图书', keywords: ['小说'], tags: ['小说'] })).toBe(
      '图书 · 小说',
    );
  });

  it('跨列表去重同样覆盖 品类 / 品牌 与列表之间的重复', () => {
    expect(
      describeFilters({ category: '数码', keywords: ['数码'], brands: ['Sony'], tags: ['Sony'] }),
    ).toBe('数码 · Sony');
  });

  it('不同词的内容与顺序不变（品类 → 关键词 → 标签 → 品牌 → 价格 → 评分）', () => {
    expect(
      describeFilters({
        category: '数码',
        keywords: ['降噪'],
        tags: ['轻量', '透气'],
        brands: ['Sony'],
        minPrice: 100,
        maxPrice: 500,
        minRating: 4.5,
      }),
    ).toBe('数码 · 降噪 · 轻量 透气 · Sony · ¥100 - ¥500 · 4.5 分以上');
  });
});
