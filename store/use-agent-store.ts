'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AgentStateSnapshot, AgentStreamEvent } from '@/lib/agent/events';
import { normalizeSnapshot } from '@/lib/agent/events';
import { applyProfilePatch, clearProfile, createEmptyProfile, type UserProfile } from '@/lib/profile';
import type { Order, ToolLogEntry } from '@/lib/types';
import { abortActiveRequest, isAbortError, resumeAgent, streamAgent } from '@/lib/agent-client';
import { useCartStore } from '@/store/use-cart-store';
import { useOrderStore } from '@/store/use-order-store';
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
  /**
   * **本次页面会话内**真实确认过的那一单的订单号（成功态的唯一依据）。
   *
   * 故意不持久化（`partialize` 里没有它）：成功弹窗只在「刚刚点了确认」时出现 ——
   * 若改用持久化快照里的 `pendingOrder.status === 'confirmed'` 判断，刷新后
   * 会重播一次「下单成功」弹窗（A-2）。它由 `resumeOrder('confirm')` 期间
   * 到达的 confirmed 快照写入，因此数据源仍是 `confirmOrder` 的真实结果。
   */
  recentConfirmedOrderId: string | null;
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
  /**
   * 跨会话画像（**同一浏览器下**的偏好记忆，见 lib/profile.ts）。
   *
   * 这里是画像的**唯一存储**：随 store 持久化进 localStorage，服务端不持有它 ——
   * 每轮请求把它一次性上行（服务端用完即弃），回来的只是本轮的信号增量。
   */
  userProfile: UserProfile;
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
  /** 一键清空画像：generation 自增使在途 patch 过期，同时中止在途请求（双保险） */
  clearUserProfile: () => void;
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

/**
 * 是否有「确认下单」的 resume 在途（模块级、不持久化）。
 *
 * 用途：只有在这段时间里到达的 confirmed 快照才算「刚刚真实确认的那一单」，
 * 用来写 `recentConfirmedOrderId`（成功态的唯一依据）。刷新后这个标记必然是
 * false，因此持久化快照里的 confirmed 订单不会把成功弹窗重新点亮（A-2）。
 */
let confirmFlowActive = false;

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

/**
 * 把本轮的展示商品挂到回复气泡上。
 *
 * 两条路径共用这一个入口、且 id 列表只有一个来源（服务端快照的 `replyProductIds`，
 * 由 `selectReplyProductIds` 选出）：
 *   - LLM 流式路径：气泡由首个 token 建好，收尾时在这里补齐卡片；
 *   - 模板路径（无 token）：气泡在 `applySnapshot` 里新建，直接把列表写进消息。
 * 空列表（闲聊 / 加购下单 / 对比轮）不改动任何消息，因此气泡不会挂无关卡片。
 */
function withReplyProducts(
  messages: ChatMessage[],
  replyId: string,
  productIds: string[],
): ChatMessage[] {
  if (productIds.length === 0) return messages;
  return messages.map((message) =>
    message.id === replyId ? { ...message, productIds } : message,
  );
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
      recentConfirmedOrderId: null,
      resuming: false,
      error: null,
      llmEnabled: true,
      hasHydrated: false,
      userProfile: createEmptyProfile(),

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
              // 画像随请求一次性上行（服务端不持有它），回来的只有本轮信号增量
              profile: get().userProfile,
              profileGeneration: get().userProfile.generation,
            },
            { onEvent: (event) => handleEvent(event, set, get) },
          );
        } catch (error) {
          stopTypewriter();
          runFinished = true;
          if (isAbortError(error)) {
            // 主动中止（清除画像 / 清空对话 / 新会话）：静默收尾，不当成请求失败
            set({ thinking: false, activeNodes: [] });
            finalizeReply(set, get);
          } else {
            set({
              thinking: false,
              activeNodes: [],
              error: error instanceof Error ? error.message : '发送失败，请重试',
            });
          }
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
        confirmFlowActive = decision === 'confirm';
        set({ thinking: true, error: null, timeline: [], resuming: true });
        try {
          await resumeAgent(
            {
              sessionId: get().sessionId,
              decision,
              // resume 轮的成交信号（权重最高）同样要能被接受，因此 generation 一并上行
              profileGeneration: get().userProfile.generation,
            },
            { onEvent: (event) => handleEvent(event, set, get) },
          );
        } catch (error) {
          stopTypewriter();
          if (isAbortError(error)) {
            runFinished = true;
            set({ thinking: false, activeNodes: [] });
            finalizeReply(set, get);
          } else {
            set({
              thinking: false,
              error: error instanceof Error ? error.message : '订单确认失败，请重试',
            });
          }
        } finally {
          confirmFlowActive = false;
          set({ resuming: false, interruptedOrder: null });
        }
      },

      clearConversation() {
        // 先中止在途请求：否则这一轮流还在跑，token 会写进刚清空的消息列表
        abortActiveRequest();
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
        // 同 clearConversation：换了身份还在收旧身份的数据 = 数据污染
        abortActiveRequest();
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

      clearUserProfile() {
        // 主防线是 generation 自增（在途 patch 会被 applyProfilePatch 丢掉），
        // 中止在途请求是双保险：让服务端也别再把这一轮跑完。
        abortActiveRequest();
        set({ userProfile: clearProfile(get().userProfile) });
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
        // 跨会话画像：与 sessionId 天然解耦（按 sessionId 存会让新会话读不到），
        // 「新会话」按钮因此不会清掉画像
        userProfile: state.userProfile,
      }),
      /**
       * 恢复时的形状归一化（**唯一入口**）：`snapshot` 可能来自旧版本，而它的字段是
       * 逐步长出来的 —— localStorage 是不可信边界，这里把它归一回 `AgentStateSnapshot`
       * （默认值清单与理由见 `lib/agent/events.ts` 的 `normalizeSnapshot`）。
       * 不这么做的话，消费者要各自写 `?.` / `??`，漏一处就是整页白屏（2026-09-26 实测）。
       * 其余被持久化的键（sessionId / messages / userProfile）形状稳定，按默认浅合并处理。
       */
      merge: (persisted, current) => {
        const saved =
          persisted && typeof persisted === 'object' ? (persisted as Partial<AgentState>) : {};
        return { ...current, ...saved, snapshot: normalizeSnapshot(saved.snapshot) };
      },
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
      // 挂起中断只可能是 pending：confirmed 的订单是「已完成的事实」，不是待确认订单。
      // 服务端收尾兜底已按同一判据收紧（sse.ts 的 fallbackInterruptOrder），
      // 这里再挡一层，任何来源的 confirmed 事件都不会把结算弹窗重新打开。
      if (event.order.status === 'confirmed') break;
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
  // 本轮该挂的内联卡商品（唯一来源：服务端按 selectReplyProductIds 选好随快照下发）
  const replyProductIds = payload.replyProductIds;

  // 服务端购物车为准：UI 里的增减也会在下一轮请求中回传，此处同步展示
  useCartStore.getState().setItems(payload.cart);

  // 成功态的唯一依据：在「确认下单」的 resume 在途期间到达的 confirmed 订单
  // （就是 confirmOrder 真实写回、经 SSE 下发的落单结果）。会话级门见
  // confirmFlowActive 的注释——刷新后从持久化快照里读到同一条订单不会再点亮弹窗。
  if (payload.pendingOrder?.status === 'confirmed') {
    // 订单历史：同一份 confirmed 订单幂等入库（只记真实落单结果，前端不拼装）
    useOrderStore.getState().recordOrder(payload.pendingOrder);
    if (confirmFlowActive) set({ recentConfirmedOrderId: payload.pendingOrder.id });
  }

  // 画像：generation 校验通过才合并（清除画像后 generation 自增，携带旧值的在途 patch 一律丢弃）。
  // mergeProfile 是幂等的、且「无变化时返回同一引用」，所以一轮里被推多次也不会重复计分。
  const userProfile = applyProfilePatch(
    state.userProfile,
    payload.profilePatch,
    payload.profileGeneration,
  );

  const messages = state.messages;
  // 本轮回复气泡：存在即说明本轮 token 已经在流式输出
  const activeBubble =
    activeReplyId === null
      ? undefined
      : messages.find((message) => message.id === activeReplyId);

  if (!payload.reply) {
    set({ snapshot: payload, timeline, llmEnabled: payload.llmEnabled, userProfile });
    return;
  }

  if (activeBubble) {
    // 以服务端最终文案为准补齐尾部：打字机可能还没消费完，也可能有 token 在路上。
    // pendingText 直接整体替换为「尚未揭示的剩余部分」，避免重复追加
    const revealed = activeBubble.content;
    if (payload.reply.startsWith(revealed)) {
      if (payload.reply.length > revealed.length) {
        pendingText = payload.reply.slice(revealed.length);
        // 缓冲可能已被消费完（定时器已停），必须重启才会继续揭示
        if (shouldAnimate()) startTypewriter(activeBubble.id, set, get);
      }
      set({
        snapshot: payload,
        timeline,
        llmEnabled: payload.llmEnabled,
        userProfile,
        // LLM 流式路径的气泡由首个 token 建好，卡片在这里补齐
        messages: withReplyProducts(messages, activeBubble.id, replyProductIds),
      });
      return;
    }

    // 终态与流式候选**不是同一段文本**：说明这段候选被落地校验否决了
    // （按纠正提示重试后改用新文案，或直接降级为模板）。此时必须整体替换气泡内容 ——
    // 否则界面会一直显示那段被判为「不可信」的文字，与状态里的 reply 分叉：
    // 用户看到的和 Agent 实际采用的会变成两段话。
    stopTypewriter();
    const staleReplyId = activeBubble.id;
    activeReplyId = null;
    set({
      snapshot: payload,
      timeline,
      llmEnabled: payload.llmEnabled,
      userProfile,
      messages: withReplyProducts(
        messages.map((message) =>
          message.id === staleReplyId
            ? { ...message, content: payload.reply, streaming: false }
            : message,
        ),
        staleReplyId,
        replyProductIds,
      ),
    });
    return;
  }

  const lastMessage = messages[messages.length - 1];
  const isDuplicate =
    lastMessage !== undefined &&
    lastMessage.role === 'agent' &&
    lastMessage.content === payload.reply;
  if (isDuplicate) {
    set({
      snapshot: payload,
      timeline,
      llmEnabled: payload.llmEnabled,
      userProfile,
      // 同一轮被推多次快照：已建好的气泡同样要补齐卡片（幂等）
      messages: withReplyProducts(messages, lastMessage.id, replyProductIds),
    });
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
    userProfile,
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
        // 本轮展示的商品（服务端唯一实现选出）：空列表时不写这个字段，消息不带卡片
        ...(replyProductIds.length > 0 ? { productIds: replyProductIds } : {}),
      },
    ],
  });
  if (!instant) startTypewriter(replyId, set, get);
}
