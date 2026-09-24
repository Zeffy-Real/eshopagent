import type { AgentRequestBody, AgentResumeBody, AgentStreamEvent } from '@/lib/agent/events';

/**
 * Agent SSE 客户端。
 *
 * 用 fetch + ReadableStream 而不是 EventSource：EventSource 只支持 GET，
 * 无法携带消息体、购物车快照与图片。
 *
 * 在途请求的中止**只在这里管理**：调用方（store）不再自己 new AbortController，
 * 需要中止时统一调 `abortActiveRequest()`。这样「谁在跑、怎么停」只有一个答案，
 * 也不会出现两处各持一个句柄、彼此不知道对方存在的情况。
 */
export interface StreamAgentHandlers {
  onEvent: (event: AgentStreamEvent) => void;
}

/** 当前在途请求（同一时刻最多一个：store 侧已按 thread 硬串行化） */
let activeRequest: AbortController | null = null;

/**
 * 主动中止在途请求。
 *
 * 凡是**会话身份或本地状态发生变更**的动作都必须调用它（清除画像 / 清空对话 / 开启新会话）：
 * 流还在跑的时候换身份，旧 token 会继续写进新的列表 —— 清除画像方向会让旧 patch 复活
 * 已清空的画像，换会话方向会让新会话里冒出旧会话的零散文字，都属于数据污染。
 *
 * 注意：中止只是停止**客户端接收**。服务端那一轮图仍会跑完（Node 侧不会因为连接断开
 * 就终止执行），所以「打断重发」这种语义需要服务端配合，当前不做 —— 同一 thread 并发跑图
 * 会让 checkpoint 互相覆盖，store 用 `thinking` 硬串行化挡住这种情况。
 */
export function abortActiveRequest(): void {
  activeRequest?.abort();
  activeRequest = null;
}

/**
 * 是否是「主动中止」而不是网络故障。
 *
 * 浏览器在 abort 时抛出的异常 name 就是 `AbortError`（DOMException）：
 * 主动中止要静默收尾（不弹错误提示、不写进消息列表），网络错误才提示用户。
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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

/** 统一的请求入口：AbortController 的创建、登记与清理只发生在这里 */
async function request(
  url: string,
  body: AgentRequestBody | AgentResumeBody,
  handlers: StreamAgentHandlers,
): Promise<void> {
  const controller = new AbortController();
  activeRequest = controller;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    await consumeSse(response, handlers);
  } finally {
    // 只清理属于本次请求的句柄：否则会把后来者的登记误清掉
    if (activeRequest === controller) activeRequest = null;
  }
}

export async function streamAgent(
  body: AgentRequestBody,
  handlers: StreamAgentHandlers,
): Promise<void> {
  await request('/api/agent', body, handlers);
}

export async function resumeAgent(
  body: AgentResumeBody,
  handlers: StreamAgentHandlers,
): Promise<void> {
  await request('/api/agent/resume', body, handlers);
}