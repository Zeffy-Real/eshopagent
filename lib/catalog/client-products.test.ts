import { describe, expect, it } from 'vitest';
import {
  loadInlineProducts,
  pickInlineProduct,
  pickInlineProducts,
  recallResolvedProduct,
  rememberResolvedProducts,
  resolveDetailProduct,
} from '@/lib/catalog/client-products';
import { makeProduct } from '@/lib/test-utils/factories';
import type { Product } from '@/lib/types';

/**
 * 客户端按 id 取商品的两条路径（客户端不再静态 import 全量目录，见该模块注释）。
 *
 * 必须锁死的三件事：
 *   1. **未命中 / 解析抛错都返回 null，不抛错**——目录里没有某个 id、或 chunk 加载失败，
 *      只意味着「这张卡片没得渲染」，不该让聊天气泡或弹窗崩掉；
 *   2. **详情弹窗读到的必须是叠加过实时覆盖的对象**——否则会出现
 *      「卡片显示实时价、弹窗显示快照价」这类分叉（上一轮刚验收过的「实时 · HH:mm」回归点）；
 *   3. **从哪张卡片点开就显示哪张卡片的商品**——解析顺序 = 渲染中的列表 → 会话缓存。
 */

const CATALOG_PRODUCT = makeProduct({ id: 'bk-0593105419', name: 'Where the Crawdads Sing' });

const LOOKUP = (id: string): Product | undefined =>
  id === CATALOG_PRODUCT.id ? CATALOG_PRODUCT : undefined;

describe('内联卡解析：pickInlineProduct / pickInlineProducts', () => {
  it('命中 id → 返回商品', () => {
    expect(pickInlineProduct('bk-0593105419', LOOKUP)).toBe(CATALOG_PRODUCT);
  });

  it('未命中 → 返回 null，且不抛错', () => {
    expect(pickInlineProduct('amz-not-in-catalog', LOOKUP)).toBeNull();
  });

  it('解析函数本身抛错 → 同样返回 null（chunk 加载失败只少一张卡片，不让气泡崩掉）', () => {
    const throwing = (): Product | undefined => {
      throw new Error('chunk load failed');
    };
    expect(() => pickInlineProduct('x', throwing)).not.toThrow();
    expect(pickInlineProduct('x', throwing)).toBeNull();
  });

  it('一批 id：保序、未命中的跳过', () => {
    const second = makeProduct({ id: 'amz-B000TEST01' });
    const lookup = (id: string) => (id === CATALOG_PRODUCT.id ? CATALOG_PRODUCT : id === second.id ? second : undefined);
    expect(pickInlineProducts([second.id, 'missing', CATALOG_PRODUCT.id], lookup)).toEqual([
      second,
      CATALOG_PRODUCT,
    ]);
    expect(pickInlineProducts([], lookup)).toEqual([]);
  });
});

describe('详情弹窗的商品解析：resolveDetailProduct', () => {
  const liveOverride = { ...CATALOG_PRODUCT, price: 199, stock: 40 };

  it('传进去的商品已叠加实时覆盖 → 弹窗读到的就是覆盖后的价格（「实时 · HH:mm」不会丢）', () => {
    const resolved = resolveDetailProduct(
      CATALOG_PRODUCT.id,
      LOOKUP,
      { [CATALOG_PRODUCT.id]: liveOverride },
    );
    expect(resolved?.price).toBe(199);
    expect(resolved?.stock).toBe(40);
    // id 不变：弹窗的「实时」标注判据是 liveIds.has(product.id)
    expect(resolved?.id).toBe(CATALOG_PRODUCT.id);
    expect(resolved).toBe(liveOverride);
  });

  it('没有覆盖时原样返回快照值；id 为 null / 解析不到时返回 null（不抛错）', () => {
    expect(resolveDetailProduct(CATALOG_PRODUCT.id, LOOKUP, null)?.price).toBe(
      CATALOG_PRODUCT.price,
    );
    expect(resolveDetailProduct(null, LOOKUP, null)).toBeNull();
    expect(resolveDetailProduct('missing', LOOKUP, null)).toBeNull();
  });

  it('解析顺序：渲染中的列表优先，列表里没有时用会话缓存（从内联卡点开也能显示）', () => {
    const cached = makeProduct({ id: 'amz-B00CACHED1', name: '缓存的商品' });
    rememberResolvedProducts([cached]);
    expect(recallResolvedProduct(cached.id)).toBe(cached);

    const lookup = (id: string) => (id === cached.id ? recallResolvedProduct(id) : undefined);
    const resolved = resolveDetailProduct(cached.id, lookup, null);
    expect(resolved?.name).toBe('缓存的商品');
  });
});

describe('按需加载：loadInlineProducts', () => {
  it('空 id 列表不触发目录 import（首屏/普通消息不该下载 chunk）', async () => {
    await expect(loadInlineProducts([])).resolves.toEqual([]);
  });
});