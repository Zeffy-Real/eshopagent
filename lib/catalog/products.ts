import realCatalogJson from '@/data/real-catalog.json';
import { PRODUCTS as MOCK_PRODUCTS } from '@/lib/mock/products';
import { CATEGORIES, type Category, type Product } from '@/lib/types';

/**
 * 统一商品目录入口（数据源可切换）。
 *
 * - `real`：真实电商数据快照（Amazon 公开样本数据集，见 data/real-catalog.json 与
 *   scripts/build-real-catalog.mjs），默认数据源；
 * - `mock`：内置 50 条精编数据，用于离线演示 / 对比测试。
 *
 * 切换方式：环境变量 `CATALOG_SOURCE=mock|real`。业务代码（工具层、节点、组件）
 * 一律从这里取数，不直接依赖具体数据源——接真实电商 API 时只需替换本文件的实现。
 */

export type CatalogSource = 'real' | 'mock';

export interface CatalogMeta {
  source: CatalogSource;
  /** 商品总数 */
  count: number;
  /** 数据来源说明，用于界面角标与 README */
  provider: string;
  /** 真实数据的生成时间（mock 为空） */
  generatedAt: string | null;
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
 */
function isProductLike(value: unknown): value is Product {
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
  source?: string;
  note?: string;
  platforms?: string[];
}

const rawCatalog = realCatalogJson as RawCatalog;

const REAL_PRODUCTS: Product[] = (rawCatalog.products ?? [])
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

function resolveSource(): CatalogSource {
  const configured = process.env.CATALOG_SOURCE;
  if (configured === 'mock') return 'mock';
  if (configured === 'real') return 'real';
  // 未配置时：有真实数据就用真实数据，否则退回内置数据
  return REAL_PRODUCTS.length > 0 ? 'real' : 'mock';
}

export const CATALOG_SOURCE: CatalogSource = resolveSource();

export const CATALOG_META: CatalogMeta = {
  source: CATALOG_SOURCE,
  count: CATALOG_SOURCE === 'real' ? REAL_PRODUCTS.length : MOCK_PRODUCTS.length,
  provider:
    CATALOG_SOURCE === 'real'
      ? `${(rawCatalog.platforms ?? ['Amazon']).join(' / ')} 真实商品数据`
      : '内置演示数据',
  generatedAt: CATALOG_SOURCE === 'real' ? (rawCatalog.generatedAt ?? null) : null,
  note: CATALOG_SOURCE === 'real' ? (rawCatalog.note ?? null) : null,
};

export const PRODUCTS: Product[] =
  CATALOG_SOURCE === 'real' ? REAL_PRODUCTS : MOCK_PRODUCTS;

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
