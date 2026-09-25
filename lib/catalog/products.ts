import realCatalogJson from '@/data/real-catalog.json';
import justoneapiCatalogJson from '@/data/justoneapi-catalog.json';
import { PRODUCTS as MOCK_PRODUCTS } from '@/lib/mock/products';
import { hasJustOneApiToken } from '@/lib/justoneapi/client.mjs';
import { CATEGORIES, type Category, type Product } from '@/lib/types';

/**
 * 统一商品目录入口（数据源可切换）。
 *
 * - `real`：真实电商数据快照（Amazon 公开样本数据集，见 data/real-catalog.json 与
 *   scripts/build-real-catalog.mjs），**默认源，也是演示与验收基线**；
 * - `justoneapi`：京东实时源产物（data/justoneapi-catalog.json，由
 *   `npm run catalog:build:justoneapi` 生成）。它是**补充源与演示源，不是 real 的替代**：
 *   有可刷新的真实价格与库存状态，但上游缺评分/评论数/销量/划线价/描述
 *   （详见 README「JustOneAPI 实时数据源」与 docs/justoneapi-design.md §2/§3）；
 * - `mock`：内置 50 条精编数据，用于离线演示 / 对比测试。
 *
 * 切换方式：环境变量 `CATALOG_SOURCE=real|justoneapi|mock`（next.config.ts 把它内联进
 * 客户端包，保证服务端与浏览器解析出同一个源；token 这类密钥**不会**也不应该内联）。
 * 业务代码（工具层、节点、组件）一律从这里取数，不直接依赖具体数据源。
 *
 * **这是服务端模块**：它静态 import 着两份目录 JSON（real 451 KB + justoneapi 28 件）。
 * 客户端组件**不得** import 它——那会把整份目录打进首屏 bundle（实测 First Load 555 kB，
 * 目录约占 127 kB）。客户端需要的数字由服务端经 `app/page.tsx` 的
 * `buildCatalogClientPayload` 注入（见 `components/providers/catalog-data-provider.tsx`），
 * 只有「对话内联卡」按需 `import()` 本模块（`lib/catalog/client-products.ts`，独立 chunk）。
 */

export type CatalogSource = 'real' | 'justoneapi' | 'mock';

export interface CatalogMeta {
  source: CatalogSource;
  /** 商品总数 */
  count: number;
  /** 数据来源说明，用于界面角标与 README */
  provider: string;
  /** 真实数据的生成时间（mock 为空） */
  generatedAt: string | null;
  /** 文案本地化时间（未本地化或 mock 为空） */
  localizedAt: string | null;
  /** 上游数据集 / 接口地址（产物里的 source 字段原样透出；mock 为空） */
  origin: string | null;
  /** 数据真实性说明 */
  note: string | null;
}

/** 必须是非空字符串的字段：这些值会直接渲染，类型不对会让 React 直接抛错 */
const REQUIRED_STRING_FIELDS = ['id', 'name', 'brand', 'image', 'description'] as const;

/** 数值字段的合法区间（rating 上界按 5 分制） */
const NUMERIC_BOUNDS: { field: 'price' | 'rating'; min: number; max: number }[] = [
  { field: 'price', min: 0.01, max: Number.MAX_SAFE_INTEGER },
  { field: 'rating', min: 0, max: 5 },
];

/**
 * 运行时校验：外部数据源不可信，字段缺失或类型不对的商品直接丢弃而不是让界面崩掉。
 *
 * 注意两个容易漏掉的点：
 *   1. 只判 `=== undefined` 会让 `null` 混过去，所以字符串字段要判 `typeof`；
 *      非字符串的 `description` 会让 React 抛「Objects are not valid as a React child」。
 *   2. `typeof NaN === 'number'` 恒为 true，所以数值字段必须同时判 `Number.isFinite`
 *      与区间，否则一个 NaN 评分会渲染成「NaN 分」。
 *
 * 构建期脚本里有一份**同语义的镜像**（`scripts/catalog-shared.mjs` 的 `isProductLike`，
 * 脚本加载不了 TS），两边必须永远一致——由 `lib/justoneapi/jdSource.test.ts` 的等价性单测盯着。
 * 这里导出它就是为了那条单测。
 */
export function isProductLike(value: unknown): value is Product {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;

  if (
    REQUIRED_STRING_FIELDS.some((field) => {
      const raw = record[field];
      return typeof raw !== 'string' || raw.trim() === '';
    })
  ) {
    return false;
  }

  for (const { field, min, max } of NUMERIC_BOUNDS) {
    const raw = record[field];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return false;
    if (raw < min || raw > max) return false;
  }

  if (!CATEGORIES.includes(record.category as Category)) return false;
  return true;
}

interface RawCatalog {
  products?: unknown[];
  generatedAt?: string;
  localizedAt?: string;
  source?: string;
  note?: string;
  platforms?: string[];
}

/**
 * 加载一份目录产物：先按 `isProductLike` 丢弃不合格条目，再补齐可能缺失的字段。
 *
 * 两个源（快照 / 实时）共用这一处实现——校验与兜底一旦分叉，界面行为就会分叉。
 */
function loadProducts(raw: RawCatalog): Product[] {
  return (raw.products ?? [])
    .filter(isProductLike)
    .map((product) => ({
      ...product,
      // 真实数据里可能缺原价/库存字段，补齐默认值避免界面出现 undefined
      originalPrice:
        typeof product.originalPrice === 'number' && product.originalPrice > 0
          ? product.originalPrice
          : product.price,
      stock: typeof product.stock === 'number' ? product.stock : 0,
      sales: typeof product.sales === 'number' ? product.sales : 0,
      reviews: typeof product.reviews === 'number' ? product.reviews : 0,
      tags: Array.isArray(product.tags) ? product.tags : [],
      specifications: product.specifications ?? {},
    }));
}

const REAL_RAW = realCatalogJson as RawCatalog;
const JUSTONEAPI_RAW = justoneapiCatalogJson as RawCatalog;

const REAL_PRODUCTS = loadProducts(REAL_RAW);
const JUSTONEAPI_PRODUCTS = loadProducts(JUSTONEAPI_RAW);

function resolveSource(): CatalogSource {
  const configured = process.env.CATALOG_SOURCE;
  if (configured === 'mock') return 'mock';
  if (configured === 'real') return 'real';
  if (configured === 'justoneapi') {
    // 只在校验服务端时强制要求 token 与产物：浏览器端拿不到 token（密钥不进客户端包），
    // 也不该拿；只要两边解析出的**源**一致，渲染就是一致的
    if (typeof window === 'undefined') {
      if (!hasJustOneApiToken()) {
        throw new Error(
          'CATALOG_SOURCE=justoneapi 需要配置 JUSTONEAPI_TOKEN（见 .env.example）。这里刻意不静默回落：把实时源当成快照源用，出问题极难定位',
        );
      }
      if (JUSTONEAPI_PRODUCTS.length === 0) {
        throw new Error(
          'data/justoneapi-catalog.json 里没有可用商品：先跑 npm run catalog:build:justoneapi 生成产物',
        );
      }
    }
    return 'justoneapi';
  }
  // 未配置时：有真实数据就用真实数据，否则退回内置数据
  return REAL_PRODUCTS.length > 0 ? 'real' : 'mock';
}

export const CATALOG_SOURCE: CatalogSource = resolveSource();

function rawOf(source: CatalogSource): RawCatalog {
  if (source === 'justoneapi') return JUSTONEAPI_RAW;
  return REAL_RAW;
}

function productsOf(source: CatalogSource): Product[] {
  if (source === 'justoneapi') return JUSTONEAPI_PRODUCTS;
  if (source === 'real') return REAL_PRODUCTS;
  return MOCK_PRODUCTS;
}

function providerOf(source: CatalogSource): string {
  if (source === 'mock') return '内置演示数据';
  const platforms = rawOf(source).platforms ?? ['Amazon'];
  const suffix = source === 'justoneapi' ? '实时商品数据（构建时刻）' : '真实商品数据';
  return `${platforms.join(' / ')} ${suffix}`;
}

export const CATALOG_META: CatalogMeta = {
  source: CATALOG_SOURCE,
  count: productsOf(CATALOG_SOURCE).length,
  provider: providerOf(CATALOG_SOURCE),
  generatedAt: CATALOG_SOURCE === 'mock' ? null : (rawOf(CATALOG_SOURCE).generatedAt ?? null),
  localizedAt: CATALOG_SOURCE === 'mock' ? null : (rawOf(CATALOG_SOURCE).localizedAt ?? null),
  origin: CATALOG_SOURCE === 'mock' ? null : (rawOf(CATALOG_SOURCE).source ?? null),
  note: CATALOG_SOURCE === 'mock' ? null : (rawOf(CATALOG_SOURCE).note ?? null),
};

export const PRODUCTS: Product[] = productsOf(CATALOG_SOURCE);

const PRODUCT_INDEX = new Map(PRODUCTS.map((product) => [product.id, product]));

export function getProductById(id: string): Product | undefined {
  return PRODUCT_INDEX.get(id);
}

/** 按 id 列表取商品，忽略不存在的 id */
export function getProductsByIds(ids: string[]): Product[] {
  return ids
    .map((id) => PRODUCT_INDEX.get(id))
    .filter((product): product is Product => product !== undefined);
}

export function getProductsByCategory(category: Category): Product[] {
  return PRODUCTS.filter((product) => product.category === category);
}

/** 各品类商品数，用于首页分类入口展示 */
export const CATEGORY_COUNTS: Record<Category, number> = CATEGORIES.reduce(
  (counts, category) => {
    counts[category] = PRODUCTS.filter((product) => product.category === category).length;
    return counts;
  },
  {} as Record<Category, number>,
);

/** 默认推荐：有货优先，再按「评分 + 销量」加权排序 */
export function getFeaturedProducts(limit = 12): Product[] {
  return PRODUCTS.filter((product) => product.stock > 0)
    .slice()
    .sort((a, b) => b.rating * 20 + b.sales / 1000 - (a.rating * 20 + a.sales / 1000))
    .slice(0, limit);
}