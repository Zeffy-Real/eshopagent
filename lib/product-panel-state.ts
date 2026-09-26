import type { AgentIntent, SearchFilters } from '@/lib/types';

/**
 * 中栏（商品区）的三种展示态 —— **唯一判据实现**。
 *
 * 为什么需要第三态（2026-09-26 解冻轮收尾）：原先只有「有结果 = 搜索结果 / 没结果 = 为你推荐」
 * 两态，于是**搜索类意图 + 0 命中**时中栏也回落成推荐，用户分不清「没搜到」还是
 * 「被当成了闲聊」。闲聊轮回落推荐是对的（行为不变），但搜索空结果必须明确告知。
 *
 * 为什么判据读 snapshot 里的 `intent` 而不是在客户端重新推导：意图是服务端解析的产物，
 * 客户端再推一遍就有了两套口径（规则路径与 LLM 路径的解析规则本来不同）。
 */
export type ProductPanelState = 'results' | 'empty-search' | 'recommend';

/**
 * 哪些意图算「搜索类」：`search` / `refine`
 *
 * - `search` / `refine`：用户就是要找商品 —— 0 命中时必须说清「没搜到」；
 * - `compare`：用户要的是对比，即使没有结果也不是「搜索失败」（他可能只是想对比上一轮
 *   看中的几件），回落推荐位即可；
 * - `cart` / `checkout`：用户在管购物车 / 下单，与商品检索无关，回落推荐位；
 * - `chat`：闲聊轮按现状回落推荐位 —— 这条是刻意的，**不要改**。
 */
const SEARCH_INTENTS: AgentIntent[] = ['search', 'refine'];

export function isSearchIntent(intent: AgentIntent | null | undefined): boolean {
  return intent !== null && intent !== undefined && SEARCH_INTENTS.includes(intent);
}

/**
 * 筛选条件里是否存在**有效筛选**（品类 / 关键词 / 标签 / 品牌 / 价格 / 评分）。
 *
 * 服务端与客户端读同一份判据（**唯一实现**）：
 * - 服务端（`searchProducts`）据此决定要不要把命中 id 列表下发 —— 无筛选条件时
 *   客户端能用目录现算全量，不必让 420 个 id 挤进每个状态帧；
 * - 客户端（中栏「查看全部 N 件」）据此选择浏览视图的数据来源：无筛选 → 整个目录，
 *   有筛选 → 本轮命中 id 列表。
 * 两边必须一致，否则会出现「入口在、点开却少件」或反之。
 */
export function hasEffectiveFilters(filters: SearchFilters | null | undefined): boolean {
  if (!filters) return false;
  return Boolean(
    filters.category ||
      (filters.keywords?.length ?? 0) > 0 ||
      (filters.tags?.length ?? 0) > 0 ||
      (filters.brands?.length ?? 0) > 0 ||
      filters.minPrice !== undefined ||
      filters.maxPrice !== undefined ||
      filters.minRating !== undefined,
  );
}

export function productPanelStateOf(input: {
  intent: AgentIntent | null | undefined;
  /** 本轮命中总数（截断前）——来自 `snapshot.searchTotal` */
  total: number;
  /** 实际展示的条数——来自 `snapshot.searchResults.length` */
  shown: number;
}): ProductPanelState {
  // 有结果就是搜索结果（哪怕本轮意图是闲聊：上一轮的列表还在，界面不该翻脸）
  if (input.shown > 0) return 'results';
  return isSearchIntent(input.intent) && input.total === 0 ? 'empty-search' : 'recommend';
}

/**
 * 浏览视图的展示窗口（纯函数）：`visible` = 用户已「加载更多」到的条数。
 *
 * 为什么分页而不是无限滚动 / 一次全画：浏览视图动辄 60（品类）到 420（全量）件，
 * 一次渲染 420 张卡片有成本；分页让渲染量与用户意图匹配（点一次多一屏），
 * 而且用户始终能看到「已显示 M / 共 N」——不出现「不知道还有没有」的滚动黑洞。
 */
export function browseWindow<T>(
  items: T[],
  visible: number,
): { shown: T[]; remaining: number } {
  const count = Math.max(0, Math.min(visible, items.length));
  return { shown: items.slice(0, count), remaining: items.length - count };
}