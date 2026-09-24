import type { AgentStateValue } from '@/lib/agent/state';
import type { Product } from '@/lib/types';
import { formatCount, hasRealSales } from '@/lib/utils';

/**
 * 回复落地校验（grounding guard）。
 *
 * 第一性原理：LLM 的输出属于**不可信输入**。提示词里写「不要编造价格」只是软约束，
 * 换一个更弱的模型就可能出现「¥2999 的降噪耳机」这种库里根本不存在的价格，
 * 而它会被直接渲染给用户——这在电商场景是不可接受的。
 *
 * 因此在回复进入状态之前做一次硬校验：把回复里出现的所有 ¥ 金额抽出来，
 * 逐个核对是否来自真实数据（商品价格 / 原价 / 数量小计 / 优惠 / 运费 / 应付 / 价差）。
 * 有任何一个对不上，就判定为「未落地」，改用模板回复（模板数据 100% 来自状态）。
 */

const PRICE_PATTERN = /¥\s?(\d[\d,]*(?:\.\d+)?)/g;
/** 「8.5万」这类缩写的销量/评价数 */
const WAN_PATTERN = /(\d+(?:\.\d+)?)\s*万/g;
/**
 * 带标签的数量表述：「销量 8.5万」「评价 1,000 条」「已售 300」。
 *
 * 为什么需要它：只比对数字口径是不够的。某件商品没有真实销量（sales = 0）
 * 但评价数是 84507，模型完全可以把评价数搬过来写成「销量 8.5万」——
 * 数字本身真实存在，但它被**贴错了标签**。只有把标签一起解析出来，
 * 才能分别核对「销量」与「评价」两个口径。
 */
const LABELED_COUNT_PATTERN = /(销量|已售|评价|评论)\s*[:：]?\s*(\d[\d,]*(?:\.\d+)?万?)/g;

/** 标签 → 该标签应当对应的字段 */
const SALES_LABELS = new Set(['销量', '已售']);
const REVIEW_LABELS = new Set(['评价', '评论']);

function toAmount(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

/** 回复中出现的全部金额 */
export function extractAmounts(text: string): number[] {
  return Array.from(text.matchAll(PRICE_PATTERN)).map((match) =>
    toAmount(match[1] ?? '0'),
  );
}

/** 状态里合法的「万」口径写法：销量与评价数的展示字符串（并集，用于裸数字校验） */
function collectKnownWanValues(state: AgentStateValue): Set<string> {
  const known = new Set<string>();
  for (const product of collectProducts(state)) {
    // 没有真实销量的商品不把「0」登记成合法销量口径——
    // 否则模型说「销量 0」也会被判为落地，而界面根本没有这个数字
    if (hasRealSales(product.sales)) known.add(formatCount(product.sales));
    known.add(formatCount(product.reviews));
  }
  return known;
}

/** 按字段分别收集合法口径：销量只登记真实销量，评价登记评价数 */
function collectKnownCounts(state: AgentStateValue): {
  sales: Set<string>;
  reviews: Set<string>;
} {
  const sales = new Set<string>();
  const reviews = new Set<string>();
  for (const product of collectProducts(state)) {
    if (hasRealSales(product.sales)) sales.add(formatCount(product.sales));
    reviews.add(formatCount(product.reviews));
  }
  return { sales, reviews };
}

/** 状态里出现过的全部商品（去重前的并集） */
function collectProducts(state: AgentStateValue): Product[] {
  return [
    ...state.searchResults,
    ...state.compareTargets,
    ...state.cart.map((item) => item.product),
    ...(state.comparison?.products ?? []),
  ];
}

/** 状态里所有「合法」的金额（含两两价差，避免把「省 ¥110」误判为编造） */
function collectKnownAmounts(state: AgentStateValue): Set<number> {
  const known = new Set<number>();
  const products = collectProducts(state);

  for (const product of products) {
    known.add(product.price);
    known.add(product.originalPrice);
    known.add(product.originalPrice - product.price);
  }
  for (const item of state.cart) {
    known.add(item.product.price * item.quantity);
    known.add(item.product.originalPrice * item.quantity);
  }

  const comparison = state.comparison;
  if (comparison) {
    for (const score of Object.values(comparison.valueScores)) known.add(score);
    const prices = comparison.products.map((product) => product.price);
    const original = comparison.products.map((product) => product.originalPrice);
    for (const left of [...prices, ...original]) {
      for (const right of [...prices, ...original]) {
        known.add(Math.abs(left - right));
      }
    }
  }

  const order = state.pendingOrder;
  if (order) {
    for (const amount of [
      order.total,
      order.subtotal,
      order.originalSubtotal,
      order.discount,
      order.shippingFee,
    ]) {
      known.add(amount);
    }
  }

  return known;
}

export interface GroundingResult {
  grounded: boolean;
  /** 无法对应到真实数据的金额，用于时间线诊断 */
  unknownAmounts: number[];
  /** 与界面口径不一致的数量表述（截断的「8.4万」，或贴错标签的「销量 8.5万」） */
  mismatchedCounts: string[];
}

export function checkGrounding(reply: string, state: AgentStateValue): GroundingResult {
  const amounts = extractAmounts(reply);
  const known = collectKnownAmounts(state);
  const unknownAmounts = Array.from(new Set(amounts.filter((amount) => !known.has(amount))));

  // 校验 1：裸「万」数字必须与界面口径完全一致
  // （LLM 自己截断出的 8.4万 会被这里拦下）
  const knownWan = collectKnownWanValues(state);
  const mismatched: string[] = Array.from(
    new Set(
      Array.from(reply.matchAll(WAN_PATTERN))
        .map((match) => `${match[1]}万`)
        .filter((value) => !knownWan.has(value)),
    ),
  );

  // 校验 2：带标签的数量必须与**该标签对应的字段**一致。
  // 只做校验 1 会漏掉「把评价数写成销量」这种贴错标签的情况：
  // 数字确实来自真实数据，但它不是销量。
  const { sales: knownSales, reviews: knownReviews } = collectKnownCounts(state);
  for (const match of reply.matchAll(LABELED_COUNT_PATTERN)) {
    const label = match[1];
    const value = match[2];
    if (!label || !value) continue;
    const pool = SALES_LABELS.has(label)
      ? knownSales
      : REVIEW_LABELS.has(label)
        ? knownReviews
        : null;
    if (!pool) continue;
    if (!pool.has(value)) mismatched.push(`${label} ${value}`);
  }

  const mismatchedCounts = Array.from(new Set(mismatched));

  return {
    grounded: unknownAmounts.length === 0 && mismatchedCounts.length === 0,
    unknownAmounts,
    mismatchedCounts,
  };
}
