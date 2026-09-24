'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AgentStateSnapshot, AgentStreamEvent } from '@/lib/agent/events';
import type { Order, ToolLogEntry } from '@/lib/types';
import { resumeAgent, streamAgent } from '@/lib/agent-client';
import { useCartStore } from '@/store/use-cart-store';
import { useUiStore } from '@/store/use-ui-store';

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  /** 用户上传的参考图（以图搜商品） */
  imageUrl?: string;
  createdAt: number;
  /** 是否正在逐字输出 */
  streaming?: boolean;
  /** 该条回复关联的商品（对话区内联卡片） */
  productIds?: string[];
}

export interface SendOptions {
  imageDataUrl?: string;
  /** 商品区勾选的待对比商品 */
  compareProductIds?: string[];
}

interface AgentState {
  sessionId: string;
  messages: ChatMessage[];
  /** Agent 正在执行（思考中…） */
  thinking: boolean;
  /** 本轮进行中的节点名 */
  activeNodes: string[];
  /** 当前轮推理时间线（已按 runStartedAt 过滤） */
  timeline: ToolLogEntry[];
  snapshot: AgentStateSnapshot | null;
  /** 待确认订单（interrupt 挂起时） */
  interruptedOrder: Order | null;
  /** 正在提交订单确认（resume 中） */
  resuming: boolean;
  error: string | null;
  llmEnabled: boolean;
  /**
   * 持久化状态是否已恢复。
   *
   * 为什么需要：初始 state 会先 `createSessionId()` 生成一个新 id，而 `rehydrate()`
   * 是挂载后异步执行的。用户在恢复完成前发消息，请求会带着**新 id** 出去，
   * 等于开了一个新 thread（表现为「刚聊过的内容突然不记得了」）。
   */
  hasHydrated: boolean;
  /** 手动触发持久化恢复；恢复失败也要放行，否则门闸永远关着、用户发不出消息 */
  hydrate: () => Promise<void>;
  sendMessage: (text: string, options?: SendOptions) => Promise<void>;
  /** 商品区「发起对比」：把勾选结果作为图输入提交 */
  compareSelection: () => Promise<void>;
  resumeOrder: (decision: 'confirm' | 'cancel') => Promise<void>;
  /** 清空当前会话的消息，**不换** sessionId（沿用同一个 thread） */
  clearConversation: () => void;
  /** 开新会话：清空消息并轮换 sessionId（换一个 thread） */
  startNewSession: () => void;
  dismissError: () => void;
  dismissInterrupt: () => void;
}

/* 打字机：把回复按固定速率揭示，LLM 真实 token 与模板回复共用同一动画 */
const TYPE_INTERVAL_MS = 20;
const TYPE_CHARS_PER_TICK = 12;

/** 页面不可见时不逐字揭示（后台标签页会被浏览器降频到 1 次/秒，动画会看起来卡死） */
function shouldAnimate(): boolean {
  return typeof document !== 'undefined' && !document.hidden;
}

let typeTimer: ReturnType<typeof setInterval> | null = null;
let pendingText = '';

/**
 * 本轮回复气泡的 id。
 *
 * 为什么需要这个显式标记：LLM 的 token 是**分批**到达的，而打字机以固定速率消费缓冲，
 * 缓冲被消费完时下一批 token 往往还没到。若用「最后一条消息是否 streaming」来判断
 * 「要不要新建气泡」，缓冲一空气泡就被标记为结束，下一批 token 到达时又新建一个，
 * 一条回复会被拆成好几个堆叠气泡（实测 3 - 5 个，内容还互相重叠）。
 * 所以这里以「本轮回复气泡 id」为唯一依据，直到本轮真正结束才收尾。
 */
let activeReplyId: string | null = null;
/** 本轮是否已结束（收到 done / interrupt）：决定打字机消费完缓冲后要不要收尾 */
let runFinished = false;

function stopTypewriter(): void {
  if (typeTimer) {
    clearInterval(typeTimer);
    typeTimer = null;
  }
  pendingText = '';
}

/** 本轮回复收尾：把气泡标记为输出完成，并清空本轮标记 */
function finalizeReply(
  set: (partial: Partial<AgentState>) => void,
  get: () => AgentState,
): void {
  const id = activeReplyId;
  activeReplyId = null;
  if (!id) return;
  set({
    messages: get().messages.map((message) =>
      message.id === id ? { ...message, streaming: false } : message,
    ),
  });
}

function startTypewriter(
  messageId: string,
  set: (partial: Partial<AgentState>) => void,
  get: () => AgentState,
): void {
  if (typeTimer) return;
  typeTimer = setInterval(() => {
    if (!pendingText) {
      // 缓冲已消费完。本轮若已结束就收尾；否则只停掉定时器，
      // 保持气泡 streaming（下一批 token 到达时会重启定时器）
      stopTypewriter();
      if (runFinished) finalizeReply(set, get);
      return;
    }
    const step = pendingText.slice(0, TYPE_CHARS_PER_TICK);
    pendingText = pendingText.slice(TYPE_CHARS_PER_TICK);
    set({
      messages: get().messages.map((message) =>
        message.id === messageId
          ? { ...message, content: message.content + step, streaming: true }
          : message,
      ),
    });
  }, TYPE_INTERVAL_MS);
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSessionId(): string {
  return createId('s');
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
      sessionId: createSessionId(),
      messages: [],
      thinking: false,
      activeNodes: [],
      timeline: [],
      snapshot: null,
      interruptedOrder: null,
      resuming: false,
      error: null,
      llmEnabled: true,
      hasHydrated: false,

      async hydrate() {
        if (get().hasHydrated) return;
        try {
          await useAgentStore.persist.rehydrate();
        } catch (error) {
          // localStorage 被禁用或数据损坏时不能让门闸永远关着，否则用户永远发不出消息。
          // 无条件放行：宁可丢掉历史会话，也不能让功能不可用。
          console.error('[agent-store] 恢复持久化状态失败，按空状态继续：', error);
        } finally {
          set({ hasHydrated: true });
        }
      },

      async sendMessage(text, options) {
        const trimmed = text.trim();
        const imageDataUrl = options?.imageDataUrl;
        if (!trimmed && !imageDataUrl) return;
        // 持久化还没恢复完就发消息，会带着刚生成的新 sessionId 出去（等于开新 thread）。
        // 这里等它恢复完再继续，而不是静默丢弃这次发送。
        if (!get().hasHydrated) await get().hydrate();
        // 同一个 thread_id 上并发跑两个图会让 checkpoint 互相覆盖，这里硬性串行化
        if (get().thinking) return;

        stopTypewriter();
        // 上一轮若因异常没来得及收尾，先把它标记为完成，避免气泡光标一直闪
        runFinished = true;
        finalizeReply(set, get);
        const userMessage: ChatMessage = {
          id: createId('u'),
          role: 'user',
          content: trimmed || '（图片）',
          imageUrl: imageDataUrl,
          createdAt: Date.now(),
        };

        set({
          messages: [...get().messages, userMessage],
          thinking: true,
          error: null,
          activeNodes: [],
          timeline: [],
        });

        const cart = useCartStore
          .getState()
          .items.map((item) => ({
            productId: item.product.id,
            quantity: item.quantity,
          }));

        try {
          await streamAgent(
            {
              sessionId: get().sessionId,
              message: trimmed,
              cart,
              imageDataUrl,
              compareProductIds: options?.compareProductIds,
            },
            { onEvent: (event) => handleEvent(event, set, get) },
          );
        } catch (error) {
          stopTypewriter();
          set({
            thinking: false,
            activeNodes: [],
            error: error instanceof Error ? error.message : '发送失败，请重试',
          });
        }
      },

      async compareSelection() {
        const { compareIds, clearCompare } = useUiStore.getState();
        // 先判断能否发送，再清空选择：否则被串行化拦截时会白白丢掉用户的勾选
        if (compareIds.length < 2 || get().thinking) return;
        clearCompare();
        await get().sendMessage('帮我对比这几件商品', { compareProductIds: compareIds });
      },

      async resumeOrder(decision) {
        stopTypewriter();
        // 保留 interruptedOrder：弹窗需要在 resume 期间继续展示订单明细
        set({ thinking: true, error: null, timeline: [], resuming: true });
        try {
          await resumeAgent(
            { sessionId: get().sessionId, decision },
            { onEvent: (event) => handleEvent(event, set, get) },
          );
        } catch (error) {
          stopTypewriter();
          set({
            thinking: false,
            error: error instanceof Error ? error.message : '订单确认失败，请重试',
          });
        } finally {
          set({ resuming: false, interruptedOrder: null });
        }
      },

      clearConversation() {
        stopTypewriter();
        activeReplyId = null;
        runFinished = true;
        // 只清消息，**不换** sessionId：这是「清空对话」而不是「新会话」。
        // 换 thread 会让服务端那份图状态（筛选条件/购物车/对比结果）一并作废，
        // 那是另一个动作，见 startNewSession()。
        set({
          messages: [],
          timeline: [],
          activeNodes: [],
          snapshot: null,
          interruptedOrder: null,
          error: null,
          thinking: false,
        });
      },

      startNewSession() {
        stopTypewriter();
        activeReplyId = null;
        runFinished = true;
        set({
          messages: [],
          timeline: [],
          activeNodes: [],
          snapshot: null,
          interruptedOrder: null,
          error: null,
          thinking: false,
          // 轮换 sessionId = 换一个 thread，服务端从空状态重新开始
          sessionId: createSessionId(),
        });
      },

      dismissError() {
        set({ error: null });
      },

      dismissInterrupt() {
        set({ interruptedOrder: null });
      },
    }),
    {
      name: 'eshop-agent',
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: (state) => ({
        sessionId: state.sessionId,
        // 只持久化最近若干条：localStorage 有配额，长会话全量写入会写爆
        messages: state.messages
          .slice(-40)
          .map((message) => ({ ...message, streaming: false })),
        snapshot: state.snapshot,
      }),
    },
  ),
);

/** 事件分发：一处集中处理，组件只读 store */
function handleEvent(
  event: AgentStreamEvent,
  set: (partial: Partial<AgentState>) => void,
  get: () => AgentState,
): void {
  switch (event.type) {
    case 'run_start': {
      // 本轮开始：重置本轮回复标记，时间线等首个 state 事件覆盖
      activeReplyId = null;
      runFinished = false;
      set({ activeNodes: [] });
      break;
    }

    case 'node_start': {
      set({ activeNodes: [...get().activeNodes, event.node] });
      break;
    }

    case 'node_end': {
      set({ activeNodes: get().activeNodes.filter((node) => node !== event.node) });
      break;
    }

    case 'token': {
      // LLM 真实 token：先落到缓冲，再由打字机匀速揭示
      const messages = get().messages;
      const animate = shouldAnimate();
      // 只有本轮的第一条 token 需要新建气泡；之后的 token 一律并入同一个气泡。
      // 判断依据是 activeReplyId 而不是「最后一条是否 streaming」——后者会被
      // token 分批到达切成多个气泡（见 activeReplyId 的注释）
      const isFirstToken = activeReplyId === null;
      const replyId = activeReplyId ?? createId('a');
      activeReplyId = replyId;

      if (isFirstToken) {
        set({
          messages: [
            ...messages,
            {
              id: replyId,
              role: 'agent',
              content: animate ? '' : event.content,
              createdAt: Date.now(),
              streaming: true,
            },
          ],
        });
        if (animate) pendingText = event.content;
      } else if (animate) {
        pendingText += event.content;
      } else {
        set({
          messages: messages.map((message) =>
            message.id === replyId
              ? { ...message, content: message.content + event.content }
              : message,
          ),
        });
      }

      // 缓冲可能已被消费完（定时器已停），这里负责重启
      if (animate) startTypewriter(replyId, set, get);
      break;
    }

    case 'state': {
      applySnapshot(event.payload, set, get);
      break;
    }

    case 'interrupt': {
      // 图已暂停等待人工确认，没有正在执行的节点；本轮回复也到此为止
      runFinished = true;
      set({ interruptedOrder: event.order, activeNodes: [], thinking: false });
      if (!typeTimer) finalizeReply(set, get);
      break;
    }

    case 'error': {
      stopTypewriter();
      // 出错时本轮不会再收尾，这里补一次，避免气泡一直闪光标
      runFinished = true;
      set({ error: event.message, thinking: false, activeNodes: [] });
      finalizeReply(set, get);
      break;
    }

    case 'done': {
      runFinished = true;
      set({ thinking: false });
      // 打字机还在揭示时，由它消费完缓冲后自行收尾（见 startTypewriter）
      if (!typeTimer) finalizeReply(set, get);
      break;
    }

    default:
      break;
  }
}

function applySnapshot(
  payload: AgentStateSnapshot,
  set: (partial: Partial<AgentState>) => void,
  get: () => AgentState,
): void {
  const state = get();
  // toolCallLog 已由服务端裁剪为「本轮」条目，前端直接使用
  const timeline = payload.toolCallLog;

  // 服务端购物车为准：UI 里的增减也会在下一轮请求中回传，此处同步展示
  useCartStore.getState().setItems(payload.cart);

  const messages = state.messages;
  // 本轮回复气泡：存在即说明本轮 token 已经在流式输出
  const activeBubble =
    activeReplyId === null
      ? undefined
      : messages.find((message) => message.id === activeReplyId);

  if (!payload.reply) {
    set({ snapshot: payload, timeline, llmEnabled: payload.llmEnabled });
    return;
  }

  if (activeBubble) {
    // 以服务端最终文案为准补齐尾部：打字机可能还没消费完，也可能有 token 在路上。
    // pendingText 直接整体替换为「尚未揭示的剩余部分」，避免重复追加
    const revealed = activeBubble.content;
    if (payload.reply.startsWith(revealed) && payload.reply.length > revealed.length) {
      pendingText = payload.reply.slice(revealed.length);
      // 缓冲可能已被消费完（定时器已停），必须重启才会继续揭示
      if (shouldAnimate()) startTypewriter(activeBubble.id, set, get);
    }
    set({ snapshot: payload, timeline, llmEnabled: payload.llmEnabled });
    return;
  }

  const lastMessage = messages[messages.length - 1];
  const isDuplicate =
    lastMessage !== undefined &&
    lastMessage.role === 'agent' &&
    lastMessage.content === payload.reply;
  if (isDuplicate) {
    set({ snapshot: payload, timeline, llmEnabled: payload.llmEnabled });
    return;
  }

  // 没有 token 流（模板回复 / 非流式路径）：按最终文案建一条气泡
  const replyId = createId('a');
  activeReplyId = replyId;
  const instant = !shouldAnimate();
  if (!instant) pendingText = payload.reply;
  set({
    snapshot: payload,
    timeline,
    llmEnabled: payload.llmEnabled,
    thinking: false,
    messages: [
      ...messages,
      {
        id: replyId,
        role: 'agent',
        content: instant ? payload.reply : '',
        createdAt: Date.now(),
        // 非逐字路径下这条就是最终文案，直接标记完成；逐字路径等本轮结束再收尾
        streaming: !instant,
        productIds: payload.searchResults.slice(0, 3).map((product) => product.id),
      },
    ],
  });
  if (!instant) startTypewriter(replyId, set, get);
}
