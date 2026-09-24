import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortActiveRequest,
  isAbortError,
  resumeAgent,
  streamAgent,
  type StreamAgentHandlers,
} from '@/lib/agent-client';
import type { AgentStreamEvent } from '@/lib/agent/events';

/**
 * 在途请求的中止**只有一个入口**（`abortActiveRequest`），且「主动中止」必须能与网络错误
 * 区分开：主动中止要静默收尾（不弹错误提示、不写进消息列表），网络错误才提示用户。
 *
 * 这里用假的 fetch 覆盖两条路径：正常派发 SSE 事件、abort 时以 AbortError 结束。
 */

const encoder = new TextEncoder();

/** 把若干 SSE 帧拼成一个正常结束的响应 */
function sseResponse(frames: string[]): Response {
  const body = frames.map((frame) => `data: ${frame}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/**
 * 造一个「永不结束」的流式响应，并把 signal 接上：
 * abort 时让读取抛 AbortError —— 与浏览器行为一致（Response 本身不绑 signal）。
 */
function hangingResponse(signal: AbortSignal): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"run_start","sessionId":"s1"}\n\n'));
      signal.addEventListener('abort', () => {
        controller.error(new DOMException('The user aborted a request.', 'AbortError'));
      });
    },
  });
  return new Response(stream, { status: 200 });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  abortActiveRequest();
  vi.unstubAllGlobals();
});

describe('isAbortError：区分主动中止与网络错误', () => {
  it('AbortError 判为主动中止', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
    const named = new Error('The operation was aborted');
    named.name = 'AbortError';
    expect(isAbortError(named)).toBe(true);
  });

  it('网络错误与普通异常不算主动中止', () => {
    expect(isAbortError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isAbortError(new Error('请求失败（500）'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError('boom')).toBe(false);
  });
});

describe('streamAgent / resumeAgent：事件派发', () => {
  it('把 SSE 帧解析成事件交给调用方', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        '{"type":"run_start","sessionId":"s1"}',
        '{"type":"token","content":"你"}',
        '{"type":"done"}',
      ]),
    );

    const events: AgentStreamEvent[] = [];
    await streamAgent({ sessionId: 's1', message: '你好' }, { onEvent: (e) => events.push(e) });

    expect(events.map((event) => event.type)).toEqual(['run_start', 'token', 'done']);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('resume 走同一套入口（同一条中止链路）', async () => {
    fetchMock.mockResolvedValue(sseResponse(['{"type":"done"}']));
    const handlers: StreamAgentHandlers = { onEvent: () => {} };

    await resumeAgent({ sessionId: 's1', decision: 'confirm' }, handlers);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent/resume',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('HTTP 错误响应抛出可读错误（不是 AbortError）', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: '参数校验失败' }), { status: 400 }),
    );

    const error = await streamAgent(
      { sessionId: 's1', message: 'hi' },
      { onEvent: () => {} },
    ).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(isAbortError(error)).toBe(false);
    expect(error instanceof Error ? error.message : '').toBe('参数校验失败');
  });
});

describe('abortActiveRequest：中止在途请求', () => {
  it('中止后请求以 AbortError 结束，且被 isAbortError 识别', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init.signal as AbortSignal)),
    );

    const pending = streamAgent({ sessionId: 's1', message: '你好' }, { onEvent: () => {} });
    // 等 fetch 真正发出后再中止（模拟「流到一半点新会话」）
    await new Promise((resolve) => setTimeout(resolve, 0));
    abortActiveRequest();

    const error = await pending.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(isAbortError(error)).toBe(true);
  });

  it('没有在途请求时中止是安全的空操作', () => {
    expect(() => abortActiveRequest()).not.toThrow();
  });
});