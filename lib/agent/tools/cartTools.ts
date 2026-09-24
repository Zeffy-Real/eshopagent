import { z } from 'zod';
import { summarizeCart } from '@/lib/cart-pricing';
import { getProductById } from '@/lib/catalog/products';
import { MOCK_ADDRESS } from '@/lib/mock/user';
import type { CartItem, Order, OrderAddress, PaymentMethod } from '@/lib/types';

/* ============================================================
   购物车 / 订单：纯函数实现

   分层约定：
   - 状态变更型操作（加购 / 改数量 / 删除 / 清空）由 manageCart 节点
     调用下面的纯函数，把新数组写回 AgentState.cart；
   - 计算型操作（summarizeCart / buildOrderDraft）以 cart 为输入，节点直接调用。

   为什么这里没有 tool() 包装：本项目的节点是 8 个预定义节点、路由是 6 类有限
   分类，工具与节点几乎一一对应 —— tool calling 要解决的「运行时动态选择未知工具集」
   这个问题在这里不存在。包一层 tool() 只是在 StateGraph 之上又叠一个隐式 agent 循环，
   属于多余的间接层。节点直调纯函数，配合 zod schema 做入参校验，是更直接的做法。
   ============================================================ */

export type CartTarget = { productId?: string; index?: number };

export type CartMutationResult =
  | { ok: true; cart: CartItem[]; message: string }
  | { ok: false; cart: CartItem[]; message: string };


export function addToCart(
  cart: CartItem[],
  productId: string,
  quantity = 1,
): CartMutationResult {
  const product = getProductById(productId);
  if (!product) {
    return { ok: false, cart, message: `未找到商品：${productId}` };
  }
  if (product.stock <= 0) {
    return { ok: false, cart, message: `${product.name} 当前缺货，无法加入购物车` };
  }

  const existing = cart.find((item) => item.product.id === productId);
  const targetQuantity = (existing?.quantity ?? 0) + quantity;
  if (targetQuantity > product.stock) {
    const allowed = product.stock;
    const next = existing
      ? cart.map((item) =>
          item.product.id === productId ? { ...item, quantity: allowed } : item,
        )
      : [...cart, { product, quantity: allowed }];
    return {
      ok: true,
      cart: next,
      message: `${product.name} 库存不足，已按最大可购数量加入`,
    };
  }

  const next = existing
    ? cart.map((item) =>
        item.product.id === productId ? { ...item, quantity: targetQuantity } : item,
      )
    : [...cart, { product, quantity }];
  return { ok: true, cart: next, message: `已将 ${product.name} × ${quantity} 加入购物车` };
}

export function updateCartItem(
  cart: CartItem[],
  target: CartTarget,
  quantity: number,
): CartMutationResult {
  const position = resolvePosition(cart, target);
  if (position < 0) {
    return { ok: false, cart, message: describeMissingTarget(target) };
  }
  const item = cart[position];
  if (!item) {
    return { ok: false, cart, message: describeMissingTarget(target) };
  }

  if (quantity <= 0) {
    return removeFromCart(cart, target);
  }
  if (quantity > item.product.stock) {
    return {
      ok: false,
      cart,
      message: `${item.product.name} 当前库存不足，无法调整为 ${quantity} 件`,
    };
  }

  const next = cart.map((current, index) =>
    index === position ? { ...current, quantity } : current,
  );
  return {
    ok: true,
    cart: next,
    message: `已将 ${item.product.name} 的数量改为 ${quantity} 件`,
  };
}

export function removeFromCart(cart: CartItem[], target: CartTarget): CartMutationResult {
  const position = resolvePosition(cart, target);
  if (position < 0) {
    return { ok: false, cart, message: describeMissingTarget(target) };
  }
  const item = cart[position];
  if (!item) {
    return { ok: false, cart, message: describeMissingTarget(target) };
  }
  const next = cart.filter((_, index) => index !== position);
  return { ok: true, cart: next, message: `已从购物车移除 ${item.product.name}` };
}

export function clearCart(cart: CartItem[]): CartMutationResult {
  if (cart.length === 0) {
    return { ok: false, cart, message: '购物车已经是空的' };
  }
  return { ok: true, cart: [], message: `已清空购物车（共 ${cart.length} 种商品）` };
}

/** 解析操作目标：优先按商品 id，其次按购物车序号（从 1 开始） */
function resolvePosition(cart: CartItem[], target: CartTarget): number {
  if (target.productId) {
    return cart.findIndex((item) => item.product.id === target.productId);
  }
  if (typeof target.index === 'number') {
    return target.index - 1;
  }
  return -1;
}

function describeMissingTarget(target: CartTarget): string {
  if (target.productId) return `购物车中没有该商品：${target.productId}`;
  if (typeof target.index === 'number') return `购物车中没有第 ${target.index} 件商品`;
  return '未指定要操作的商品';
}

/* ============================================================
   订单
   ============================================================ */

/**
 * 生成订单号。
 *
 * 传入 seed 时结果确定可复现：prepareOrder 里 interrupt() 会让节点在恢复时
 * 重新执行一次，若用随机数两次执行会得到不同订单号，前端弹窗里的单号与
 * 最终落单的单号就对不上了。用 thread_id + 购物车内容做种子即可保持一致。
 */
export function generateOrderId(seed?: string): string {
  const now = new Date();
  const date = [
    now.getFullYear(),
    `${now.getMonth() + 1}`.padStart(2, '0'),
    `${now.getDate()}`.padStart(2, '0'),
  ].join('');
  const suffix = seed ? hashSeed(seed) : Math.floor(Math.random() * 1_000_000);
  return `ES${date}${suffix.toString().padStart(6, '0')}`;
}

function hashSeed(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 1_000_000;
  }
  return hash;
}

export interface OrderDraftOptions {
  address?: OrderAddress;
  payment?: PaymentMethod;
  /** 指定订单号（interrupt 场景传确定性 seed，保证恢复后单号不变） */
  orderId?: string;
}

export type OrderDraftResult =
  | { ok: true; order: Order }
  | { ok: false; message: string };

/** 生成待确认订单草稿（prepareOrder 节点使用，interrupt 前调用） */
export function buildOrderDraft(
  cart: CartItem[],
  options: OrderDraftOptions = {},
): OrderDraftResult {
  if (cart.length === 0) {
    return { ok: false, message: '购物车是空的，无法下单' };
  }
  const summary = summarizeCart(cart);
  const blocked = summary.stockWarnings.filter((warning) => warning.includes('已缺货'));
  if (blocked.length > 0) {
    return { ok: false, message: `存在缺货商品，请先移除：${blocked.join('；')}` };
  }

  return {
    ok: true,
    order: {
      id: options.orderId ?? generateOrderId(),
      items: cart,
      address: options.address ?? MOCK_ADDRESS,
      payment: options.payment ?? 'alipay',
      originalSubtotal: summary.originalSubtotal,
      subtotal: summary.subtotal,
      discount: summary.discount,
      shippingFee: summary.shippingFee,
      total: summary.total,
      coupon: summary.coupon?.title,
      createdAt: new Date().toISOString(),
      status: 'pending',
    },
  };
}

/* ============================================================
   请求 / 输入契约（zod）
   ============================================================ */

/**
 * 购物车行契约（商品 id + 数量）。
 *
 * 导出它是为了让请求层直接复用：/api/agent 的请求体校验也需要同一份约束，
 * 之前那里是手写重复的（`z.object({ productId, quantity })`），
 * 同一份契约两处实现，改一处忘一处就会让两层约束悄悄不一致。
 */
export const cartLineSchema = z.object({
  productId: z.string().min(1).describe('商品 id'),
  quantity: z.number().int().min(1).max(99).describe('数量'),
});

/** 把「商品 id + 数量」列表解析为购物车实体（忽略不存在的 id） */
export function buildCartItems(
  lines: { productId: string; quantity: number }[],
): CartItem[] {
  return lines.flatMap((line) => {
    const product = getProductById(line.productId);
    return product ? [{ product, quantity: line.quantity }] : [];
  });
}
