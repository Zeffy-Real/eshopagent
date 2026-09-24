/**
 * `platforms/jd.mjs` 的类型声明。
 * 品类用 `Category`（lib/types.ts 的 7 品类联合），调用方据此做穷尽性检查。
 */

import type { Category } from '@/lib/types';

export const JD_ENDPOINTS: {
  search: string;
  detail: string;
  price: string;
};

export function resolveJdCategory(
  cid1: string | number | null | undefined,
  cid2: string | number | null | undefined,
  cid3: string | number | null | undefined,
): Category | null;

/** 搜索端点：元（字符串）→ 元 */
export function parseJdPriceYuan(raw: unknown): number | null;
/** 价格端点：分（数字）→ 元 */
export function parseJdPriceFen(raw: unknown): number | null;
/** 库存状态码 → 等级代表值（40 有货 / 10 紧张 / 0 缺货）；无可用信号返回 null */
export function encodeStockLevel(stockState: unknown): number | null;
export function toJdImageUrl(raw: unknown): string;