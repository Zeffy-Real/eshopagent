import type { AgentStateSnapshot } from '@/lib/agent/events';
import type { BrowseSource } from '@/lib/catalog/browse-products';
import type { AgentIntent, Product, SearchFilters, SortKey } from '@/lib/types';

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
 * - 客户端（中栏就地展开）据此选择追加数据的来源：无筛选 → 整个目录，
 *   有筛选 → 本轮命中 id 列表。
 * 两边必须一致，否则会出现「有按钮、点了却少件」或反之。
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
 * 「加载更多」一次追加的件数（中栏就地展开与浏览视图分页**同一个常量**：
 * 两处「点一次多一屏」的节奏一致，文案口径也就能对齐）。网格最多 4 列 → 24 件约 6 行。
 */
export const EXPAND_PAGE_SIZE = 24;

/**
 * 纯客户端重排（价格 / 评分 / 销量；`relevance` 保持传入顺序）。
 *
 * 与排序控件同源一处实现（原先在 `components/product/sort-control.tsx`，2026-09-26 移到 lib）：
 * 升 / 降序的切换规则在控件里（点「价格」在 `price_asc` 与 `price_desc` 之间切换），
 * 重排规则跟着它走，才不会出现「控件显示价格降序、列表却按升序排」这类第二份实现的分叉。
 * 移到 lib 是为了让**中栏、浏览视图、服务端顺序对齐**都读同一份，且不让 lib→component 反向依赖。
 * 只做展示层排序，不改任何检索 / 推荐结果集。
 */
export function sortProducts(products: Product[], sort: SortKey): Product[] {
  const list = products.slice();
  switch (sort) {
    case 'price_asc':
      return list.sort((a, b) => a.price - b.price);
    case 'price_desc':
      return list.sort((a, b) => b.price - a.price);
    case 'rating':
      return list.sort((a, b) => b.rating - a.rating || b.sales - a.sales);
    case 'sales':
      return list.sort((a, b) => b.sales - a.sales);
    default:
      return list;
  }
}

/**
 * 把**客户端目录算出的完整结果集**摆成服务端这一轮的顺序（唯一实现）。
 *
 * 为什么需要：无筛选条件的轮次（如「让我看看所有 420 件商品」）里，服务端的 12 件是
 * 「评分 → 销量」排出来的，而客户端目录是原始顺序 —— 直接拼在 12 件后面会出现
 * 「点一次加载更多，前 12 件变了 / 中间冒出新件」。对齐后才满足
 * `expanded.slice(0, 12) === searchResults`（同一份数据集、同一个顺序前缀）。
 *
 * 对齐规则与服务端 `filterProducts` 的 `sortProducts(matched, filters.sort ?? 'relevance',
 * keywords)` 逐字对应：显式排序键委派 `sortProducts`（两侧比较器一致）；`relevance` /
 * `undefined` 且**无关键词**时全部得分相同，退化为「评分 → 销量」。单测直接拿
 * `filterProducts({}, …)` 的前 12 个 id 做 parity 断言，服务端排序若变，这里会红。
 */
export function applyServerOrder(products: Product[], sort: SortKey | undefined): Product[] {
  if (sort && sort !== 'relevance') return sortProducts(products, sort);
  return products.slice().sort((a, b) => b.rating - a.rating || b.sales - a.sales);
}

/**
 * 中栏就地展开的**数据计划**（纯函数）：能追加什么、追加到几件为止。
 *
 * 两道门挡：
 * 1. 本轮必须是搜索类意图（闲聊 / 加购 / 对比 / 序数轮的 `searchTotal` 是历史值）；
 * 2. 确有「没显示出来的部分」（`searchTotal > searchResults.length`）—— 没有就不给按钮。
 *
 * 来源二选一，与服务端 `searchProducts` 的写入口径同源：
 * - 本轮有下发的命中 id（有筛选条件、命中多于展示时才下发，≤120）→ `ids` 源，
 *   上限 = id 条数；命中被 120 截断时 `truncated` 为真（展开到底要如实注明）；
 * - 无有效筛选条件（如「看看所有商品」命中 420）→ `all` 源（客户端目录全量），
 *   **420 个 id 不进 SSE**；
 * - 两者都拿不到 → `null`（**不显示按钮**，不给一个点了没反应的东西）。
 */
export interface ExpansionPlan {
  /** 追加数据的来源（直接交给 `loadBrowseProducts`） */
  source: BrowseSource;
  /** 该轮可展开到的件数上限（文案「已显示 M/N」里的 N） */
  ceiling: number;
  /** 上限是否被 `SEARCH_RESULT_ID_LIMIT` 截断（命中多于上限） */
  truncated: boolean;
}

export function expansionPlanOf(snapshot: AgentStateSnapshot | null): ExpansionPlan | null {
  if (!snapshot || !isSearchIntent(snapshot.intent)) return null;
  if (snapshot.searchResultIds.length > 0) {
    return {
      source: { kind: 'ids', ids: snapshot.searchResultIds, total: snapshot.searchTotal },
      ceiling: snapshot.searchResultIds.length,
      truncated: snapshot.searchTotal > snapshot.searchResultIds.length,
    };
  }
  if (
    !hasEffectiveFilters(snapshot.searchFilters) &&
    snapshot.searchTotal > snapshot.searchResults.length
  ) {
    return { source: { kind: 'all' }, ceiling: snapshot.searchTotal, truncated: false };
  }
  return null;
}

/**
 * 排序是否**需要先载入完整结果集**（纯函数）。
 *
 * 为什么必须有这道判断：中栏默认只渲染服务端给的前 12 件。若用户直接点「价格」就地对
 * 这 12 件排序，会给出「按价格排好了」的假象 —— 实际第 13 件起更便宜的还藏着。所以
 * 非「综合」的排序在有追加计划且完整集尚未载入时，必须先加载（复用同一条加载路径）。
 *
 * `relevance`（综合）= 服务端顺序：首屏 12 件就是完整集的前 12 件，无需加载。
 */
export function needsFullSetForSort(
  sort: SortKey,
  loaded: boolean,
  plan: ExpansionPlan | null,
): boolean {
  if (sort === 'relevance') return false;
  return plan !== null && !loaded;
}

/**
 * 浏览视图的展示窗口（纯函数）：`visible` = 用户已「加载更多」到的条数。
 *
 * 为什么分页而不是无限滚动 / 一次全画：动辄 60（品类）到 420（全量）件，
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

/**
 * 中栏**就地展开**的渲染视图（纯函数）：返回「现在该画哪几件、已显示几件、离上限还差几件」。
 *
 * - `expanded === null`（完整集未加载 / **加载失败**）→ 回落服务端给的首屏 12 件 ——
 *   这就是「失败保留、不清空」的纯逻辑，界面上再配一行「更多结果加载失败」+ 重试；
 * - 排序作用于**完整集**（调用方已用 `needsFullSetForSort` 保证加载先于排序）；
 * - `remaining` 以 `ceiling` 为分母（不是已载入条数）——它就是「加载更多」的收尾判据：
 *   为 0 时显示「已显示全部 N 件」（被 120 截断的则注明单次上限）。
 */
export function expansionViewOf(input: {
  /** 服务端本轮下发的展示集（首屏 12 件） */
  sseResults: Product[];
  /** 客户端按需解析出的完整集；未加载 / 失败为 null */
  expanded: Product[] | null;
  /** 已展开到的条数（默认 = `SEARCH_RESULT_LIMIT`） */
  visible: number;
  sort: SortKey;
  /** 该轮可得上限（`expansionPlanOf` 的 ceiling） */
  ceiling: number;
}): { products: Product[]; shown: number; remaining: number } {
  const ordered = sortProducts(input.expanded ?? input.sseResults, input.sort);
  const { shown } = browseWindow(ordered, input.visible);
  return {
    products: shown,
    shown: shown.length,
    remaining: Math.max(0, input.ceiling - shown.length),
  };
}