import { describe, expect, it } from 'vitest';
import { buildDecisionReasons } from '@/lib/decision';
import { makeComparison, makeProduct } from '@/lib/test-utils/factories';

/**
 * 决策推荐是「把推荐理由量化」的地方，也是最容易把派生数据包装成事实的地方：
 * 曾经会输出「库存最充足（231 件）· 下单后发货更快」，而 231 是哈希派生值。
 */

const cheap = makeProduct({ id: 'a', name: '便宜款', price: 100, rating: 4.8, stock: 50 });
const pricey = makeProduct({ id: 'b', name: '昂贵款', price: 300, rating: 4.2, stock: 30 });

const base = {
  products: [cheap, pricey],
  valueScores: { a: 95, b: 60 },
  highlights: {
    lowestPriceId: 'a',
    highestRatingId: 'a',
    highestSalesId: '',
    mostStockId: 'a',
    bestValueId: 'a',
  },
};

describe('buildDecisionReasons：基本约束', () => {
  it('少于 2 件商品时不给推荐', () => {
    expect(buildDecisionReasons(makeComparison({ products: [cheap] }))).toEqual([]);
  });

  it('每条理由都锚定到具体商品，分数在 0 - 100 之间', () => {
    const reasons = buildDecisionReasons(makeComparison(base));
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(reason.productId).not.toBe('');
      expect(reason.score).toBeGreaterThanOrEqual(0);
      expect(reason.score).toBeLessThanOrEqual(100);
    }
  });
});

describe('buildDecisionReasons：没有真实销量就不给「销量最高」', () => {
  it('highestSalesId 为空 → 不产出该条', () => {
    const reasons = buildDecisionReasons(makeComparison(base));
    expect(reasons.map((reason) => reason.label)).not.toContain('销量最高');
  });

  it('highestSalesId 有值 → 产出该条并带销量口径', () => {
    const reasons = buildDecisionReasons(
      makeComparison({ ...base, highlights: { ...base.highlights, highestSalesId: 'a' } }),
    );
    const sales = reasons.find((reason) => reason.label === '销量最高');
    expect(sales?.productName).toBe('便宜款');
  });
});

describe('buildDecisionReasons：库存只讲现货，不讲件数', () => {
  it('mostStockId 为空 → 不产出「现货可发」', () => {
    const reasons = buildDecisionReasons(
      makeComparison({ ...base, highlights: { ...base.highlights, mostStockId: '' } }),
    );
    expect(reasons.map((reason) => reason.label)).not.toContain('现货可发');
  });

  it('标签不再使用「最充足」这类程度词', () => {
    const reasons = buildDecisionReasons(makeComparison(base));
    const labels = reasons.map((reason) => reason.label);
    expect(labels).toContain('现货可发');
    expect(labels).not.toContain('库存最充足');
  });

  it('详情文案不含任何件数', () => {
    // 件数是构建期派生值（21 + hash % 480），展示它等于把编造数据当事实
    const reasons = buildDecisionReasons(makeComparison(base));
    const stock = reasons.find((reason) => reason.label === '现货可发');
    expect(stock?.detail).toBe('有货 · 下单后发货更快');
    expect(/\d/.test(stock?.detail ?? '')).toBe(false);
  });

  it('分数按库存等级映射（有货 = 100），不按派生件数打分', () => {
    const reasons = buildDecisionReasons(makeComparison(base));
    const stock = reasons.find((reason) => reason.label === '现货可发');
    expect(stock?.score).toBe(100);
  });

  it('缺货商品对应的等级文案是「缺货」', () => {
    const soldOut = makeProduct({ id: 'c', name: '缺货款', stock: 0 });
    const reasons = buildDecisionReasons(
      makeComparison({
        products: [cheap, soldOut],
        valueScores: { a: 90, c: 10 },
        highlights: { ...base.highlights, mostStockId: 'c' },
      }),
    );
    const stock = reasons.find((reason) => reason.label === '现货可发');
    expect(stock?.detail).toBe('缺货 · 下单后发货更快');
    expect(stock?.tone).toBe('warning');
  });
});
