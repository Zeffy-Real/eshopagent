import type { ProfileSignal, UserProfile } from '@/lib/profile';
import type {
  AgentIntent,
  CartItem,
  ComparisonResult,
  Order,
  Product,
  SearchFilters,
  ToolLogEntry,
} from '@/lib/types';

/**
 * Agent 流式事件协议（前后端共用）。
 *
 * 注意：本文件只包含类型与纯常量，禁止引入任何服务端模块
 * （LangGraph / state / mock 数据），否则会被打进客户端 bundle。
 */

export const NODE_LABEL: Record<string, string> = {
  parseIntent: '解析意图',
  searchProducts: '检索商品',
  refineSearch: '细化条件',
  enrichLiveData: '补充实时数据',
  compareProducts: '对比商品',
  manageCart: '管理购物车',
  prepareOrder: '准备订单',
  confirmOrder: '确认订单',
  generateReply: '生成回复',
};

export const NODE_ORDER: string[] = [
  'parseIntent',
  'searchProducts',
  'refineSearch',
  'enrichLiveData',
  'compareProducts',
  'manageCart',
  'prepareOrder',
  'confirmOrder',
  'generateReply',
];

/**
 * 单轮检索**最多展示**的商品数。
 *
 * 为什么放在这个前后端共用模块（而不是 `nodes/searchProducts.ts`）：服务端节点用它截取
 * 结果，客户端也要用它解释「共 N 件 · 展示前 M 件」与「数据快照」面板里的展示上限 ——
 * 两边读同一个常量，UI 文案才不会与真实截取数量漂移（客户端不能 import 服务端节点模块）。
 */
export const SEARCH_RESULT_LIMIT = 12;

/**
 * 单轮下发的**命中 id 列表**上限（「查看全部 N 件」入口的数据）。
 *
 * 为什么是 120：实测目录 id 平均 15.9 字 → 120 个约 2.2 KB/帧（每轮 5 个状态帧，
 * 合计约 +11 KB），落在「≤4 KB/帧」的载荷预算内；再往上收益很小（筛选命中极少超过 120 件）。
 * 超过上限时浏览视图显示前 120 件并注明，**无筛选条件的大集合不走这里**
 * （前端读 `hasEffectiveFilters` → 无筛选直接由客户端目录现算，420 个 id 不进 SSE）。
 */
export const SEARCH_RESULT_ID_LIMIT = 120;

/**
 * 服务端状态快照：前端各面板的唯一数据来源。
 *
 * ⚠️ **新增字段时必须同时在 `normalizeSnapshot` 里补默认值** —— 这个对象会随 store
 * 持久化进 localStorage，**旧版本写下的快照不会带新字段**；恢复期的形状归一化只有那一处。
 */
export interface AgentStateSnapshot {
  intent: AgentIntent;
  searchFilters: SearchFilters;
  /** 筛选条件的中文描述（服务端渲染，避免把解析器打进客户端包） */
  conditionText: string;
  searchResults: Product[];
  /**
   * 本轮检索**命中的总件数**（截断前）；实际展示条数是 `searchResults.length`。
   *
   * 为什么需要：中栏要能说清「共 N 件 · 展示前 M 件」（单次最多展示
   * `SEARCH_RESULT_LIMIT` 件），否则用户会把展示条数当成命中数。
   * 覆盖型：refine 重新检索后必须跟着更新，不能是历史值。
   */
  searchTotal: number;
  /**
   * 本轮命中商品的前 `SEARCH_RESULT_ID_LIMIT` 个 id（**只读展示字段**，同类于 `searchTotal`）。
   *
   * 唯一用途：中栏「查看全部 N 件」入口 —— 有筛选条件时客户端拿它按 id 打开浏览视图
   * （无筛选条件时走客户端目录全量，这里为空）。只在 search / refine 轮下发，
   * 闲聊 / 加购 / 对比 / 结算轮一律为空（`toSnapshot` 按意图门挡）。
   * 不装完整对象：120 件商品的完整对象约 130 KB，装不下也不该装。
   */
  searchResultIds: string[];
  /**
   * 实时数据覆盖（键 = 商品 id）。**不写进 searchResults**：这样才始终说得清
   * 「哪个价格来自快照、哪个来自实时查询」。渲染时按 id 查覆盖值，查不到就用原值
   * （统一走 `lib/justoneapi/overrides.ts` 的 `applyLiveOverride`）。
   */
  liveOverrides: Record<string, Product>;
  /** 上次实时拉取的时刻（毫秒）；前端「实时 · HH:mm」标注与冷却判定都用它 */
  liveFetchedAt: number | null;
  compareTargets: Product[];
  /** 对比结果（差异表 + 各维度最优），无对比时为 null */
  comparison: ComparisonResult | null;
  cart: CartItem[];
  toolCallLog: ToolLogEntry[];
  pendingOrder: Order | null;
  /** 最新一条 Agent 回复（Markdown） */
  reply: string;
  /**
   * 本轮回复该挂的内联卡商品 id（「这一轮在聊哪几件」）。
   *
   * 选取规则在 `lib/agent/sse.ts` 的 `selectReplyProductIds`（**唯一实现**）：
   * 模板路径（无 token 的兜底回复）与 LLM 流式路径都读这个字段，不各算一套。
   * 只在本轮确有检索结果时非空——闲聊 / 加购下单 / 对比轮为空数组，气泡不挂无关卡片。
   */
  replyProductIds: string[];
  /** 本轮画像信号（前端幂等合并进本地画像；每轮由 parseIntent 重置） */
  profilePatch: ProfileSignal[];
  /** 客户端画像 generation 的原样回显：前端据此丢弃「清除画像」之前发出的在途 patch */
  profileGeneration: number;
  /** 服务端是否已配置 LLM（决定前端是否展示兜底提示） */
  llmEnabled: boolean;
}

/**
 * 快照的**形状归一化**（恢复持久化状态时调用；纯函数，唯一入口）。
 *
 * 为什么需要：`snapshot` 会随 store 持久化进 localStorage，而持久化数据可能来自**旧版本**
 * —— `AgentStateSnapshot` 的字段是逐步长出来的（`searchResultIds` / `searchTotal` /
 * `replyProductIds` / `profilePatch` …），旧快照不会带新字段。zustand 的 rehydrate 是
 * 浅合并、没有任何形状校验，实测（2026-09-26）：
 *   ① 删掉 `searchResultIds` 再刷新 → `product-panel.tsx` 的 `snapshot.searchResultIds.length`
 *      抛错，**整页白屏**（Application error）；
 *   ② 只删 `searchTotal` 更隐蔽 —— 不崩，但中栏退化成「12 件商品」、入口写成「查看全部  件」。
 * 修复只在这一处做，不让每个消费者各写一份 `?.` / `??`。
 *
 * 约定：`raw` 不是普通对象 / 为 null → 返回 `null`（视为「没有快照」，与初始状态一致）。
 * 已有字段**原样保留、不做语义重解释**；缺失字段按下述默认值补齐 —— 每条的理由：
 *
 * - `intent: 'chat'`：最保守的意图（不假装在搜索；中栏回落「为你推荐」）；
 * - `searchFilters: {}`：无条件 —— `hasEffectiveFilters({})` 为 false，「查看全部」走
 *   客户端目录而不是去读一组不存在的 id；
 * - `conditionText: ''`：不显示条件（比编一段条件描述安全）；
 * - `searchResults / compareTargets / cart / toolCallLog / profilePatch: []`：空集合。
 *   时间线本来就不持久化（§8-35），空数组与恢复后的实际表现一致；快照里的 `cart` 只在
 *   服务端下发时同步展示，空数组不会清掉本地购物车；本轮画像信号已合并进 `userProfile`；
 * - `searchTotal`: **取 `searchResults.length`**（而不是 0）—— 命中数不应小于已展示数，
 *   避免「共 0 件 · 展示前 12 件」这种自相矛盾的文案；
 * - `searchResultIds / replyProductIds: []`：缺省即「本轮没有可跳转的列表 / 不挂内联卡」，
 *   入口不出现 —— 比猜一组 id 安全；
 * - `liveOverrides: {}`、`liveFetchedAt: null`：没有实时覆盖；
 * - `comparison: null`、`pendingOrder: null`：没有对比结果；**刷新后不存在挂起中断**
 *   （与「确认下单后刷新不重播弹窗」的既有语义一致）；
 * - `reply: ''`：本轮回复文本对恢复后的界面无用（气泡文本已在 `messages` 里）；
 * - `profileGeneration: 0`：最旧的一代 → 任何在途 patch 都会被丢弃（「清除画像」后
 *   丢弃旧 patch 是既定行为，这里只是把「未知」当成最保守的一侧）；
 * - `llmEnabled: true`：不显示「规则兜底」徽标（宁可少说，不在没依据时声称走的是
 *   规则路径）；下一轮服务端快照会给出真实值。
 *
 * 数组字段额外挡一层类型：localStorage 是不可信边界，`'字符串'` / `{...}` 这类形状
 * 会被下游的 `.map` / `.length` 用坏（本次崩溃正是「不是数组」的一类）。
 */
export function normalizeSnapshot(raw: unknown): AgentStateSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const arrayOf = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  const searchResults = arrayOf<Product>(source.searchResults);

  return {
    intent: (source.intent as AgentIntent | undefined) ?? 'chat',
    searchFilters: (source.searchFilters as SearchFilters | undefined) ?? {},
    conditionText: typeof source.conditionText === 'string' ? source.conditionText : '',
    searchResults,
    searchTotal:
      typeof source.searchTotal === 'number' ? source.searchTotal : searchResults.length,
    searchResultIds: arrayOf<string>(source.searchResultIds),
    replyProductIds: arrayOf<string>(source.replyProductIds),
    liveOverrides: (source.liveOverrides as Record<string, Product> | undefined) ?? {},
    liveFetchedAt: typeof source.liveFetchedAt === 'number' ? source.liveFetchedAt : null,
    compareTargets: arrayOf<Product>(source.compareTargets),
    comparison: (source.comparison as ComparisonResult | null | undefined) ?? null,
    cart: arrayOf<CartItem>(source.cart),
    toolCallLog: arrayOf<ToolLogEntry>(source.toolCallLog),
    pendingOrder: (source.pendingOrder as Order | null | undefined) ?? null,
    reply: typeof source.reply === 'string' ? source.reply : '',
    profilePatch: arrayOf<ProfileSignal>(source.profilePatch),
    profileGeneration:
      typeof source.profileGeneration === 'number' ? source.profileGeneration : 0,
    llmEnabled: typeof source.llmEnabled === 'boolean' ? source.llmEnabled : true,
  };
}

export type AgentStreamEvent =
  | { type: 'run_start'; sessionId: string }
  | { type: 'node_start'; node: string; label: string; at: number }
  | { type: 'node_end'; node: string; label: string; at: number; durationMs: number }
  | { type: 'tool_start'; tool: string; title: string }
  | { type: 'tool_end'; tool: string; title: string; detail?: string }
  | { type: 'token'; content: string }
  | { type: 'state'; payload: AgentStateSnapshot }
  | { type: 'interrupt'; order: Order }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface AgentRequestBody {
  sessionId: string;
  message: string;
  /** 客户端购物车快照（商品 id + 数量），服务端解析为实体 */
  cart?: { productId: string; quantity: number }[];
  /** 客户端勾选的待对比商品（商品区多选后发起对比） */
  compareProductIds?: string[];
  /** 以图搜商品：data URL（需配置支持视觉的模型） */
  imageDataUrl?: string;
  /**
   * 客户端画像（localStorage 里的那份，服务端不持有）。
   * 作为一次性上下文注入 prompt，用完即弃，不写服务端存储。
   */
  profile?: UserProfile;
  /** 画像 generation：服务端原样回显，前端用它丢弃过期 patch */
  profileGeneration?: number;
}

export interface AgentResumeBody {
  sessionId: string;
  /** 订单确认结果 */
  decision: 'confirm' | 'cancel';
  /** 画像 generation（resume 轮的成交信号同样要能被前端接受） */
  profileGeneration?: number;
}
