import { applyLiveOverride } from '@/lib/justoneapi/overrides';
import type { Product } from '@/lib/types';

/**
 * 客户端按 id 取商品的两条路径。
 *
 * 背景：客户端**不再静态 import 目录**（`lib/catalog/products.ts` 里带着 451 KB 的 JSON，
 * 静态引用会把整份目录打进首屏 bundle，实测 First Load 555 kB、目录占约 127 kB）。
 * 现在只有三处需要「拿到目录里的商品」：
 *
 *   1. **对话内联卡**：`loadInlineProducts` 按需 `import('@/lib/catalog/products')`——
 *      目录因此落在一个独立 chunk，不进首屏；加载失败静默返回空（不抛错、不显示「找不到」）。
 *   2. **详情弹窗**：商品对象由调用方传入（弹窗组件本来就是 `product: Product | null` 签名）。
 *      解析顺序 = 面板当前渲染的列表（已是叠加过实时覆盖的对象）→ 会话内已解析过的内联卡商品。
 *      这条顺序保证「从哪张卡片点开的，弹窗就显示那张卡片的商品」——实时覆盖过的价格与
 *      「实时 · HH:mm」标注因此不会在弹窗里丢失。
 *   3. **浏览视图**：走 `lib/catalog/browse-products.ts`（独立模块 = 独立按需 chunk，
 *      不在首屏里），支持品类 / 全量 / 对话命中的 id 列表三种来源。
 */

export type ProductLookup = (id: string) => Product | undefined;

/**
 * 单个 id → 商品；未命中返回 null，**不抛错**。
 *
 * 解析失败（chunk 加载失败、id 不在目录里）只意味着「这张卡片没得渲染」，
 * 不该让整条聊天气泡或详情弹窗崩掉。
 */
export function pickInlineProduct(id: string, lookup: ProductLookup): Product | null {
  try {
    return lookup(id) ?? null;
  } catch {
    return null;
  }
}

/** 多个 id → 商品列表（保序；未命中的 id 直接跳过，保持与「这条消息引用了哪几件」一致的部分） */
export function pickInlineProducts(ids: string[], lookup: ProductLookup): Product[] {
  return ids
    .map((id) => pickInlineProduct(id, lookup))
    .filter((product): product is Product => product !== null);
}

/**
 * 会话内已解析过的商品（按 id）：
 * 面板渲染过的列表 + 内联卡解析出的商品都记在这里，供详情弹窗按 id 复用——
 * 否则「列表已换掉、但要显示的那件商品还在弹窗里」这类情况会解析不到。
 */
const sessionProducts = new Map<string, Product>();

export function rememberResolvedProducts(products: Product[]): void {
  for (const product of products) sessionProducts.set(product.id, product);
}

export function recallResolvedProduct(id: string): Product | undefined {
  return sessionProducts.get(id);
}

/**
 * 详情弹窗的商品解析：`lookup` 由调用方组合（渲染中的列表 → 会话缓存），
 * 命中后叠一次实时覆盖——弹窗与卡片必须读同一份覆盖值，否则会出现
 * 「卡片显示实时价、弹窗显示快照价」的分叉。
 */
export function resolveDetailProduct(
  id: string | null,
  lookup: ProductLookup,
  overrides: Record<string, Product> | null | undefined,
): Product | null {
  if (!id) return null;
  const product = pickInlineProduct(id, lookup);
  return product ? applyLiveOverride(product, overrides) : null;
}

/**
 * 按需加载目录模块并解析一批 id。
 *
 * 首次调用会下载那个 chunk（约 127 kB，gzip），之后命中浏览器模块缓存；
 * 加载失败（断网 / chunk 失效）静默返回空数组——聊天气泡只是少几张卡片，
 * 不该出现报错或「找不到商品」这类会误导用户的文案。
 */
export async function loadInlineProducts(ids: string[]): Promise<Product[]> {
  if (ids.length === 0) return [];
  try {
    const { getProductById } = await import('@/lib/catalog/products');
    const products = pickInlineProducts(ids, getProductById);
    rememberResolvedProducts(products);
    return products;
  } catch {
    return [];
  }
}