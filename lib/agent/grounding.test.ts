import { describe, expect, it } from 'vitest';
import { checkGrounding, extractAmounts } from '@/lib/agent/grounding';
import { makeCartItem, makeProduct, makeState } from '@/lib/test-utils/factories';

/**
 * 落地校验是「LLM 输出不可信」这条假设的执行者：
 * 回复里任何一个 ¥ 金额对不上真实数据，就必须判定为未落地并改用模板回复。
 */

const product = makeProduct({
  id: 'amz-test',
  name: '测试耳机',
  price: 299,
  originalPrice: 399,
  sales: 84507,
  reviews: 1000,
});

describe('extractAmounts：抽取回复中的金额', () => {
  it('支持千分位与小数', () => {
    expect(extractAmounts('售价 ¥1,299 与 ¥42.5')).toEqual([1299, 42.5]);
  });

  it('没有金额时返回空数组', () => {
    expect(extractAmounts('这件商品还不错')).toEqual([]);
  });
});

describe('checkGrounding：金额必须来自真实数据', () => {
  const state = makeState({ searchResults: [product] });

  it('商品真实价格 → 落地', () => {
    expect(checkGrounding('这件 ¥299 很划算', state).grounded).toBe(true);
  });

  it('划线原价也算合法金额', () => {
    expect(checkGrounding('原价 ¥399，现价 ¥299', state).grounded).toBe(true);
  });

  it('价差（省下的钱）算合法金额', () => {
    expect(checkGrounding('省 ¥100', state).grounded).toBe(true);
  });

  it('编造的价格 → 未落地，并记录具体金额', () => {
    const result = checkGrounding('这件只要 ¥99', state);
    expect(result.grounded).toBe(false);
    expect(result.unknownAmounts).toEqual([99]);
  });

  it('购物车小计算合法金额', () => {
    const cartState = makeState({ cart: [makeCartItem(product, 2)] });
    expect(checkGrounding('合计 ¥598', cartState).grounded).toBe(true);
  });

  it('空状态时任何金额都不落地（不能凭空引用）', () => {
    const empty = makeState();
    expect(checkGrounding('只要 ¥299', empty).grounded).toBe(false);
  });
});

describe('checkGrounding：销量 / 评价数的「万」口径', () => {
  const state = makeState({ searchResults: [product] });

  it('与界面口径一致（8.5万）→ 落地', () => {
    expect(checkGrounding('销量 8.5万', state).grounded).toBe(true);
  });

  it('自己截断成 8.4万 → 未落地（同一数字两种口径会让用户怀疑数据）', () => {
    const result = checkGrounding('销量 8.4万', state);
    expect(result.grounded).toBe(false);
    expect(result.mismatchedCounts).toContain('8.4万');
  });

  it('评价数的口径同样受校验', () => {
    expect(checkGrounding('评价 1,000 条', state).grounded).toBe(true);
    expect(checkGrounding('评价 9.9万', state).grounded).toBe(false);
  });
});

describe('checkGrounding：无真实销量的商品不登记销量口径', () => {
  it('sales = 0 时，只有评价数的「万」口径是合法的', () => {
    const noSales = makeProduct({ sales: 0, reviews: 84507 });
    const state = makeState({ searchResults: [noSales] });
    expect(checkGrounding('评价 8.5万', state).grounded).toBe(true);
    // 该商品没有真实销量，任何销量口径都不该被判为落地
    expect(checkGrounding('销量 8.5万', state).grounded).toBe(false);
  });
});
