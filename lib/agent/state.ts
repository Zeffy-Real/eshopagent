import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
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
 * Agent 全局状态（StateGraph 所有节点共享读写）。
 *
 * 设计要点：
 * 1. 每个字段通过 Annotation 声明 reducer，决定并发/多次写入时如何合并：
 *    - messages / toolCallLog 是「追加型」，用 concat 语义，多次写入不覆盖；
 *    - 其余字段是「覆盖型」，后写入的值生效。
 * 2. messages 使用官方 messagesStateReducer 而非裸 concat：
 *    它会按 message.id 去重，并支持 RemoveMessage 做上下文裁剪。
 * 3. needsRefine 是图结构中 searchProducts → refineSearch 条件边的判定依据。
 */
export const AgentState = Annotation.Root({
  /** 对话历史（追加型） */
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  /** 当前意图：search | refine | compare | cart | checkout | chat */
  intent: Annotation<AgentIntent>({
    reducer: (_previous, next) => next,
    default: () => 'chat',
  }),

  /** 搜索筛选条件（浅合并，支持 refine 只更新变化的部分） */
  searchFilters: Annotation<SearchFilters>({
    reducer: (previous, next) => ({ ...previous, ...next }),
    default: () => ({}),
  }),

  /** 本轮搜索结果 */
  searchResults: Annotation<Product[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),

  /** 待对比商品（2 - 4 件） */
  compareTargets: Annotation<Product[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),

  /** 对比结果（差异表 + 各维度最优 + 性价比得分），右栏对比面板数据源 */
  comparison: Annotation<ComparisonResult | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),

  /** 购物车 */
  cart: Annotation<CartItem[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),

  /** 推理时间线（追加型，右栏可视化面板数据源） */
  toolCallLog: Annotation<ToolLogEntry[]>({
    reducer: (previous, next) => previous.concat(next),
    default: () => [],
  }),

  /** 待确认订单（prepareOrder 写入草稿，interrupt 暂停，confirmOrder 落单） */
  pendingOrder: Annotation<Order | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),

  /** 是否需要在搜索后回到 refineSearch 继续细化条件 */
  needsRefine: Annotation<boolean>({
    reducer: (_previous, next) => next,
    default: () => false,
  }),

  /**
   * 已细化轮次。
   * searchProducts ⇄ refineSearch 是图中唯一的环，没有这个计数器时
   * 「检索为空 → 放宽条件 → 仍为空」会无限循环（LangGraph 默认递归上限
   * 只会抛 GraphRecursionError）。超过 MAX_REFINE_ROUNDS 后强制收敛。
   */
  refineCount: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 0,
  }),
});

/** 允许的最大自动细化轮次 */
export const MAX_REFINE_ROUNDS = 2;

/** 节点内读取的完整状态类型 */
export type AgentStateValue = typeof AgentState.State;

/** 节点返回的状态增量类型（只需返回要更新的字段） */
export type AgentStateUpdate = typeof AgentState.Update;
