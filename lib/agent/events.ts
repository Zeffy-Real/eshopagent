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
  compareTargets: Product[];
  /** 对比结果（差异表 + 各维度最优），无对比时为 null */
  comparison: ComparisonResult | null;
  cart: CartItem[];
  toolCallLog: ToolLogEntry[];
  pendingOrder: Order | null;
  /** 最新一条 Agent 回复（Markdown） */
  reply: string;
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
}

export interface AgentResumeBody {
  sessionId: string;
  /** 订单确认结果 */
  decision: 'confirm' | 'cancel';
}
