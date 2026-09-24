import { describe, expect, it } from 'vitest';
import { computeShippingFee, pickBestCoupon, summarizeCart } from '@/lib/cart-pricing';
import { SHIPPING } from '@/lib/types';
import { makeCartItem, makeProduct } from '@/lib/test-utils/factories';

describe('computeShippingFee：满额包邮门槛', () => {
  it('空车不收运费', () => {
    expect(computeShippingFee(0)).toBe(0);
  });

  it('达到门槛免运费，差 1 元就要收', () => {
    expect(computeShippingFee(SHIPPING.freeThreshold)).toBe(0);
    expect(computeShippingFee(SHIPPING.freeThreshold - 1)).toBe(SHIPPING.fee);
  });
});

describe('pickBestCoupon：自动选「满足门槛且抵扣最多」的一张', () => {
  it('未达最低门槛时没有可用券', () => {
    expect(pickBestCoupon(299)).toBeNull();
  });

  it('跨过门槛后选抵扣最大的那张', () => {
    expect(pickBestCoupon(300)?.amount).toBe(30);
    expect(pickBestCoupon(1000)?.amount).toBe(100);
    expect(pickBestCoupon(3000)?.amount).toBe(300);
  });
});

describe('summarizeCart：金额口径', () => {
  const item = makeCartItem(makeProduct({ price: 100, originalPrice: 150 }), 3);

  it('小计按现价合计，划线原价单独记录', () => {
    const summary = summarizeCart([item]);
    expect(summary.subtotal).toBe(300);
    expect(summary.originalSubtotal).toBe(450);
    expect(summary.saved).toBe(150);
    expect(summary.count).toBe(3);
  });

  it('实付 = 现价合计 - 优惠 + 运费，且不为负', () => {
    const summary = summarizeCart([item]);
    expect(summary.total).toBe(summary.subtotal - summary.discount + summary.shippingFee);
    expect(summary.total).toBeGreaterThanOrEqual(0);
  });

  it('空车实付为 0，不产生负数或 NaN', () => {
    const summary = summarizeCart([]);
    expect(summary.total).toBe(0);
    expect(summary.count).toBe(0);
    expect(summary.coupon).toBeNull();
  });
});

describe('summarizeCart：库存提醒不报件数', () => {
  it('缺货时提示「已缺货」', () => {
    const summary = summarizeCart([makeCartItem(makeProduct({ stock: 0 }), 1)]);
    expect(summary.stockWarnings).toEqual(['测试商品名称 已缺货']);
  });

  it('数量超过库存时提示「库存不足」，且**不含任何数字**', () => {
    // 件数是构建期派生值（21 + hash % 480），把它报给用户等于展示编造数据
    const summary = summarizeCart([makeCartItem(makeProduct({ stock: 5 }), 9)]);
    expect(summary.stockWarnings).toHaveLength(1);
    expect(summary.stockWarnings[0]).toContain('库存不足');
    expect(/\d/.test(summary.stockWarnings[0] ?? '')).toBe(false);
  });

  it('库存充足时不产生提醒', () => {
    const summary = summarizeCart([makeCartItem(makeProduct({ stock: 50 }), 2)]);
    expect(summary.stockWarnings).toEqual([]);
  });
});
