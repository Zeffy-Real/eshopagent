import { COUPONS } from '@/lib/mock/user';
import { SHIPPING, type CartItem, type Coupon } from '@/lib/types';

/**
 * 购物车金额规则（纯函数，客户端与服务端共用）。
 *
 * 独立成模块的原因：右栏购物车面板需要在本地即时算价，
 * 而 cartTools.ts 会连带引入商品目录（data/real-catalog.json，体积大），
 * 不适合打进客户端包。
 */

export interface CartSummary {
  items: CartItem[];
  /** 商品总件数 */
  count: number;
  /** 商品原价合计（划线价） */
  originalSubtotal: number;
  /** 商品现价合计 */
  subtotal: number;
  /** 商品直降金额（原价合计 - 现价合计） */
  saved: number;
  /** 优惠券抵扣金额 */
  discount: number;
  /** 运费 */
  shippingFee: number;
  /** 实付金额 */
  total: number;
  /** 自动选中的最优优惠券 */
  coupon: Coupon | null;
  /** 距下一档可用优惠券还差多少（用于「再买 X 元可用」提示） */
  nextCoupon: { coupon: Coupon; gap: number } | null;
  /** 库存不足提醒 */
  stockWarnings: string[];
}

/** 满足门槛且抵扣最多的优惠券 */
export function pickBestCoupon(subtotal: number): Coupon | null {
  const usable = COUPONS.filter((coupon) => subtotal >= coupon.threshold);
  if (usable.length === 0) return null;
  return usable.reduce((best, coupon) => (coupon.amount > best.amount ? coupon : best));
}

/** 距下一档优惠券的差额 */
export function nextCouponGap(subtotal: number): CartSummary['nextCoupon'] {
  const candidates = COUPONS.filter((coupon) => subtotal < coupon.threshold).sort(
    (a, b) => a.threshold - b.threshold,
  );
  const next = candidates[0];
  if (!next) return null;
  return { coupon: next, gap: next.threshold - subtotal };
}

export function computeShippingFee(subtotal: number): number {
  if (subtotal <= 0) return 0;
  return subtotal >= SHIPPING.freeThreshold ? 0 : SHIPPING.fee;
}

export function summarizeCart(cart: CartItem[]): CartSummary {
  const originalSubtotal = cart.reduce(
    (sum, item) => sum + item.product.originalPrice * item.quantity,
    0,
  );
  const subtotal = cart.reduce(
    (sum, item) => sum + item.product.price * item.quantity,
    0,
  );
  const coupon = pickBestCoupon(subtotal);
  const discount = coupon?.amount ?? 0;
  const shippingFee = computeShippingFee(subtotal);
  const stockWarnings = cart
    .filter((item) => item.product.stock <= 0 || item.quantity > item.product.stock)
    .map((item) =>
      // 不报件数：件数是派生值，只作为内部可用性模型（见 components/product/stock-badge.tsx）
      item.product.stock <= 0
        ? `${item.product.name} 已缺货`
        : `${item.product.name} 库存不足，请减少数量`,
    );

  return {
    items: cart,
    count: cart.reduce((sum, item) => sum + item.quantity, 0),
    originalSubtotal,
    subtotal,
    saved: Math.max(0, originalSubtotal - subtotal),
    discount,
    shippingFee,
    total: Math.max(0, subtotal - discount) + shippingFee,
    coupon,
    nextCoupon: nextCouponGap(subtotal),
    stockWarnings,
  };
}
