import { PRODUCTS } from '@/lib/catalog/products';
import type { AgentStateValue } from '@/lib/agent/state';
import { CATEGORIES, STOCK_LABEL, stockLevelOf, type SearchFilters } from '@/lib/types';
import { formatCount, hasRealSales } from '@/lib/utils';

/** 目录中真实存在的标签与品牌：让 LLM 只输出能命中商品的取值 */
const CATALOG_TAGS = Array.from(new Set(PRODUCTS.flatMap((product) => product.tags)));
const CATALOG_BRANDS = Array.from(new Set(PRODUCTS.map((product) => product.brand)));

export const INTENT_SYSTEM_PROMPT = `你是电商购物助手的「意图解析」模块，只做结构化解析，不回复用户。

意图分类定义：
- search：用户想找/买商品（含首次提出需求、明确品类或预算）
- refine：用户在当前搜索结果上追加或调整条件（例如「再便宜一点的」「要轻一点的」「换个牌子」）
- compare：用户要求对比商品（例如「帮我对比这几款」「哪个更好」）
- cart：购物车操作（加入购物车、删除第 N 个、改数量、清空）
- checkout：下单结算（下单、结算、付款）
- chat：与购物无关的闲聊或无法归类的输入

解析要求：
1. 关键词 keywords 只能从商品名称中真实存在的词里选，例如「跑鞋」「耳机」「牛奶」。
2. 功能标签 tags 只能从给定标签词表中选择，例如「透气」「降噪」「轻量」。
3. 价格一律解析为数字（元）：用户说「500 以内」→ maxPrice=500；「2000 左右」→ minPrice=1600、maxPrice=2400。
4. 品类 category 只能取给定品类之一，无法确定时返回 null。
5. 用户说「再便宜一点」这类相对表述时，intent=refine，不要凭空编造价格数字。

关于历史对话（仅当下方提供了「历史对话」段时适用）：
6. 若当前输入可以独立判断意图，**不要**引用历史。
7. 仅在当前输入含指代词（「刚才那个」「换成第 N 件」「那个」「它」「这个」）时，
   才用历史确定指代对象。
8. 历史只用于**消解指代**，不用于推断意图类别 —— 不要因为历史里在聊图书，
   就把一句独立的「推荐点耳机」也归成图书。
9. 用户在已有结果上**替换或切换目标**时，intent 一律是 refine，不是 search：
   「换成第二件」「换个便宜的」「换成那个」「再换一个」「要第三个」。
   若输入里出现「第 N 件 / 个 / 款」这种**序数**，把 N 填进 targetIndex（从 1 开始），
   它表示「上一轮结果里的第 N 件」；没有序数时 targetIndex 留空。
   这类输入不要在 keywords 里填指代词本身（「第二件」不是一个商品关键词），
   让 keywords 留空即可 —— refine 会自动沿用上一轮的检索条件。
   注意：只有用户**明确说出新的品类/商品**（「推荐点耳机」）时才算 search。`;

export function buildIntentUserPrompt(
  text: string,
  previous: SearchFilters,
  history = '',
): string {
  const lines = [
    `可选品类：${CATEGORIES.join('、')}`,
    `可选标签：${CATALOG_TAGS.join('、')}`,
    `可选品牌：${CATALOG_BRANDS.join('、')}`,
    `当前筛选条件：${JSON.stringify(previous)}`,
  ];
  if (history) {
    lines.push('', '历史对话（仅用于理解指代，不要据此推断意图类别）：', history);
  }
  lines.push('', `用户输入：${text}`);
  return lines.join('\n');
}

export const REPLY_SYSTEM_PROMPT = `你是「购物助手」，一个以对话为核心的电商导购 Agent。

回复要求：
1. 用中文，简洁直接，不要客套话和营销腔（禁止「尊贵的用户」「竭诚为您服务」这类表达）。
2. 必须严格基于给定的商品 / 购物车 / 对比结论数据，禁止编造不存在的商品、价格、参数或优惠。
   如果数据里没有用户问的品类，直接说明没有，并给出实际检索到的内容。
3. 使用 Markdown：商品名加粗，价格用 ¥ 前缀，多个商品用有序列表。
   **列举商品时必须按数据给出的顺序，不要自行重排**（按价格、评分重排会让用户看到的
   序号与商品区不一致，而用户会用「第 2 件」这种序数来指代商品区里的第 2 件）。
   如果确实要按某个维度排序，必须先说明「按价格从低到高」。序号从 1 开始，与商品区一致。
4. 对比场景必须给出结论（哪个性价比最高 / 评分最高 / 价格最低），而不是只罗列参数。
5. 回复控制在 150 字以内，结尾给一个明确的下一步建议。
6. 涉及数量时必须与数据中给出的件数完全一致（数据写「检索结果（6 件）」就不能说成 5 件）。
7. 数据里的销量与评价数已经是最终展示口径（例如「8.5万」），必须**原样引用**，
   不要自己换算、截断或四舍五入（把 8.5万 写成 8.4万 会让用户认为数据是编的）。
8. 商品行里**没有**「销量」二字时，说明该来源没有销量数据（只有评价数），
   此时只能引用评价数，绝对不要自己推测或编造一个销量数字。
9. 不要输出 JSON，不要重复用户的话。`;

/** 把当前状态整理成 LLM 可读的精简上下文（只给必要字段，避免 token 浪费） */
export function buildReplyContext(state: AgentStateValue): string {
  const lines: string[] = [`意图：${state.intent}`];

  if (state.searchResults.length > 0) {
    // 只给前 5 件明细，但**必须**把总数写清楚：
    // 实测模型会把「列出的条数」当成总数，回复写「检索到 5 本」而中栏商品区写着
    // 「8 件商品」，同一个事实出现两个数字（与销量口径不一致是同一类问题）。
    const shown = state.searchResults.slice(0, 5);
    lines.push(
      `检索条件：${JSON.stringify(state.searchFilters)}`,
      `检索结果：共 ${state.searchResults.length} 件（下列只列出前 ${shown.length} 件明细；` +
        `回复里提到总数时必须用 ${state.searchResults.length}，不要用明细条数）：`,
      ...shown.map((product) => {
        const level = stockLevelOf(product.stock);
        // 销量/评价数直接给最终展示口径（8.5万），不给原始数字：
        // 否则模型会自己截断成 8.4万，与界面口径不一致。
        // 来源没有销量字段的商品（sales === 0）只给评价数——不能让模型把
        // 占位的 0 或估算值当成真实销量说出去。
        const heat = hasRealSales(product.sales)
          ? `销量${formatCount(product.sales)} 评价${formatCount(product.reviews)}`
          : `评价${formatCount(product.reviews)}`;
        return `- ${product.name}（${product.brand}）¥${product.price} 原价¥${product.originalPrice} ${product.rating}分 ${heat} ${STOCK_LABEL[level]} 标签[${product.tags.join('/')}]`;
      }),
    );
  } else {
    lines.push('检索结果：无');
  }

  if (state.compareTargets.length > 0) {
    lines.push(
      `待对比商品：${state.compareTargets.map((product) => product.name).join('、')}`,
    );
  }

  if (state.comparison) {
    const { products, rows, highlights, valueScores } = state.comparison;
    const nameOf = (id: string): string =>
      products.find((product) => product.id === id)?.name ?? '—';
    const diffKeys = rows.filter((row) => row.diff).map((row) => row.key);
    lines.push(
      `对比结论（共 ${products.length} 件商品 / ${rows.length} 项参数）：`,
      `- 价格最低：${nameOf(highlights.lowestPriceId)}`,
      `- 评分最高：${nameOf(highlights.highestRatingId)}`,
      // 参与对比的商品都没有真实销量时，这一条不成立，不能给模型一个空名字
      ...(highlights.highestSalesId ? [`- 销量最高：${nameOf(highlights.highestSalesId)}`] : []),
      `- 现货可发：${nameOf(highlights.mostStockId)}`,
      `- 性价比最高：${nameOf(highlights.bestValueId)}（综合 ${valueScores[highlights.bestValueId] ?? 0} 分）`,
      `- 存在差异的参数：${diffKeys.length > 0 ? diffKeys.join('、') : '无'}`,
    );
  }

  if (state.cart.length > 0) {
    lines.push(
      '购物车：',
      ...state.cart.map(
        (item) => `- ${item.product.name} × ${item.quantity}（¥${item.product.price}/件）`,
      ),
    );
  }

  if (state.pendingOrder) {
    lines.push(
      `待确认订单：${state.pendingOrder.id} 实付 ¥${state.pendingOrder.total}`,
    );
  }

  return lines.join('\n');
}
