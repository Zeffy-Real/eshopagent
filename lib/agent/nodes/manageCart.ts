import { z } from 'zod';
import { isLlmEnabled } from '@/lib/agent/llm';
import type { AgentStateUpdate, AgentStateValue } from '@/lib/agent/state';
import { invokeStructured } from '@/lib/agent/structured';
import { summarizeCart } from '@/lib/cart-pricing';
import {
  addToCart,
  clearCart,
  removeFromCart,
  updateCartItem,
} from '@/lib/agent/tools/cartTools';
import { createLogEntry, lastHumanText } from '@/lib/agent/utils';
import { getProductById } from '@/lib/catalog/products';
import type { CartAction, Product } from '@/lib/types';
import { formatPrice } from '@/lib/utils';

const CN_NUMERALS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function toNumber(token: string | undefined): number | undefined {
  if (!token) return undefined;
  if (/^\d+$/.test(token)) return Number(token);
  return CN_NUMERALS[token];
}

/** 规则解析购物车指令（LLM 不可用时的兜底，也是无 Key 时的主路径） */
function parseActionByRules(state: AgentStateValue, text: string): CartAction {
  if (/清空|全部(删|清|移除)|都删/.test(text)) {
    return { action: 'clear', reason: '识别到清空购物车' };
  }

  const indexToken = text.match(/第\s*([一二两三四五六七八九十\d]+)\s*(个|件|项|种)/)?.[1];
  const index = toNumber(indexToken);

  // 商品名匹配：先匹配购物车（用户通常在改购物车里的东西），再匹配搜索结果
  const namePool: Product[] = [
    ...state.cart.map((item) => item.product),
    ...state.searchResults,
  ];
  const byName =
    namePool.find((product) => text.includes(product.name)) ??
    namePool.find((product) => product.name.length >= 4 && text.includes(product.name.slice(0, 4)));

  let productId = byName?.id;
  if (!productId && !index && /这个|它|这款|该商品/.test(text)) {
    productId =
      state.cart[state.cart.length - 1]?.product.id ?? state.searchResults[0]?.id;
  }

  const quantityToken = text.match(
    /(?:数量|改成|改为|设为|变成|来|要)\s*([一二两三四五六七八九十\d]+)\s*(件|个)?/,
  )?.[1];
  let quantity = toNumber(quantityToken);
  if (quantity === undefined) {
    if (/加一件|再来一件|多来一件/.test(text)) quantity = (state.cart[0]?.quantity ?? 0) + 1;
    else if (/减一件|少一件/.test(text)) quantity = (state.cart[0]?.quantity ?? 0) - 1;
  }

  if (/删|移除|不要|去掉|取消/.test(text)) {
    return { action: 'remove', productId, index, reason: '识别到删除指令' };
  }
  if (/总价|多少钱|合计|优惠|应付|结算前/.test(text)) {
    return { action: 'summary', reason: '识别到金额查询' };
  }
  if (/数量|改成|改为|加一件|减一件|多来/.test(text)) {
    return {
      action: 'update',
      productId,
      index,
      quantity: quantity ?? 1,
      reason: '识别到数量调整指令',
    };
  }
  if (/加入购物车|加购|买|要|来一?[个件双]|下单前/.test(text)) {
    return { action: 'add', productId, index, quantity: quantity ?? 1, reason: '识别到加购指令' };
  }
  return { action: 'none' };
}

const CartActionSchema = z.object({
  action: z.enum(['add', 'update', 'remove', 'clear', 'summary', 'none']),
  productId: z.string().nullish(),
  index: z.number().int().min(1).nullish(),
  quantity: z.number().int().min(0).max(99).nullish(),
  reason: z.string().nullish(),
});

/** LLM 解析：把购物车与搜索结果作为上下文，让模型解析出结构化指令 */
async function parseActionWithLlm(
  state: AgentStateValue,
  text: string,
): Promise<CartAction> {
  const context = [
    `购物车：${state.cart.length === 0 ? '（空）' : state.cart.map((item, index) => `${index + 1}. ${item.product.name}（id=${item.product.id}）× ${item.quantity}`).join('；')}`,
    `搜索结果：${state.searchResults.length === 0 ? '（无）' : state.searchResults.map((product) => `${product.name}（id=${product.id}，${formatPrice(product.price)}）`).join('；')}`,
    `用户输入：${text}`,
  ].join('\n');

  const result = await invokeStructured({
    schema: CartActionSchema,
    name: 'cart_action',
    system:
      '你是电商购物助手的购物车指令解析模块。只输出结构化结果，不要回复用户。' +
      'action 取值：add 加购、update 改数量、remove 删除、clear 清空、summary 查询金额、none 与购物车无关。' +
      '商品优先用上下文里给出的 id；用户说「第 2 个」时用 index（从 1 开始）。',
    user: context,
    temperature: 0,
  });

  return {
    action: result.value.action,
    productId: result.value.productId ?? undefined,
    index: result.value.index ?? undefined,
    quantity: result.value.quantity ?? undefined,
    reason: result.value.reason ?? undefined,
  };
}

interface TargetResolution {
  product?: Product;
  error?: string;
}

/**
 * 解析操作目标：id → 序号 → 默认取搜索结果首件 / 购物车唯一一件。
 *
 * 序号的语义取决于语境：
 * - prefer=catalog（加购）：用户看着商品区说「第 1 件」，指向搜索结果；
 * - prefer=cart（改数量/删除）：用户看着购物车说「第 2 件」，指向购物车。
 */
function resolveTarget(
  state: AgentStateValue,
  action: CartAction,
  prefer: 'cart' | 'catalog',
): TargetResolution {
  if (action.productId) {
    const product = getProductById(action.productId);
    if (product) return { product };
    return { error: `未找到商品：${action.productId}` };
  }
  if (typeof action.index === 'number') {
    const fromCart = state.cart[action.index - 1]?.product;
    const fromSearch = state.searchResults[action.index - 1];
    const product = prefer === 'cart' ? fromCart : fromSearch ?? fromCart;
    if (product) return { product };
    return {
      error: `没有第 ${action.index} 件商品可操作（当前${prefer === 'cart' ? '购物车' : '搜索结果'}只有 ${
        prefer === 'cart' ? state.cart.length : state.searchResults.length
      } 件）`,
    };
  }
  if (prefer === 'cart') {
    if (state.cart.length === 1) {
      const only = state.cart[0];
      if (only) return { product: only.product };
    }
    return { error: '没能确定要操作的商品，可以说「第 1 件」或直接说商品名' };
  }
  const first = state.searchResults[0];
  if (first) return { product: first };
  if (state.cart.length === 1) {
    const only = state.cart[0];
    if (only) return { product: only.product };
  }
  return { error: '没有可加购的商品，先搜索出结果再说「加入购物车」' };
}

/**
 * 购物车管理节点。
 *
 * 状态变更只能发生在节点内，因此这里把用户指令解析为 CartAction 后，
 * 直接调用 cartTools 的纯函数拿到新数组写回 state.cart。
 * 解析路径：LLM 结构化输出优先，失败/未配置时走规则解析。
 */
export async function manageCartNode(
  state: AgentStateValue,
): Promise<AgentStateUpdate> {
  const startedAt = Date.now();
  const text = lastHumanText(state.messages);

  let action: CartAction | null = null;
  let source: 'llm' | 'rules' = 'rules';
  let llmError: string | null = null;
  if (isLlmEnabled() && text.trim()) {
    try {
      action = await parseActionWithLlm(state, text);
      source = 'llm';
    } catch (error) {
      action = null;
      llmError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!action || action.action === 'none') {
    action = parseActionByRules(state, text);
    source = 'rules';
  }

  const log = (title: string, detail: string, status: 'done' | 'error' = 'done') =>
    createLogEntry({
      kind: 'tool',
      name: `cart_${action?.action ?? 'none'}`,
      title,
      detail: `${source === 'llm' ? 'LLM 解析' : `规则解析${llmError ? ` · LLM 失败：${llmError.slice(0, 60)}` : ''}`} · ${detail}`,
      status,
      startedAt,
    });

  switch (action.action) {
    case 'add': {
      const target = resolveTarget(state, action, 'catalog');
      if (!target.product) {
        return { toolCallLog: [log('加购失败', target.error ?? '未能确定商品', 'error')] };
      }
      const result = addToCart(state.cart, target.product.id, action.quantity ?? 1);
      return {
        cart: result.cart,
        toolCallLog: [log('加入购物车', result.message, result.ok ? 'done' : 'error')],
      };
    }

    case 'update': {
      const target = resolveTarget(state, action, 'cart');
      if (!target.product) {
        return { toolCallLog: [log('修改数量失败', target.error ?? '未能确定商品', 'error')] };
      }
      const result = updateCartItem(
        state.cart,
        { productId: target.product.id },
        action.quantity ?? 1,
      );
      return {
        cart: result.cart,
        toolCallLog: [log('调整数量', result.message, result.ok ? 'done' : 'error')],
      };
    }

    case 'remove': {
      const target = resolveTarget(state, action, 'cart');
      if (!target.product) {
        return { toolCallLog: [log('删除失败', target.error ?? '未能确定商品', 'error')] };
      }
      const result = removeFromCart(state.cart, { productId: target.product.id });
      return {
        cart: result.cart,
        toolCallLog: [log('移出购物车', result.message, result.ok ? 'done' : 'error')],
      };
    }

    case 'clear': {
      const result = clearCart(state.cart);
      return {
        cart: result.cart,
        toolCallLog: [log('清空购物车', result.message, result.ok ? 'done' : 'error')],
      };
    }

    case 'summary': {
      const summary = summarizeCart(state.cart);
      if (summary.items.length === 0) {
        return { toolCallLog: [log('购物车金额', '购物车是空的', 'error')] };
      }
      return {
        toolCallLog: [
          log(
            '统计购物车金额',
            `${summary.count} 件商品，商品合计 ${formatPrice(summary.subtotal)}${
              summary.coupon ? `，可用「${summary.coupon.title}」` : ''
            }，应付 ${formatPrice(summary.total)}`,
          ),
        ],
      };
    }

    default:
      return {
        toolCallLog: [
          log(
            '未识别到购物车指令',
            '可以说「加入购物车」「把第 2 件删掉」「数量改成 3」「清空购物车」',
            'error',
          ),
        ],
      };
  }
}
