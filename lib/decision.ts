import type { ComparisonResult, DecisionReason, Product } from '@/lib/types';
import { stockLevelOf, STOCK_LABEL, STOCK_RANK } from '@/lib/types';
import { formatCount, formatPrice } from '@/lib/utils';

/** 把一组数值归一化到 0 - 100（用于进度条） */
function normalize(values: number[], value: number): number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 100;
  return Math.round(((value - min) / (max - min)) * 100);
}

/**
 * 生成决策推荐理由（右栏「决策推荐」面板的数据源）。
 *
 * 每条理由都锚定到一件具体商品，并用 0 - 100 的分数驱动进度条，
 * 让「为什么推荐它」可量化、可对比，而不是一句空话。
 */
export function buildDecisionReasons(comparison: ComparisonResult): DecisionReason[] {
  const { products, highlights, valueScores } = comparison;
  if (products.length < 2) return [];

  const find = (id: string): Product | undefined =>
    products.find((product) => product.id === id);
  const prices = products.map((product) => product.price);
  const sales = products.map((product) => product.sales);

  const reasons: DecisionReason[] = [];

  const bestValue = find(highlights.bestValueId);
  if (bestValue) {
    reasons.push({
      label: '性价比最高',
      productId: bestValue.id,
      productName: bestValue.name,
      score: valueScores[bestValue.id] ?? 0,
      detail: `${formatPrice(bestValue.price)} · ${bestValue.rating} 分（评分 50% + 价格 50% 加权）`,
      tone: 'primary',
    });
  }

  const bestRating = find(highlights.highestRatingId);
  if (bestRating) {
    reasons.push({
      label: '评分最高',
      productId: bestRating.id,
      productName: bestRating.name,
      score: Math.round((bestRating.rating / 5) * 100),
      detail: `${bestRating.rating} 分 · ${bestRating.reviews} 条评价`,
      tone: 'success',
    });
  }

  const lowestPrice = find(highlights.lowestPriceId);
  if (lowestPrice) {
    reasons.push({
      label: '价格最低',
      productId: lowestPrice.id,
      productName: lowestPrice.name,
      score: 100 - normalize(prices, lowestPrice.price),
      detail: `${formatPrice(lowestPrice.price)} · 比同组最高价省 ${formatPrice(
        Math.max(...prices) - lowestPrice.price,
      )}`,
      tone: 'primary',
    });
  }

  const bestSales = find(highlights.highestSalesId);
  if (bestSales) {
    reasons.push({
      label: '销量最高',
      productId: bestSales.id,
      productName: bestSales.name,
      score: normalize(sales, bestSales.sales),
      detail: `已售 ${formatCount(bestSales.sales)} · 市场验证更充分`,
      tone: 'neutral',
    });
  }

  const mostStock = find(highlights.mostStockId);
  if (mostStock) {
    const level = stockLevelOf(mostStock.stock);
    reasons.push({
      // 不用「最充足」这类程度词，也不展示件数：件数是派生值，
      // 只有「有货 / 紧张 / 缺货」来自真实的 availability 信号
      label: '现货可发',
      productId: mostStock.id,
      productName: mostStock.name,
      // 分数按库存等级映射，不用派生件数（用件数打分等于按哈希打分）
      score: Math.round((STOCK_RANK[level] / 2) * 100),
      detail: `${STOCK_LABEL[level]} · 下单后发货更快`,
      tone: level === 'in_stock' ? 'success' : 'warning',
    });
  }

  return reasons;
}

/** 一句话对比结论（LLM 不可用时的模板回复使用） */
export function buildCompareConclusion(comparison: ComparisonResult): string {
  const { products, highlights, valueScores } = comparison;
  const lowest = products.find((product) => product.id === highlights.lowestPriceId);
  const bestRating = products.find((product) => product.id === highlights.highestRatingId);
  const bestValue = products.find((product) => product.id === highlights.bestValueId);
  if (!lowest || !bestRating || !bestValue) return '';

  if (lowest.id === bestValue.id) {
    return `**${bestValue.name}** 价格最低（${formatPrice(bestValue.price)}）且性价比最高（综合 ${
      valueScores[bestValue.id] ?? 0
    } 分），预算优先就选它。`;
  }
  if (bestRating.id === bestValue.id) {
    return `**${bestValue.name}** 评分最高（${bestRating.rating} 分）且性价比最优，综合表现最均衡。`;
  }
  return `**${bestValue.name}** 综合性价比最高（${valueScores[bestValue.id] ?? 0} 分）；如果更看重口碑，**${
    bestRating.name
  }** 评分最高（${bestRating.rating} 分）；预算敏感则选 **${lowest.name}**（${formatPrice(
    lowest.price,
  )}）。`;
}
