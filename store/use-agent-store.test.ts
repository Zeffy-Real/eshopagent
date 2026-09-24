import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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