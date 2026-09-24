import type { AgentRequestBody, AgentResumeBody, AgentStreamEvent } from '@/lib/agent/events';

/**
 * Agent SSE 客户端。
 *
 * 用 fetch + ReadableStream 而不是 EventSource：EventSource 只支持 GET，
 * 无法携带消息体、购物车快照与图片。
 */
export interface StreamAgentHandlers {
  onEvent: (event: AgentStreamEvent) => void;
  signal?: AbortSignal;
}

async function consumeSse(
  response: Response,
  handlers: StreamAgentHandlers,
): Promise<void> {
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // 忽略解析失败，使用默认提示
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error('响应没有可读流');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const dataLine = frame
        .split('\n')
        .find((line) => line.startsWith('data: '));
      if (!dataLine) continue;
      try {
        handlers.onEvent(JSON.parse(dataLine.slice(6)) as AgentStreamEvent);
      } catch {
        // 单帧解析失败不影响后续事件
      }
    }
  }
}

export async function streamAgent(
  body: AgentRequestBody,
  handlers: StreamAgentHandlers,
): Promise<void> {
  const response = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: handlers.signal,
  });
  await consumeSse(response, handlers);
}

export async function resumeAgent(
  body: AgentResumeBody,
  handlers: StreamAgentHandlers,
): Promise<void> {
  const response = await fetch('/api/agent/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: handlers.signal,
  });
  await consumeSse(response, handlers);
}
