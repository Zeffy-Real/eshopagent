import { Command } from '@langchain/langgraph';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { threadConfig } from '@/lib/agent/checkpointer';
import { getAgentApp } from '@/lib/agent/graph';
import { createAgentEventStream, sseResponse } from '@/lib/agent/sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  sessionId: z.string().min(1).max(64),
  decision: z.enum(['confirm', 'cancel']),
});

/**
 * 中断恢复入口（human-in-the-loop）。
 *
 * prepareOrder 节点内调用 interrupt() 暂停图执行并落一次 checkpoint；
 * 前端弹窗拿到用户决策后 POST 到这里，用 Command({ resume }) 从断点恢复，
 * 图会重新执行 prepareOrder 的剩余部分并继续走到 confirmOrder。
 */
export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: '参数校验失败', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { sessionId, decision } = parsed.data;

  const stream = createAgentEventStream({
    app: getAgentApp(),
    input: new Command({ resume: decision }),
    config: threadConfig(sessionId),
    sessionId,
  });

  return sseResponse(stream);
}
