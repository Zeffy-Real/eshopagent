import { z } from 'zod';
import { PRODUCTS, getProductById, getProductsByIds } from '@/lib/catalog/products';
import {
  CATEGORIES,
  SORT_KEYS,
  stockLevelOf,
  STOCK_LABEL,
  STOCK_RANK,
  type ComparisonResult,
  type ComparisonRow,
  type Product,
  type SearchFilters,
  type SortKey,
} from '@/lib/types';
import { formatCount, hasRealSales } from '@/lib/utils';

/* ============================================================
   商品检索：纯函数实现
   节点内直接调用这些函数（拿到强类型结果）。不额外包 tool() 包装：
   本项目的路由由图的条件边决定，tool calling 解决不了这里的任何问题，
   只会多一层间接（详见文件末尾的说明）。
   ============================================================ */

/** 商品可被检索的文本面（名称 / 品牌 / 品类 / 描述 / 标签） */
function searchableText(product: Product): string {
  return [
    product.name,
    product.brand,
    product.category,
    product.description,
    product.tags.join(' '),
  ].join(' ');
}

/**
 * 用户口语 → 目录用词的同义词桥接。
 *
 * 真实目录来自英文数据集本地化，商品名用词与用户口语常有偏差
 * （用户说「跑鞋」，库里写「跑步鞋」）。没有这层映射时，规则解析会先搜出
 * 0 结果、再靠放宽条件兜回来，多绕两轮且时间线难看。
 * 这里只做**语义等价**的扩展，不做「透气→轻量」这类会误导用户的放宽。
 */
const KEYWORD_ALIASES: Record<string, string[]> = {
  跑鞋: ['跑步鞋', '运动鞋', '跑步'],
  运动鞋: ['跑步鞋', '跑鞋'],
  休闲鞋: ['健步鞋', '一脚蹬'],
  耳机: ['耳塞', '耳机'],
  笔记本: ['电脑', '笔记本'],
  音箱: ['蓝牙音箱', '扬声器'],
  床品: ['四件套', '床单', '浴巾', '被套'],
  外套: ['夹克', '保暖'],
  牛奶: ['奶粉'],
  咖啡: ['咖啡机', '咖啡'],
  枕头: ['枕'],
  书: ['图书'],
  短裤: ['裤子', '长裤'],
  连衣裙: ['连衣裙', '裙'],
};

/** 单个关键词的命中权重：名称 > 标签/品牌 > 品类 > 描述（含同义词扩展） */
function scoreKeyword(product: Product, keyword: string): number {
  const normalized = keyword.trim();
  const variants = [normalized, ...(KEYWORD_ALIASES[normalized] ?? [])];
  return variants.reduce((best, variant) => Math.max(best, scoreVariant(product, variant)), 0);
}

function scoreVariant(product: Product, keyword: string): number {
  const kw = keyword.trim();
  if (!kw) return 0;
  if (product.name.includes(kw)) return 5;
  if (product.tags.some((tag) => tag.includes(kw) || kw.includes(tag))) return 3;
  if (product.brand.includes(kw)) return 3;
  if (product.category.includes(kw)) return 2;
  if (searchableText(product).includes(kw)) return 1;
  return 0;
}

function scoreProduct(product: Product, keywords: string[]): number {
  return keywords.reduce((sum, kw) => sum + scoreKeyword(product, kw), 0);
}

/** 硬性条件（价格 / 品类 / 评分 / 品牌 / 标签）过滤，不含关键词 */
function matchHardFilters(product: Product, filters: SearchFilters): boolean {
  if (filters.category && product.category !== filters.category) return false;
  if (filters.minPrice !== undefined && product.price < filters.minPrice) return false;
  if (filters.maxPrice !== undefined && product.price > filters.maxPrice) return false;
  if (filters.minRating !== undefined && product.rating < filters.minRating) return false;
  if (
    filters.brands?.length &&
    !filters.brands.some((brand) => product.brand.includes(brand))
  ) {
    return false;
  }
  if (filters.tags?.length) {
    const hit = filters.tags.some((tag) =>
      product.tags.some((productTag) => productTag.includes(tag) || tag.includes(productTag)),
    );
    if (!hit) return false;
  }
  return true;
}

function sortProducts(list: Product[], sort: SortKey, keywords: string[]): Product[] {
  const sorted = list.slice();
  switch (sort) {
    case 'price_asc':
      return sorted.sort((a, b) => a.price - b.price);
    case 'price_desc':
      return sorted.sort((a, b) => b.price - a.price);
    case 'rating':
      return sorted.sort((a, b) => b.rating - a.rating || b.sales - a.sales);
    case 'sales':
      return sorted.sort((a, b) => b.sales - a.sales);
    default:
      return sorted.sort(
        (a, b) =>
          scoreProduct(b, keywords) - scoreProduct(a, keywords) ||
          b.rating - a.rating ||
          b.sales - a.sales,
      );
  }
}

export interface SearchOutcome {
  /** 截断后的结果列表 */
  items: Product[];
  /** 命中总数（截断前） */
  total: number;
  /** 实际生效的筛选条件 */
  filters: SearchFilters;
  /** 关键词是全命中还是降级为任一命中 */
  keywordMode: 'all' | 'any' | 'none';
}

/**
 * 按筛选条件检索商品。
 * 关键词优先采用「全命中」语义（跑鞋 + 透气 必须都满足）；
 * 若全命中无结果，则降级为「任一命中」，避免多轮细化时出现空结果。
 */
export function filterProducts(filters: SearchFilters, limit = 12): SearchOutcome {
  const keywords = (filters.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  const candidates = PRODUCTS.filter((product) => matchHardFilters(product, filters));

  let matched: Product[] = candidates;
  let keywordMode: SearchOutcome['keywordMode'] = 'none';

  if (keywords.length > 0) {
    const all = candidates.filter((product) =>
      keywords.every((kw) => scoreKeyword(product, kw) > 0),
    );
    if (all.length > 0) {
      matched = all;
      keywordMode = 'all';
    } else {
      matched = candidates.filter((product) => scoreProduct(product, keywords) > 0);
      keywordMode = 'any';
    }
  }

  const sorted = sortProducts(matched, filters.sort ?? 'relevance', keywords);
  return {
    items: sorted.slice(0, limit),
    total: sorted.length,
    filters,
    keywordMode,
  };
}

/** 商品详情（供详情弹窗与对比表使用） */
export function getProductDetail(id: string): Product | undefined {
  return getProductById(id);
}

/* ============================================================
   商品对比
   ============================================================ */

function indexOfExtreme(values: number[], pick: 'min' | 'max'): number[] {
  if (values.length === 0) return [];
  const target = pick === 'min' ? Math.min(...values) : Math.max(...values);
  return values.reduce<number[]>((acc, value, index) => {
    if (value === target) acc.push(index);
    return acc;
  }, []);
}

function buildRow(key: string, values: string[], best: number[] = []): ComparisonRow {
  const first = values[0] ?? '';
  return {
    key,
    values,
    diff: values.some((value) => value !== first),
    best,
  };
}

/** 性价比得分：评分越高、价格越低得分越高（0 - 100） */
export function computeValueScores(products: Product[]): Record<string, number> {
  if (products.length === 0) return {};
  const prices = products.map((p) => p.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const span = maxPrice - minPrice;

  return Object.fromEntries(
    products.map((product) => {
      const ratingScore = (product.rating / 5) * 100;
      const priceScore = span === 0 ? 100 : ((maxPrice - product.price) / span) * 100;
      const stockPenalty = product.stock <= 0 ? 15 : 0;
      const score = ratingScore * 0.5 + priceScore * 0.5 - stockPenalty;
      return [product.id, Math.max(0, Math.round(score))];
    }),
  );
}

/** 表格固定行：规格参数里若出现同名键会与固定行重复（React key 冲突 + 展示冗余），需要剔除 */
const FIXED_ROW_KEYS = new Set([
  '价格',
  '原价',
  '品牌',
  '作者',
  '评分',
  '销量',
  '库存',
  '性价比',
]);

/**
 * 对 2 - 4 件商品做参数对比，输出可直接渲染的表格行。
 * 表头固定行（价格 / 品牌 / 评分 / 销量 / 库存）在前，
 * 规格参数取各商品的键并集（剔除与固定行重名的键），缺失值以「—」补齐。
 */
export function compareProducts(ids: string[]): ComparisonResult {
  const products = getProductsByIds(ids).slice(0, 4);
  if (products.length === 0) {
    return {
      products: [],
      rows: [],
      highlights: {
        lowestPriceId: '',
        highestRatingId: '',
        highestSalesId: '',
        mostStockId: '',
        bestValueId: '',
      },
      valueScores: {},
    };
  }

  const prices = products.map((p) => p.price);
  const ratings = products.map((p) => p.rating);
  const sales = products.map((p) => p.sales);
  const stockRanks = products.map((p) => STOCK_RANK[stockLevelOf(p.stock)]);
  // 库存维度只有在「等级确实有差异」时才提供区分信息。
  // 全部有货时按派生件数挑一件「最充足」的，等于按哈希值编一条推荐理由。
  const stockDiffers = stockRanks.some((rank) => rank !== stockRanks[0]);
  const valueScores = computeValueScores(products);

  // 图书数据里 brand 字段存的是**作者**，固定行标题若仍写「品牌」，
  // 既与规格参数里的「作者」行重复展示同一个值，也把作者错标成了品牌。
  // 整组都是图书时改用「作者」；靠 FIXED_ROW_KEYS 去掉规格里的同名行，避免两行重复。
  const brandRowKey = products.every((product) => product.category === '图书') ? '作者' : '品牌';

  const rows: ComparisonRow[] = [
    buildRow(
      '价格',
      products.map((p) => `¥${p.price}`),
      indexOfExtreme(prices, 'min'),
    ),
    buildRow(
      '原价',
      products.map((p) => `¥${p.originalPrice}`),
    ),
    buildRow(
      brandRowKey,
      products.map((p) => p.brand),
    ),
    buildRow(
      '评分',
      products.map((p) => (p.rating > 0 ? `${p.rating} 分` : '暂无评分')),
      indexOfExtreme(ratings, 'max'),
    ),
    // 只有至少一件商品有真实销量时才出「销量」行：
    // 否则整行都是占位的 0，表格会显示「销量 0 0 0」，比缺这一行更容易误导
    ...(products.some((p) => hasRealSales(p.sales))
      ? [buildRow('销量', products.map((p) => formatCount(p.sales)), indexOfExtreme(sales, 'max'))]
      : []),
    // 库存行只出等级、不出件数：件数全部是派生的（见 StockBadge 注释）。
    // 「最优」也按等级判定而不是按件数——用派生件数排序等于按哈希排序。
    // 且仅当等级确实有差异时才标记最优，否则这一行不提供任何区分信息。
    buildRow(
      '库存',
      products.map((p) => STOCK_LABEL[stockLevelOf(p.stock)]),
      stockDiffers ? indexOfExtreme(stockRanks, 'max') : [],
    ),
    buildRow(
      '性价比',
      products.map((p) => `${valueScores[p.id] ?? 0} 分`),
      indexOfExtreme(
        products.map((p) => valueScores[p.id] ?? 0),
        'max',
      ),
    ),
  ];

  const specKeys = Array.from(
    new Set(products.flatMap((product) => Object.keys(product.specifications))),
  ).filter((key) => !FIXED_ROW_KEYS.has(key));
  for (const key of specKeys) {
    rows.push(
      buildRow(
        key,
        products.map((product) => product.specifications[key] ?? '—'),
      ),
    );
  }

  const bestValueId =
    products.reduce<Product | undefined>((best, current) => {
      if (!best) return current;
      return (valueScores[current.id] ?? 0) > (valueScores[best.id] ?? 0) ? current : best;
    }, undefined)?.id ?? '';

  return {
    products,
    rows,
    highlights: {
      lowestPriceId: products[indexOfExtreme(prices, 'min')[0] ?? 0]?.id ?? '',
      highestRatingId: products[indexOfExtreme(ratings, 'max')[0] ?? 0]?.id ?? '',
      // 没有任何商品有真实销量时不产出「销量最高」：否则决策面板会写
      // 「销量最高 · 已售 0 · 市场验证更充分」，自相矛盾
      highestSalesId: products.some((p) => hasRealSales(p.sales))
        ? (products[indexOfExtreme(sales, 'max')[0] ?? 0]?.id ?? '')
        : '',
      mostStockId: stockDiffers
        ? (products[indexOfExtreme(stockRanks, 'max')[0] ?? 0]?.id ?? '')
        : '',
      bestValueId,
    },
    valueScores,
  };
}

/* ============================================================
   请求 / 输入契约（zod）

   这里只保留 schema，不保留 tool() 包装。
   为什么不接 tool calling：本项目的节点是 8 个预定义节点、路由是 6 类有限分类，
   工具与节点几乎一一对应 —— tool calling 要解决的「运行时动态选择未知工具集」
   这个问题在这里不存在。包一层 tool() 只是在 StateGraph 之上又叠一个隐式 agent
   循环，属于多余的间接层；节点直调纯函数 + zod 校验入参是更直接的做法。
   ============================================================ */

/** 商品检索入参（对应 filterProducts 的 filters + limit） */
export const searchProductsSchema = z.object({
  keywords: z.array(z.string()).optional().describe('关键词，例如 ["跑鞋", "透气"]'),
  category: z.enum(CATEGORIES).optional().describe('商品品类'),
  minPrice: z.number().nonnegative().optional().describe('价格下限（元）'),
  maxPrice: z.number().nonnegative().optional().describe('价格上限（元）'),
  minRating: z.number().min(0).max(5).optional().describe('最低评分'),
  brands: z.array(z.string()).optional().describe('品牌偏好'),
  tags: z.array(z.string()).optional().describe('功能标签，例如 ["透气", "降噪"]'),
  sort: z.enum(SORT_KEYS).optional().describe('排序方式'),
  limit: z.number().int().min(1).max(30).optional().describe('返回条数，默认 12'),
});

/** 商品详情入参 */
export const getProductDetailSchema = z.object({
  productId: z.string().min(1).describe('商品 id，例如 amz-B092R6HW7L'),
});

/** 商品对比入参 */
export const compareProductsSchema = z.object({
  productIds: z
    .array(z.string().min(1))
    .min(2)
    .max(4)
    .describe('待对比的商品 id 列表（2 - 4 个）'),
});
