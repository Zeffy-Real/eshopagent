import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStateSnapshot } from '@/lib/agent/events';
import { selectReplyProductIds } from '@/lib/agent/sse';
import { makeOrder, makeProduct } from '@/lib/test-utils/factories';
import { useAgentStore } from '@/store/use-agent-store';

/**
 * 同一 thread 上并发跑两个图会让 checkpoint 互相覆盖，因此 store 用 `thinking` 硬串行化：
 * 前一轮没结束时，第二次 `sendMessage` 必须被**拒绝** —— 不排队、也不中止前一轮。
 *
 * 这条不变量在 UI 上表现为「运行中所有发送入口都被禁用」（发送按钮 / 品类 chip /
 * 购物车与对比按钮 disabled，顶栏搜索框由 handleSubmit 提前 return），
 * 但 UI 说不清「如果真发了会怎样」，所以用单测把它锁住。
 */

function sseResponse(frames: string[]): Response {
  return new Response(
    frames.map((frame) => `data: ${frame}\n\n`).join(''),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

/** 一份最小可用的状态快照载荷（只覆盖与本组用例相关的字段） */
function snapshotPayload(overrides: Partial<AgentStateSnapshot> = {}): AgentStateSnapshot {
  return {
    intent: 'search',
    searchFilters: {},
    conditionText: '',
    searchResults: [],
    searchTotal: 0,
    searchResultIds: [],
    replyProductIds: [],
    liveOverrides: {},
    liveFetchedAt: null,
    compareTargets: [],
    comparison: null,
    cart: [],
    toolCallLog: [],
    pendingOrder: null,
    reply: '',
    profilePatch: [],
    profileGeneration: 0,
    llmEnabled: true,
    ...overrides,
  };
}

/** 取最后一条 Agent 气泡 */
function lastAgentMessage() {
  const agents = useAgentStore.getState().messages.filter((message) => message.role === 'agent');
  return agents[agents.length - 1];
}

beforeEach(() => {
  // persist 需要 storage：给一个最小的内存实现，避免走「storage 不可用」的告警分支
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  useAgentStore.setState({
    sessionId: 's-test',
    messages: [],
    thinking: false,
    hasHydrated: true,
    interruptedOrder: null,
    recentConfirmedOrderId: null,
    resuming: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendMessage：同一时刻只允许一个在途请求', () => {
  it('上一轮未结束时，第二次发送被拒绝（只发出一个请求）', async () => {
    // 用对象持有 release：TS 会把「只在回调里被赋值」的局部变量窄化成 null
    const pending: { release: (() => void) | null } = { release: null };
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.release = () => resolve(sseResponse(['{"type":"done"}']));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = useAgentStore.getState().sendMessage('推荐几本图书');
    await Promise.resolve();
    await useAgentStore.getState().sendMessage('推荐几本耳机');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 第二条消息既不进入列表，也不影响第一条
    expect(useAgentStore.getState().messages.map((message) => message.content)).toEqual([
      '推荐几本图书',
    ]);

    pending.release?.();
    await first;
    expect(useAgentStore.getState().thinking).toBe(false);
  });

  it('上一轮结束后可以继续发送（串行化不是永久闸门）', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(sseResponse(['{"type":"done"}'])));
    vi.stubGlobal('fetch', fetchMock);

    await useAgentStore.getState().sendMessage('第一条');
    await useAgentStore.getState().sendMessage('第二条');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      useAgentStore
        .getState()
        .messages.filter((message) => message.role === 'user')
        .map((message) => message.content),
    ).toEqual(['第一条', '第二条']);
  });
});

describe('内联卡商品：模板路径与 LLM 路径产出同一 id 列表', () => {
  const results = [
    makeProduct({ id: 'p-1', name: '第一件' }),
    makeProduct({ id: 'p-2', name: '第二件' }),
    makeProduct({ id: 'p-3', name: '第三件' }),
    makeProduct({ id: 'p-4', name: '第四件' }),
  ];
  const expected = selectReplyProductIds(results);

  it('模板路径（无 token，兜底回复）→ 气泡挂上本轮前 3 件', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            JSON.stringify({
              type: 'state',
              payload: snapshotPayload({ reply: '为你找到 4 件商品', searchResults: results, replyProductIds: expected }),
            }),
            '{"type":"done"}',
          ]),
        ),
      ),
    );

    await useAgentStore.getState().sendMessage('推荐几件商品');

    const reply = lastAgentMessage();
    expect(reply?.content).toBe('为你找到 4 件商品');
    expect(reply?.productIds).toEqual(expected);
    expect(expected).toEqual(['p-1', 'p-2', 'p-3']);
  });

  it('LLM 流式路径 → 同一列表补到 token 建好的气泡上，且不新建第二个气泡', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            JSON.stringify({ type: 'token', content: '这几件都不错' }),
            JSON.stringify({
              type: 'state',
              payload: snapshotPayload({ reply: '这几件都不错', searchResults: results, replyProductIds: expected }),
            }),
            '{"type":"done"}',
          ]),
        ),
      ),
    );

    await useAgentStore.getState().sendMessage('推荐几件商品');

    const agents = useAgentStore.getState().messages.filter((message) => message.role === 'agent');
    expect(agents).toHaveLength(1);
    expect(agents[0]?.content).toBe('这几件都不错');
    // 与模板路径**同一个** id 列表（都来自 selectReplyProductIds 的下发值）
    expect(agents[0]?.productIds).toEqual(expected);
  });

  it('本轮没有商品（闲聊 / 加购下单 / 对比轮）→ 不挂卡片（productIds 缺省）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            JSON.stringify({ type: 'token', content: '你好呀' }),
            JSON.stringify({ type: 'state', payload: snapshotPayload({ reply: '你好呀' }) }),
            '{"type":"done"}',
          ]),
        ),
      ),
    );

    await useAgentStore.getState().sendMessage('你好');

    const reply = lastAgentMessage();
    expect(reply?.content).toBe('你好呀');
    expect(reply?.productIds).toBeUndefined();
  });
});

describe('订单中断：confirmed 不是挂起中断', () => {
  /**
   * 2026-09-26 真机复现的 bug：确认下单后每一轮收尾都会再收到一条 interrupt
   * （里面是 status=confirmed 的订单），结算弹窗复发。根因是服务端收尾兜底把
   * 「pendingOrder 非空」误读成「有挂起中断」；前端这里再挡一层。
   */
  it('interrupt 事件带 confirmed 订单 → 忽略，不打开结算弹窗', async () => {
    const order = makeOrder({ id: 'ES-CONFIRMED-1', status: 'confirmed' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            JSON.stringify({ type: 'interrupt', order }),
            '{"type":"done"}',
          ]),
        ),
      ),
    );

    await useAgentStore.getState().sendMessage('你好');

    expect(useAgentStore.getState().interruptedOrder).toBeNull();
  });

  it('interrupt 事件带 pending 订单 → 正常打开结算弹窗（正常流程不被修坏）', async () => {
    const order = makeOrder({ id: 'ES-PENDING-1', status: 'pending' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            JSON.stringify({ type: 'interrupt', order }),
            '{"type":"done"}',
          ]),
        ),
      ),
    );

    await useAgentStore.getState().sendMessage('结算');

    expect(useAgentStore.getState().interruptedOrder?.id).toBe('ES-PENDING-1');
  });

  it('确认下单的 resume 期间收到 confirmed 快照 → 记下成功态订单号', async () => {
    const order = makeOrder({ id: 'ES-CONFIRMED-2', status: 'confirmed' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            JSON.stringify({ type: 'state', payload: snapshotPayload({ pendingOrder: order }) }),
            '{"type":"done"}',
          ]),
        ),
      ),
    );

    await useAgentStore.getState().resumeOrder('confirm');

    expect(useAgentStore.getState().recentConfirmedOrderId).toBe('ES-CONFIRMED-2');
  });

  it('刷新后的普通一轮也带同一条 confirmed 快照 → 不写成功态（成功弹窗不重播）', async () => {
    const order = makeOrder({ id: 'ES-CONFIRMED-3', status: 'confirmed' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            JSON.stringify({ type: 'state', payload: snapshotPayload({ pendingOrder: order }) }),
            '{"type":"done"}',
          ]),
        ),
      ),
    );

    // 刷新后没有 resume 在途（confirmFlowActive 必然是 false），普通消息同样会带回
    // 持久化快照里的 confirmed 订单 —— 但它不该点亮成功态
    await useAgentStore.getState().sendMessage('你好');

    expect(useAgentStore.getState().recentConfirmedOrderId).toBeNull();
  });
});