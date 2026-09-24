import { describe, expect, it } from 'vitest';
import { discountLabel, formatCount, formatPrice, hasRealSales } from '@/lib/utils';

/**
 * 这些函数是「口径一致性的唯一实现」：卡片、详情、对比表、决策推荐、LLM 上下文
 * 全部从这里取字符串。它们一旦被改错，界面与 LLM 会同时出现分叉。
 */

describe('formatCount：销量 / 评价数的统一展示口径', () => {
  it('小于 1 万按千分位展示', () => {
    expect(formatCount(9999)).toBe('9,999');
    expect(formatCount(1)).toBe('1');
  });

  it('达到 1 万用「万」并保留 1 位小数（四舍五入）', () => {
    expect(formatCount(10000)).toBe('1.0万');
    expect(formatCount(122000)).toBe('12.2万');
  });

  it('0 / 负数 / NaN 统一返回 0，不产生 NaN 或 -1', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(-1)).toBe('0');
    expect(formatCount(Number.NaN)).toBe('0');
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('0');
  });

  it('回归：84507 必须是「8.5万」而不是截断出来的「8.4万」', () => {
    // 这个数字曾经在卡片（四舍五入 → 8.5万）与 LLM 回复（自己截断 → 8.4万）
    // 之间分叉，用户会直接怀疑数据是编的
    expect(formatCount(84507)).toBe('8.5万');
    expect(formatCount(84507)).not.toBe('8.4万');
  });
});

describe('hasRealSales：sales === 0 表示「该来源无销量数据」', () => {
  it('正数视为有真实销量', () => {
    expect(hasRealSales(1)).toBe(true);
    expect(hasRealSales(84507)).toBe(true);
  });

  it('0 视为无销量数据（语义是「没有数据」，不是「卖了 0 件」）', () => {
    expect(hasRealSales(0)).toBe(false);
  });

  it('负数与 NaN 一律视为无数据', () => {
    expect(hasRealSales(-5)).toBe(false);
    expect(hasRealSales(Number.NaN)).toBe(false);
  });
});

describe('formatPrice / discountLabel', () => {
  it('价格带 ¥ 前缀与千分位', () => {
    expect(formatPrice(1299)).toBe('¥1,299');
    expect(formatPrice(42)).toBe('¥42');
  });

  it('原价不高于现价、或原价非法时不给折扣标签', () => {
    expect(discountLabel(100, 100)).toBeNull();
    expect(discountLabel(100, 80)).toBeNull();
    expect(discountLabel(100, 0)).toBeNull();
  });

  it('折扣按四舍五入取整百分比', () => {
    expect(discountLabel(799, 1000)).toBe('省 20%');
    expect(discountLabel(75, 166)).toBe('省 55%');
  });
});
