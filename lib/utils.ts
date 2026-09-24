import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** 价格格式化：1299 -> ¥1,299 */
export function formatPrice(value: number): string {
  return `¥${value.toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

/** 折扣百分比：1000 -> 799 得到 "省 20%" */
export function discountLabel(price: number, originalPrice: number): string | null {
  if (originalPrice <= price || originalPrice <= 0) return null;
  const off = Math.round(((originalPrice - price) / originalPrice) * 100);
  return off > 0 ? `省 ${off}%` : null;
}

/**
 * 销量 / 评价数的统一展示口径。
 *
 * 必须是唯一实现：卡片、对比表、决策推荐、LLM 上下文都从这里取字符串。
 * 之前卡片自己算 `(sales/10000).toFixed(1)`（四舍五入），而 LLM 看到的是原始数字
 * 84507，于是回复里写成「8.4万」（截断），与界面「8.5万」对不上——同一个数字
 * 出现两种口径，用户会直接怀疑数据是编的。
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return value.toLocaleString('zh-CN');
}

/**
 * 该商品是否有「平台真实销量」。
 *
 * 为什么需要这个判断：真实数据源里只有 Amazon / Lazada / Shopee 提供销量字段，
 * Walmart 与图书样本没有。构建阶段对缺失的来源记 `sales: 0`——**不**再用
 * 「评价数 × 系数」估算一个数字冒充销量（那会让界面、对比表、决策推荐和 LLM
 * 都把编造的数字当成事实引用）。
 *
 * 因此 `sales === 0` 的语义是「该来源无销量数据」，不是「卖了 0 件」。
 * 界面与 LLM 遇到这种情况应改展示真实的评价数。
 * 这是该语义的唯一实现，所有消费方都从这里判断，避免各自写 `> 0` 导致口径分叉。
 */
export function hasRealSales(sales: number): boolean {
  return Number.isFinite(sales) && sales > 0;
}
