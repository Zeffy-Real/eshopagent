import { HumanMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { isLlmEnabled } from '@/lib/agent/llm';
import { describeFilters } from '@/lib/agent/ruleParser';
import {
  NODE_LABEL,
  type AgentStateSnapshot,
  type AgentStreamEvent,
} from '@/lib/agent/events';
import type { AgentApp } from '@/lib/agent/graph';
import type { AgentStateValue } from '@/lib/agent/state';
import { messageText } from '@/lib/agent/utils';
import type { Order, Product } from '@/lib/types';

/**
 * 把 LangGraph 的 streamEvents 事件流转成 SSE。
 *
 * 事件映射（与 events.ts 的协议一一对应）：
 *   on_chain_start   → node_start（右栏时间线新增一条「进行中」）
 *   on_chain_end     → node_end + state（右栏标记完成，中栏/右栏刷新数据）
 *   on_tool_start    → tool_start
 *   on_tool_end      → tool_end
 *   on_chat_model_stream → token（对话区打字机效果）
 *   图结束后仍有待确认订单 → interrupt（前端弹订单确认弹窗）
 */

/** 节点执行耗时（用于时间线展示「用了多久」） */
const nodeStartTimes = new Map<string, number>();

/** 唯一一个把 LLM 输出直接展示给用户的节点（其余节点的 LLM 输出是内部结构化结果） */
const REPLY_NODE = 'generateReply';

function isNodeName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(NODE_LABEL, name);
}

function chunkText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * 单轮回复最多挂几张内联卡。
 *
 * 3 是模板路径的历史取值（原实现写死 `searchResults.slice(0, 3)`）——这里抽出来是为了
 * 让 LLM 路径与模板路径共用**同一个**选取规则，顺带把「3」从魔法数字变成一个可引用的常量。
 */
export const REPLY_INLINE_LIMIT = 3;

/**
 * 「本轮该展示哪几件商品」的**唯一实现**（模板路径与 LLM 路径共用，经快照字段下发）。
 *
 * 规则：取本轮检索结果的前 `REPLY_INLINE_LIMIT` 件。
 * 只在本轮确有商品时返回非空——闲聊、加购/下单、对比轮的 `searchResults` 为空数组，
 * 因此气泡不会挂上与本轮无关的卡片。
 */
export function selectReplyProductIds(searchResults: Product[]): string[] {
  return searchResults.slice(0, REPLY_INLINE_LIMIT).map((product) => product.id);
}

/**
 * 构造前端状态快照。
 *
 * toolCallLog 只保留本轮（runStartedAt 之后）的条目：图会跨轮累积日志，
 * 前端时间线只需要当前这一轮。过滤放在服务端做——日志时间戳也是服务端生成的，
 * 同一时钟比较才可靠；用客户端的接收时刻做过滤，会因为「图跑得比首字节到达还快」
 * 而把所有条目都丢掉。
 *
 * reply 同理只取**本轮**新增的 AI 消息（runStartMessageCount 之后）：
 * generateReply 之前的节点（parseIntent / searchProducts）也会各推一次快照，
 * 那时本轮还没有 AI 消息。若退化成「整个会话里最后一条 AI 消息」，
 * 这些中间快照就会把**上一轮的回复**当成新回复推给前端，表现为
 * 「同一轮里冒出上一轮的气泡」或「两轮文本被串进同一个气泡」。
 */
export function toSnapshot(
  state: AgentStateValue,
  runStartedAt: number,
  runStartMessageCount: number,
): AgentStateSnapshot {
  let reply = '';
  for (let i = state.messages.length - 1; i >= runStartMessageCount; i -= 1) {
    const message = state.messages[i];
    if (message && message.getType() === 'ai') {
      reply = messageText(message);
      break;
    }
  }

  return {
    intent: state.intent,
    searchFilters: state.searchFilters,
    conditionText: describeFilters(state.searchFilters),
    searchResults: state.searchResults,
    // 命中总数（截断前）：中栏据此显示「共 N 件 · 展示前 M 件」
    searchTotal: state.searchTotal,
    // 本轮回复挂哪几张内联卡：由 selectReplyProductIds 统一选取（模板路径与 LLM 路径同源）
    replyProductIds: selectReplyProductIds(state.searchResults),
    // 实时覆盖随快照整体下发：前端三处渲染（卡片 / 弹窗 / 对比表）按 id 取用，
    // 与快照一样是「整体替换」，前端不需要额外 reducer
    liveOverrides: state.liveOverrides,
    liveFetchedAt: state.liveFetchedAt,
    compareTargets: state.compareTargets,
    comparison: state.comparison,
    cart: state.cart,
    toolCallLog: state.toolCallLog.filter((entry) => entry.startedAt >= runStartedAt),
    pendingOrder: state.pendingOrder,
    reply,
    profilePatch: state.profilePatch,
    profileGeneration: state.profileGeneration,
    llmEnabled: isLlmEnabled(),
  };
}

/**
 * 收尾兜底的「挂起中断」判定：**只有 `status === 'pending'` 的订单才算挂起中断**。
 *
 * 为什么单独抽成纯函数：`confirmOrder` 会把订单置为 `confirmed` 且此后不清空
 * （语义见 `lib/agent/state.ts` 的 `pendingOrder` 注释）。若这里只看「非空」，
 * 确认下单**之后每一轮**收尾都会把这条已完成订单当新中断推给前端 ——
 * 结算弹窗在「已结账」后仍会再弹（2026-09-26 实测：确认后发「你好」仍收到
 * `interrupt`，其中 `order.status` 是 confirmed）。判定可逐状态单测。
 */
export function fallbackInterruptOrder(state: AgentStateValue): Order | null {
  const order = state.pendingOrder;
  return order && order.status === 'pending' ? order : null;
}

/** 读取挂起的中断：prepareOrder 里 interrupt({ type: 'confirm_order', order }) 的值 */
function findOrderInterrupt(snapshot: {
  tasks?: { interrupts?: { value?: unknown }[] }[];
}): Order | null {
  const interrupts = (snapshot.tasks ?? []).flatMap((task) => task.interrupts ?? []);
  for (const item of interrupts) {
    const value = item.value;
    if (value && typeof value === 'object' && 'order' in value) {
      return (value as { order: Order }).order;
    }
  }
  return null;
}

export interface StreamAgentOptions {
  app: AgentApp;
  /** 图输入：新消息 / 客户端购物车快照 / 中断恢复指令（Command） */
  input: Parameters<AgentApp['streamEvents']>[0];
  config: RunnableConfig;
  sessionId: string;
}

export function createAgentEventStream(options: StreamAgentOptions): ReadableStream<Uint8Array> {
  const { app, input, config, sessionId } = options;
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: AgentStreamEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      send({ type: 'run_start', sessionId });
      // 本轮起点：用于把累积的 toolCallLog 裁剪成「本轮时间线」
      const runStartedAt = Date.now();
      // 本轮开始前的消息条数：toSnapshot 用它把「本轮回复」与历史回复区分开
      let runStartMessageCount = 0;
      try {
        const before = await app.getState(config);
        runStartMessageCount = before.values?.messages?.length ?? 0;
      } catch {
        // 首次运行时 thread 还没有 checkpoint，按 0 处理
      }

      try {
        const eventStream = app.streamEvents(input, { version: 'v2', ...config });

        for await (const event of eventStream) {
          const name = typeof event.name === 'string' ? event.name : '';

          switch (event.event) {
            case 'on_chain_start': {
              if (!isNodeName(name)) break;
              nodeStartTimes.set(name, Date.now());
              send({
                type: 'node_start',
                node: name,
                label: NODE_LABEL[name] ?? name,
                at: Date.now(),
              });
              break;
            }

            case 'on_chain_end': {
              if (!isNodeName(name)) break;
              const startedAt = nodeStartTimes.get(name) ?? Date.now();
              send({
                type: 'node_end',
                node: name,
                label: NODE_LABEL[name] ?? name,
                at: Date.now(),
                durationMs: Date.now() - startedAt,
              });

              // 节点结束后推送一次完整状态：中栏商品区 / 右栏面板据此刷新
              const snapshot = await app.getState(config);
              if (snapshot.values) {
                send({
                  type: 'state',
                  payload: toSnapshot(
                    snapshot.values as AgentStateValue,
                    runStartedAt,
                    runStartMessageCount,
                  ),
                });
              }
              break;
            }

            case 'on_tool_start': {
              const toolInput = event.data?.input as { title?: string } | undefined;
              send({
                type: 'tool_start',
                tool: name,
                title: toolInput?.title ?? name,
              });
              break;
            }

            case 'on_tool_end': {
              send({ type: 'tool_end', tool: name, title: name });
              break;
            }

            case 'on_chat_model_stream': {
              // 只有 generateReply 的流式输出是「给用户看的回复」。
              // parseIntent / manageCart 也调用 LLM，但它们输出的是结构化 JSON，
              // 属于内部中间结果：不过滤就会把 {"intent":"search",...} 这类
              // 原始 JSON 当成聊天气泡逐字打出来（实测会在对话区留下调试文本）。
              const node =
                typeof event.metadata?.langgraph_node === 'string'
                  ? event.metadata.langgraph_node
                  : '';
              if (node !== REPLY_NODE) break;

              const chunk = event.data?.chunk as { content?: unknown } | undefined;
              const content = chunkText(chunk?.content);
              if (content) send({ type: 'token', content });
              break;
            }

            default:
              break;
          }
        }

        // 收尾：检测中断，并**无条件**补推一次终态。
        //
        // 为什么不能沿用「仅在没推过时才推」：node_end 事件触发时节点刚结束，
        // 此时 app.getState() 读到的可能还是**提交前**的状态 —— 实测
        // generateReply 的 node_end 快照里 reply 恒为空（AIMessage 还没落进 state），
        // 而 reply 是「模板回复」路径唯一的来源（该路径没有 token 事件）：
        // 一旦 LLM 不可用，回复气泡就完全不会出现，直接打穿「无 Key 也能跑」这条卖点。
        // 收尾时图已彻底结束，这一份状态必然完整；前端 applySnapshot 对同一份状态幂等。
        const finalState = await app.getState(config);
        const values = finalState.values as AgentStateValue | undefined;
        const interruptOrder = findOrderInterrupt(finalState);
        if (interruptOrder) {
          send({ type: 'interrupt', order: interruptOrder });
        } else if (values) {
          // 兜底只认 pending（见 fallbackInterruptOrder 的注释）：
          // confirmed 的订单是「已完成的事实」，不是「挂起的中断」
          const fallback = fallbackInterruptOrder(values);
          if (fallback) send({ type: 'interrupt', order: fallback });
        }
        if (values) {
          send({
            type: 'state',
            payload: toSnapshot(values, runStartedAt, runStartMessageCount),
          });
        }
      } catch (error) {
        send({
          type: 'error',
          message: error instanceof Error ? error.message : 'Agent 执行失败，请重试',
        });
      } finally {
        send({ type: 'done' });
        closed = true;
        controller.close();
      }
    },
  });
}

export function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/** 把文本 + 可选图片组装成用户消息（多模态：支持以图搜商品） */
export function buildUserMessage(text: string, imageDataUrl?: string): HumanMessage {
  if (!imageDataUrl) return new HumanMessage(text);
  return new HumanMessage({
    content: [
      { type: 'text', text: text || '请识别这张图片里的商品，帮我找同款或相似商品。' },
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ],
  });
}
