import type { AgentIntent } from '@/lib/types';

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