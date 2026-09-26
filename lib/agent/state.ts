import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type { ProfileSignal } from '@/lib/profile';
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
 * liveOverrides 的合并规则（导出即为了单测能直接钉住它）。
 *
 * 合并型而不是覆盖型：多轮追问会分别覆盖不同商品（第一轮盖了 A，第二轮盖 B），
 * 覆盖型会让 A 的实时价在第二轮被整体清掉，界面上的「实时」标注随之消失——
 * 而那个价格确实来自真实查询，没有理由丢弃。
 */
export function mergeLiveOverrides(
  previous: Record<string, Product>,
  next: Record<string, Product>,
): Record<string, Product> {
  return { ...previous, ...next };
}

/**
 * searchFilters 的合并规则（导出即为了单测能直接钉住它，与 mergeLiveOverrides 同理）。
 *
 * 浅合并 + **显式 undefined 会覆盖旧值**：重置（切换浏览目标）依赖后半句 ——
 * `parseIntent` 把不再适用的字段显式置为 undefined，这里就会把旧值覆盖掉；
 * 反过来，**未提到的字段会被上一轮的值留着**，所以「保留还是清掉」必须在
 * `parseIntent` 里显式表达（继承与重置的唯一判定点，见 nodes/parseIntent.ts）。
 */
export function mergeSearchFilters(
  previous: SearchFilters,
  next: SearchFilters,
): SearchFilters {
  return { ...previous, ...next };
}

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

  /**
   * 搜索筛选条件（浅合并：`{...prev, ...next}`，显式 undefined 会覆盖旧值）。
   *
   * 合并 / 重置的**判定**不在这里，而在 parseIntent（继承 vs 切换浏览目标）——
   * reducer 只做机械合并；「显式 undefined 清掉旧值」是重置能生效的机制保证，
   * 由 mergeSearchFilters 的单测直接钉住。
   */
  searchFilters: Annotation<SearchFilters>({
    reducer: mergeSearchFilters,
    default: () => ({}),
  }),

  /** 本轮搜索结果 */
  searchResults: Annotation<Product[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),

  /**
   * 本轮检索**命中的总件数**（截断前）；`searchResults` 是实际展示的前 N 件。
   *
   * 用途只有一个：让中栏能说清「共 N 件 · 展示前 M 件」。覆盖型 —— refine 重新检索后
   * 必须跟着更新（否则界面会拿旧命中数配新结果），清空结果时也回到 0。
   */
  searchTotal: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 0,
  }),

  /**
   * 实时数据覆盖（键 = 商品 id，值 = 覆盖后的商品）。由 enrichLiveData 写入。
   *
   * 为什么**不写进 searchResults**：那样就再也说不清哪个价格来自快照、哪个来自实时查询。
   * 独立字段让「数据来源可追溯」成为结构上的事实（界面可标注「实时 · 14:32」），
   * 而不是靠约定。
   * reducer 是**合并型**：多轮追问会分别覆盖不同商品，早期覆盖不该被本轮清掉。
   */
  liveOverrides: Annotation<Record<string, Product>>({
    reducer: mergeLiveOverrides,
    default: () => ({}),
  }),

  /**
   * 上次实时拉取的时刻（毫秒）。条件边用它做 60 秒冷却，避免同一 thread 反复烧配额。
   * 覆盖型：每轮以最新一次为准。
   */
  liveFetchedAt: Annotation<number | null>({
    reducer: (_previous, next) => next,
    default: () => null,
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

  /**
   * **最近一次的订单状态**（不是「待处理订单」）：
   * - `prepareOrder` 在 `interrupt()` **恢复之后**写入草稿（`status: 'pending'`）；
   * - `confirmOrder` 把它置为 `'confirmed'`（订单号不变），此后**不再清空**——
   *   前端据此展示「下单成功」与订单历史；
   * - 语义边界：**只有 `status === 'pending'` 才代表「有挂起中断」**。
   *
   * 2026-09-26 修过一个由这层语义模糊引发的 bug：SSE 收尾兜底把「`pendingOrder` 非空」
   * 误读成「有挂起中断」，于是确认下单**之后每一轮**都会把这条已完成订单当新中断推给前端，
   * 结算弹窗复发（修法见 `lib/agent/sse.ts` 的 `fallbackInterruptOrder`）。
   */
  pendingOrder: Annotation<Order | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),

  /**
   * 序数指代的目标商品 id（「换成第二件」里的「第二件」）。
   *
   * 生命周期与 profilePatch 同思路 —— 由每轮的第一个节点界定边界：
   * - `parseIntent` 每轮都会写这个字段（解析不出序数时写 null），因此上一轮的
   *   残留不会影响本轮；
   * - `searchProducts` 看到它时把结果收窄为这一件，并写回 null 消费掉，
   *   这样同一轮里后续的 refine 轮次会回到正常检索，而不是一直卡在单件。
   */
  focusProductId: Annotation<string | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),

  /**
   * 本轮画像信号（前端幂等合并进本地画像，见 lib/profile.ts）。
   *
   * 生命周期与 focusProductId 同思路 —— 由每轮的第一个节点界定边界：
   * - reducer 是**覆盖型**（不是 concat），否则同一会话跑 N 轮会堆 N 组重复信号；
   * - `parseIntent` 每轮都写 `[]`，等于在本轮开头清空上一轮的 patch；
   * - 后续节点（searchProducts / manageCart / confirmOrder）读当前值再追加，
   *   因此同一轮内多个节点的信号会累积；
   * - interrupt 恢复轮（resume）不经过 parseIntent，会把上一轮的 patch 再带一遍，
   *   所以**前端合并必须幂等**（mergeProfile 对完全相同的 patch 返回同一引用）。
   */
  profilePatch: Annotation<ProfileSignal[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),

  /**
   * 客户端画像的 generation（每次「清除画像」自增）。
   *
   * 服务端**不持有画像**：这个数字只是把客户端随请求上行的值原样回显到快照里，
   * 前端据此丢弃「清除之前发出的」在途 patch。由路由作为图输入写入（每轮覆盖）。
   */
  profileGeneration: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 0,
  }),

  /**
   * 本轮要不要在回复里带一句画像提示（例如「注意到你之前常看图书…」）。
   *
   * 由 parseIntent 判定并写入（不适用时写空串），generateReply 只负责渲染 ——
   * 「什么时候该提偏好」只有一处实现。规则路径把它补在模板回复末尾，
   * LLM 路径把它作为「结尾自然带出一句」的指令写进上下文。
   */
  profileHint: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => '',
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
