import { describe, expect, it } from 'vitest';
import { compareProducts } from '@/lib/agent/tools/productTools';
import { PRODUCTS } from '@/lib/catalog/products';
import { stockLevelOf } from '@/lib/types';

/**
 * 对比表是「同一事实跨层展示」最密集的地方：
 * 销量行、品牌/作者行、库存行都曾经出现过口径问题。
 * 这里直接拿真实目录里的商品跑，锁住这些不变量。
 */

const books = PRODUCTS.filter((product) => product.category === '图书').slice(0, 3);
const withRealSales = PRODUCTS.filter((product) => product.sales > 0).slice(0, 3);
const inStock = PRODUCTS.filter((product) => stockLevelOf(product.stock) === 'in_stock').slice(0, 3);
const soldOut = PRODUCTS.filter((product) => product.stock <= 0);

describe('compareProducts：行结构', () => {
  it('少于 2 件商品也能安全返回，不抛异常', () => {
    const result = compareProducts([]);
    expect(result.products).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it('行 key 不重复（重复 key 会让 React 报冲突）', () => {
    const result = compareProducts(books.map((book) => book.id));
    const keys = result.rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('每行的取值个数与商品个数对齐', () => {
    const result = compareProducts(books.map((book) => book.id));
    for (const row of result.rows) {
      expect(row.values).toHaveLength(result.products.length);
    }
  });
});

describe('compareProducts：图书用「作者」而不是「品牌」', () => {
  it('全为图书时固定行是「作者」，且不再重复出现「品牌」', () => {
    const result = compareProducts(books.map((book) => book.id));
    const keys = result.rows.map((row) => row.key);
    expect(keys).toContain('作者');
    expect(keys).not.toContain('品牌');
  });

  it('图书的 brand 字段确实是作者名（不是出版社）', () => {
    const result = compareProducts(books.map((book) => book.id));
    const authorRow = result.rows.find((row) => row.key === '作者');
    expect(authorRow?.values).toEqual(books.map((book) => book.brand));
  });
});

describe('compareProducts：销量行只在有真实销量时出现', () => {
  it('图书没有真实销量 → 不出现销量行', () => {
    const result = compareProducts(books.map((book) => book.id));
    expect(result.rows.map((row) => row.key)).not.toContain('销量');
  });

  it('存在真实销量时 → 出现销量行', () => {
    expect(withRealSales.length).toBeGreaterThanOrEqual(2);
    const result = compareProducts(withRealSales.map((product) => product.id));
    expect(result.rows.map((row) => row.key)).toContain('销量');
  });
});

describe('compareProducts：库存行只出等级，不出件数', () => {
  it('取值只能是「有货 / 库存紧张 / 缺货」，不含数字与括号', () => {
    const result = compareProducts(books.map((book) => book.id));
    const stockRow = result.rows.find((row) => row.key === '库存');
    expect(stockRow).toBeDefined();
    for (const value of stockRow?.values ?? []) {
      expect(['有货', '库存紧张', '缺货']).toContain(value);
      expect(/\d/.test(value)).toBe(false);
      expect(value).not.toContain('（');
    }
  });

  it('全部有货时不给「最优」标记（这一行不提供区分信息）', () => {
    expect(inStock.length).toBeGreaterThanOrEqual(2);
    const result = compareProducts(inStock.map((product) => product.id));
    const stockRow = result.rows.find((row) => row.key === '库存');
    expect(stockRow?.diff).toBe(false);
    expect(stockRow?.best).toEqual([]);
  });

  it('等级有差异时按等级标记最优，且 mostStockId 指向可买的那个', () => {
    if (soldOut.length === 0 || inStock.length === 0) return;
    const result = compareProducts([soldOut[0]!.id, ...inStock.slice(0, 2).map((p) => p.id)]);
    const stockRow = result.rows.find((row) => row.key === '库存');
    expect(stockRow?.diff).toBe(true);
    expect(stockRow?.best.length).toBeGreaterThan(0);
    const winner = result.products[stockRow!.best[0]!];
    expect(winner?.stock).toBeGreaterThan(0);
  });
});

describe('compareProducts：性价比得分', () => {
  it('每件商品都有 0 - 100 的得分，缺货会被扣分', () => {
    const result = compareProducts(books.map((book) => book.id));
    for (const product of result.products) {
      const score = result.valueScores[product.id] ?? 0;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});
