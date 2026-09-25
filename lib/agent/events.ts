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

/** 服务端状态快照：前端各面板的唯一数据来源 */
export interface AgentStateSnapshot {
  intent: AgentIntent;
  searchFilters: SearchFilters;
  /** 筛选条件的中文描述（服务端渲染，避免把解析器打进客户端包） */
  conditionText: string;
  searchResults: Product[];
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
