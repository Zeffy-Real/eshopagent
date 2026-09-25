import { describe, expect, it } from 'vitest';
import rawCatalog from '@/data/real-catalog.json';
import {
  FIELD_TRUTH,
  FIELD_TRUTH_LEVEL_LABEL,
  buildCatalogClientPayload,
  computeCatalogCoverage,
  computeCategoryCounts,
  computePlatformCounts,
  type FieldTruthLevel,
} from '@/lib/catalog/field-truth';
import { CATALOG_META, PRODUCTS, getFeaturedProducts } from '@/lib/catalog/products';
import { makeProduct } from '@/lib/test-utils/factories';
import type { CatalogMeta } from '@/lib/catalog/products';

/**
 * 「数据快照」面板的数据源：分级表 + 派生统计。
 *
 * 两条不能破的约束：
 *   1. 分级表必须**四类齐全**且派生项写明生成方式（否则界面会退化成「真实/不确定」两档，
 *      等于把派生值冒充成原始数据）；
 *   2. 覆盖率与分布必须是**派生**的——这里对真实产物交叉校验，并显式断言「不是硬编码」：
 *      把目录换掉（用构造数据）时数字必须跟着变。
 */

const LEVELS: FieldTruthLevel[] = ['real', 'derived', 'localized', 'missing'];

describe('FIELD_TRUTH：字段真实性分级表', () => {
  it('四类分级都有条目，且每条都写了来源/生成方式', () => {
    const used = new Set(FIELD_TRUTH.map((row) => row.level));
    for (const level of LEVELS) {
      expect(used.has(level), `缺少「${FIELD_TRUTH_LEVEL_LABEL[level]}」分级`).toBe(true);
    }
    for (const row of FIELD_TRUTH) {
      expect(row.field.trim().length).toBeGreaterThan(0);
      expect(row.detail.trim().length).toBeGreaterThan(8);
    }
  });

  it('派生项写明了生成方式（不是「系统生成」这类空话）', () => {
    const derived = FIELD_TRUTH.filter((row) => row.level === 'derived');
    expect(derived.length).toBeGreaterThan(0);
    for (const row of derived) {
      expect(row.detail).toMatch(/派生|拼装|扫|信号|哈希/);
    }
  });

  it('库存件数与图书简介这两条派生项在表里（README 与 project-status 也点名它们）', () => {
    const fields = FIELD_TRUTH.map((row) => row.field);
    expect(fields).toContain('库存件数');
    expect(fields).toContain('图书简介');
  });
});

describe('覆盖率与分布：从数据派生，不写死', () => {
  it('总数与产物里的件数一致（目录里的条目全部通过运行时校验）', () => {
    const coverage = computeCatalogCoverage(PRODUCTS);
    for (const row of coverage) {
      expect(row.total).toBe(PRODUCTS.length);
      expect(row.covered).toBeLessThanOrEqual(row.total);
    }
    // 交叉校验：产物自己声明的 count 与实际加载到的件数必须相同
    expect(PRODUCTS.length).toBe((rawCatalog as { count: number }).count);
    expect(PRODUCTS.length).toBe((rawCatalog as { products: unknown[] }).products.length);
  });

  it('销量覆盖率与产物里 sales > 0 的条数一致', () => {
    const rawProducts = (rawCatalog as { products: { sales?: number }[] }).products;
    const expected = rawProducts.filter((product) => (product.sales ?? 0) > 0).length;
    const salesRow = computeCatalogCoverage(PRODUCTS).find((row) => row.label === '销量');
    expect(salesRow?.covered).toBe(expected);
  });

  it('换一份数据时数字跟着变（证明没有硬编码 112 / 16）', () => {
    const sample = [
      makeProduct({ id: 'a', sales: 10, rating: 4.5, price: 100, originalPrice: 150 }),
      makeProduct({ id: 'b', sales: 0, rating: 0, price: 200, originalPrice: 200 }),
      makeProduct({ id: 'c', sales: 0, rating: 4.1, price: 300, originalPrice: 250 }),
    ];
    const coverage = computeCatalogCoverage(sample);
    const byLabel = Object.fromEntries(coverage.map((row) => [row.label, row]));
    expect(byLabel['销量']).toMatchObject({ covered: 1, total: 3 });
    expect(byLabel['评分']).toMatchObject({ covered: 2, total: 3 });
    expect(byLabel['划线价']).toMatchObject({ covered: 1, total: 3 });
  });

  it('平台分布：计数之和等于总数，且按件数降序', () => {
    const platforms = computePlatformCounts(PRODUCTS);
    const sum = platforms.reduce((total, item) => total + item.count, 0);
    expect(sum).toBe(PRODUCTS.length);
    let previous = Number.POSITIVE_INFINITY;
    for (const item of platforms) {
      expect(item.count).toBeLessThanOrEqual(previous);
      previous = item.count;
    }
    // 交叉校验：产物里的 platforms 列表必须都在分布里
    const rawPlatforms = (rawCatalog as { platforms: string[] }).platforms;
    for (const platform of rawPlatforms) {
      expect(platforms.map((item) => item.platform)).toContain(platform);
    }
  });
});

describe('buildCatalogClientPayload：服务端注入客户端的轻量数据', () => {
  const payload = buildCatalogClientPayload({
    products: PRODUCTS,
    meta: CATALOG_META,
    featured: getFeaturedProducts(12),
  });

  it('件数 / 品类计数 / 覆盖率 / 平台分布与直接读目录算出来的一致', () => {
    expect(payload.source).toBe(CATALOG_META.source);
    // 与中栏徽标读的是同一个对象——两处数字不可能不同
    expect(payload.meta).toBe(CATALOG_META);
    expect(payload.categoryCounts).toEqual(computeCategoryCounts(PRODUCTS));
    expect(Object.values(payload.categoryCounts).reduce((sum, count) => sum + count, 0)).toBe(
      PRODUCTS.length,
    );
    expect(payload.coverage).toEqual(computeCatalogCoverage(PRODUCTS));
    expect(payload.platformCounts).toEqual(computePlatformCounts(PRODUCTS));
    // 首屏推荐来自调用方传入的 getFeaturedProducts（排序规则只有一份实现）
    expect(payload.featured).toHaveLength(12);
    expect(payload.featured.map((product) => product.id)).toEqual(
      getFeaturedProducts(12).map((product) => product.id),
    );
  });

  it('换一份目录（切源 / 换产物）时数字跟着变——证明没有任何写死的计数', () => {
    const sample = [
      makeProduct({ id: 'a', category: '数码', platform: 'Amazon', sales: 5 }),
      makeProduct({ id: 'b', category: '图书', platform: 'Amazon', sales: 0 }),
      makeProduct({ id: 'c', category: '图书', platform: 'Walmart', sales: 0 }),
    ];
    const sampleMeta: CatalogMeta = { ...CATALOG_META, count: 3, source: 'mock' };
    const built = buildCatalogClientPayload({
      products: sample,
      meta: sampleMeta,
      featured: sample.slice(0, 2),
    });

    expect(built.source).toBe('mock');
    expect(built.categoryCounts).toMatchObject({ 图书: 2, 数码: 1, 食品: 0 });
    expect(built.coverage.find((row) => row.label === '销量')).toMatchObject({
      covered: 1,
      total: 3,
    });
    expect(built.platformCounts).toEqual([
      { platform: 'Amazon', count: 2 },
      { platform: 'Walmart', count: 1 },
    ]);
    expect(built.featured).toHaveLength(2);
  });
});