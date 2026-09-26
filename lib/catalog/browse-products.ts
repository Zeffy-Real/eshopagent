import { rememberResolvedProducts } from '@/lib/catalog/client-products';
import type { Category, Product } from '@/lib/types';

/**
 * 浏览视图（中栏覆盖层）的数据层。
 *
 * 为什么单独一个模块、而不是放进 `client-products.ts`：这个文件**只被浏览视图引用**，
 * 而浏览视图是 `next/dynamic` 的按需 chunk —— 于是「浏览」相关的数据代码不进首屏 bundle
 * （`client-products.ts` 在首屏里，因为中栏要用它的详情解析与会话缓存）。
 * 与目录 JSON 同一套思路：用户点开浏览视图时才下载。
 */

/**
 * 目录数据的数据来源（**`lib` 层的完整集合**，两种消费者共用）：
 *
 * - `category`：品类 chip 直接浏览该品类全量（如「数码」60 件）——不进对话、不带残留条件；
 * - `all`：整个目录（「让我看看所有 420 件商品」这类**无筛选条件**的命中走这条，
 *   由客户端目录 chunk 现算，**不经 SSE 传 420 个 id**）；
 * - `ids`：本轮检索命中的 id 列表（**有筛选条件**时走这条：客户端拿目录按 id 查找）——
 *   消费者是**中栏的就地「加载更多」**（追加窗口 ≤ `SEARCH_RESULT_ID_LIMIT` 件，见
 *   `lib/product-panel-state.ts` 的 `expansionPlanOf`）；`total` 是命中总数，用于
 *   「命中 > 下发上限」时注明「显示前 N 件」。浏览视图不再消费 `ids`（见 `BrowseViewSource`）。
 *
 * 为什么不给全量也传 id 列表：420 个 id 会在每个状态帧里重复下发，载荷明显放大；
 * 而「无筛选条件 → 整个目录」在客户端算出来的结果与目录完全一致，没有信息差。
 */
export type BrowseSource =
  | { kind: 'category'; category: Category }
  | { kind: 'all' }
  | { kind: 'ids'; ids: string[]; total?: number };

/**
 * 浏览视图（中栏覆盖层）的数据来源：**只有目录浏览两条**，没有 `ids`。
 *
 * 职责边界（2026-09-26 收口）：搜索结果的展开归**中栏就地「加载更多」**（不换视图、
 * 对话可见）；浏览视图只负责「无对话时的目录浏览」——点 chip 看品类、看整个目录。
 * 用 `Exclude` 而不是另写一份联合：两个来源的形状与 `BrowseSource` 逐字一致，
 * 只有消费侧的子集关系，新增来源时也不会漏。
 */
export type BrowseViewSource = Exclude<BrowseSource, { kind: 'ids' }>;

/**
 * 纯函数：按来源从**已加载的目录**里挑出商品（不碰网络、不 import）。
 *
 * - `all` 原样返回（保持目录顺序，排序交给展示层的排序控件）；
 * - `category` 按品类过滤；
 * - `ids` 按列表保序查找，目录里没有的 id 跳过（与内联卡的语义一致）。
 */
export function selectBrowseProducts(products: Product[], source: BrowseSource): Product[] {
  if (source.kind === 'all') return products;
  if (source.kind === 'category') {
    return products.filter((product) => product.category === source.category);
  }
  const lookup = new Map(products.map((product) => [product.id, product]));
  return source.ids
    .map((id) => lookup.get(id))
    .filter((product): product is Product => Boolean(product));
}

/**
 * 浏览视图的数据加载：复用内联卡那一个按需 chunk（目录不进首屏 bundle）。
 *
 * 返回 `null` 表示**加载失败**（chunk 失效 / 断网）——浏览视图要如实显示「加载失败」，
 * 不能把失败伪装成「没有商品」；这与内联卡的静默失败不同，因为这里用户是主动来浏览的。
 */
export async function loadBrowseProducts(source: BrowseSource): Promise<Product[] | null> {
  try {
    const { PRODUCTS } = await import('@/lib/catalog/products');
    const products = selectBrowseProducts(PRODUCTS, source);
    rememberResolvedProducts(products);
    return products;
  } catch {
    return null;
  }
}