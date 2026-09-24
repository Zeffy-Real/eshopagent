import type { Product } from '@/lib/types';

/**
 * 实时覆盖的**合并规则**（纯函数，服务端节点与前端渲染共用同一份）。
 *
 * 为什么单独一个文件：同一件商品会在三个地方被渲染（商品卡 / 详情弹窗 / 对比表），
 * 而「实时值该怎么盖到快照值上」只有一条规则。规则写进组件就会分叉：
 * 卡片显示实时价、弹窗显示快照价——这类不一致比「没有实时数据」更糟。
 *
 * 覆盖范围严格限定（见 docs/justoneapi-design.md §14.4 与 2026-09-25 裁定 1）：
 *   - 只覆盖 `price`（以及受它牵连的 `originalPrice`）与 `stock`；
 *   - `rating / reviews / sales` **不覆盖**：京东搜索与详情端点里没有这些字段（实测为空串
 *     或区间文案），拿不到的东西不假装有；
 *   - `name / brand / category / image / description / specifications / tags` 是稳定字段，
 *     快照里的本地化文案更好，一律保留。
 */

/** 命中即认为「用户本轮在问实时信息」的词表（条件边第 3 条判定用） */
export const LIVE_KEYWORDS = [
  '现在',
  '最新',
  '实时',
  '当前',
  '多少钱',
  '涨价',
  '降价',
  '还有货',
  '库存',
  '有货',
  '缺货',
  '现货',
] as const;

/**
 * 库存类关键词（子集）：命中时除了价格，还额外取一次详情端点读库存状态。
 *
 * 为什么单列：价格端点不返回库存（实测只给 `{good_id, price}`），
 * 而详情端点贵一点（响应体 40KB 级）——只在用户确实问「还有货吗」时才多花这一次调用。
 */
export const STOCK_KEYWORDS = ['还有货', '库存', '有货', '缺货', '现货'] as const;

export function hasLiveKeyword(text: string): boolean {
  return LIVE_KEYWORDS.some((keyword) => text.includes(keyword));
}

export function hasStockKeyword(text: string): boolean {
  return STOCK_KEYWORDS.some((keyword) => text.includes(keyword));
}

/**
 * 商品 id 能否被目标平台解析。
 *
 * 当前 justoneapi 目录的商品 id 形如 `jd-100207440191`（`jd-` + 纯数字 skuId）。
 * 默认 `real` 快照的商品 id 是 Amazon ASIN（`amz-B092R6HW7L`），因此条件边第 4 条
 * 会自然失败——**这就是「用快照源时节点零行为」的实现方式**，
 * 不需要任何「是不是 justoneapi 源」的特例判断。
 */
export function isResolvableProductId(id: string): boolean {
  return /^jd-\d{6,}$/.test(id);
}

/** 元 → 保留两位小数（价格端点返回的分换算后可能出现浮点尾差） */
function roundYuan(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 用实时价构造覆盖后的商品。
 *
 * `originalPrice` 一致性：实时价高于原划线价（或原划线价缺失）时，把划线价同步为新价格，
 * 否则界面会出现「划线价低于现价」的破图（`originalPrice > price` 的展示条件也会失效）。
 */
export function withLivePrice(base: Product, livePriceYuan: number): Product {
  const price = roundYuan(livePriceYuan);
  return {
    ...base,
    price,
    originalPrice: base.originalPrice > price ? base.originalPrice : price,
  };
}

/**
 * 用实时库存**等级代表值**覆盖（0 / 10 / 40，不是件数）。
 *
 * 等级来自京东 `stock.StockState` 的编码（见 platforms/jd.mjs），界面仍只显示
 * 「有货 / 紧张 / 缺货」等级——件数在真实源里从来拿不到，也从不在界面展示。
 */
export function withLiveStock(base: Product, level: number): Product {
  return { ...base, stock: level };
}

/**
 * 渲染时按 id 取覆盖值；没有覆盖就返回原商品。
 *
 * 三个渲染点（卡片 / 弹窗 / 对比表）都调它，保证「哪些字段来自实时、哪些来自快照」
 * 在所有位置一致。
 */
export function applyLiveOverride(
  product: Product,
  overrides: Record<string, Product> | null | undefined,
): Product {
  const override = overrides?.[product.id];
  return override ?? product;
}

/** 「实时 · 14:32」里的时间部分；本地时区，仅在客户端渲染（快照来自 SSE 或 rehydrate） */
export function formatLiveTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}