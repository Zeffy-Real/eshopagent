import { describe, expect, it } from 'vitest';
import { loadBrowseProducts, selectBrowseProducts } from '@/lib/catalog/browse-products';
import { PRODUCTS } from '@/lib/catalog/products';
import { makeProduct } from '@/lib/test-utils/factories';

/**
 * 浏览视图（中栏覆盖层）的三种数据来源 —— **同一个视图组件**：
 * 品类 chip（品类全量）/「无筛选条件 → 看全部」（整个目录，客户端现算）/「查看全部 N 件」（命中 id 列表）。
 *
 * 纯函数 `selectBrowseProducts` 是唯一的挑选实现，`loadBrowseProducts` 只负责按需取目录；
 * 这个模块单独存在就是为了让它们随浏览视图一起进按需 chunk（不进首屏 bundle）。
 */
describe('selectBrowseProducts：三种来源的挑选规则', () => {
  const digital = makeProduct({ id: 'd1', category: '数码' });
  const digital2 = makeProduct({ id: 'd2', category: '数码' });
  const book = makeProduct({ id: 'b1', category: '图书' });
  const catalog = [digital, book, digital2];

  it('品类 → 只挑该品类（目录顺序不变）', () => {
    expect(selectBrowseProducts(catalog, { kind: 'category', category: '数码' })).toEqual([
      digital,
      digital2,
    ]);
  });

  it('全量 → 原样返回（排序交给展示层的排序控件，这里不重排）', () => {
    expect(selectBrowseProducts(catalog, { kind: 'all' })).toBe(catalog);
  });

  it('id 列表 → 保序、目录里没有的跳过（对话命中的顺序就是展示顺序）', () => {
    expect(selectBrowseProducts(catalog, { kind: 'ids', ids: ['b1', 'missing', 'd1'] })).toEqual([
      book,
      digital,
    ]);
    expect(selectBrowseProducts(catalog, { kind: 'ids', ids: [] })).toEqual([]);
  });
});

describe('loadBrowseProducts：按需加载真实目录', () => {
  it('品类与全量都从目录现算，件数与目录一致', async () => {
    const books = await loadBrowseProducts({ kind: 'category', category: '图书' });
    expect(books?.length).toBe(PRODUCTS.filter((product) => product.category === '图书').length);
    expect(books?.every((product) => product.category === '图书')).toBe(true);

    const all = await loadBrowseProducts({ kind: 'all' });
    expect(all?.length).toBe(PRODUCTS.length);
  });

  it('id 列表用目录查找（「查看全部 N 件」走这条）', async () => {
    const [first = '', second = ''] = PRODUCTS.slice(0, 2).map((product) => product.id);
    const picked = await loadBrowseProducts({ kind: 'ids', ids: [second, 'not-in-catalog', first] });
    expect(picked?.map((product) => product.id)).toEqual([second, first]);
  });
});