import { tool } from '@langchain/core/tools';
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
   - 对应 tool() 只负责把 LLM 的自然语言解析成结构化指令并做存在性、
     库存校验，返回指令 JSON，不直接改状态（LangGraph 中状态写入只
     能发生在节点内）。
   - 计算型操作（get_cart_summary / create_order）以 cart 为输入，
     既可由节点直接调用，也可作为工具被 LLM 调用。
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
   LLM 工具契约
   ============================================================ */

/** LLM 侧只传商品 id 与数量，商品实体由服务端解析，避免让模型回显整份商品对象 */
const cartLineSchema = z.object({
  productId: z.string().describe('商品 id'),
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

const resolveCartLines = buildCartItems;

export const addToCartTool = tool(
  async ({ productId, quantity }) => {
    const product = getProductById(productId);
    if (!product) return JSON.stringify({ ok: false, message: `未找到商品：${productId}` });
    if (product.stock <= 0) {
      return JSON.stringify({ ok: false, message: `${product.name} 当前缺货` });
    }
    return JSON.stringify({
      ok: true,
      action: 'add_to_cart',
      productId,
      productName: product.name,
      quantity,
      unitPrice: product.price,
      message: `准备将 ${product.name} × ${quantity} 加入购物车`,
    });
  },
  {
    name: 'add_to_cart',
    description: '把指定商品加入购物车。用户说「加入购物车」「买这个」「要这个」时调用。',
    schema: z.object({
      productId: z.string().describe('商品 id，例如 p-5001'),
      quantity: z.number().int().min(1).max(99).optional().describe('数量，默认 1'),
    }),
  },
);

export const updateCartItemTool = tool(
  async ({ productId, index, quantity }) =>
    JSON.stringify({
      ok: true,
      action: 'update_cart_item',
      productId,
      index,
      quantity,
      message: `准备把购物车中该商品的数量改为 ${quantity} 件`,
    }),
  {
    name: 'update_cart_item',
    description: '修改购物车中某件商品的数量。用户说「把数量改成 3」「加一件」时调用。',
    schema: z.object({
      productId: z.string().optional().describe('商品 id，与 index 二选一'),
      index: z.number().int().min(1).optional().describe('购物车中的序号（从 1 开始）'),
      quantity: z.number().int().min(0).max(99).describe('目标数量，0 表示删除'),
    }),
  },
);

export const removeFromCartTool = tool(
  async ({ productId, index }) =>
    JSON.stringify({
      ok: true,
      action: 'remove_from_cart',
      productId,
      index,
      message: index
        ? `准备移除购物车中的第 ${index} 件商品`
        : '准备移除购物车中该商品',
    }),
  {
    name: 'remove_from_cart',
    description: '从购物车删除商品。用户说「删掉第 2 个」「不要这个了」时调用。',
    schema: z.object({
      productId: z.string().optional().describe('商品 id，与 index 二选一'),
      index: z.number().int().min(1).optional().describe('购物车中的序号（从 1 开始）'),
    }),
  },
);

export const clearCartTool = tool(
  async () => JSON.stringify({ ok: true, action: 'clear_cart', message: '准备清空购物车' }),
  {
    name: 'clear_cart',
    description: '清空购物车。用户说「清空购物车」「全部删掉」时调用。',
    schema: z.object({}),
  },
);

export const getCartSummaryTool = tool(
  async ({ cart }) => JSON.stringify(summarizeCart(resolveCartLines(cart))),
  {
    name: 'get_cart_summary',
    description: '统计购物车商品、优惠券与应付金额。用户询问总价或优惠时调用。',
    schema: z.object({
      cart: z.array(cartLineSchema).describe('当前购物车内容（商品 id + 数量）'),
    }),
  },
);

export const createOrderTool = tool(
  async ({ cart, payment }) => {
    const result = buildOrderDraft(resolveCartLines(cart), { payment });
    return JSON.stringify(result);
  },
  {
    name: 'create_order',
    description: '根据购物车生成待确认订单（含金额明细与收货地址），不会真实支付。',
    schema: z.object({
      cart: z.array(cartLineSchema).describe('当前购物车内容（商品 id + 数量）'),
      payment: z
        .enum(['alipay', 'wechat', 'card'])
        .optional()
        .describe('支付方式，默认支付宝'),
    }),
  },
);

export const cartTools = [
  addToCartTool,
  updateCartItemTool,
  removeFromCartTool,
  clearCartTool,
  getCartSummaryTool,
  createOrderTool,
];
