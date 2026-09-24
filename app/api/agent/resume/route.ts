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
  /** 画像 generation：resume 轮由 confirmOrder 产出成交信号，前端需要同一个值来接受它 */
  profileGeneration: z.number().int().min(0).optional(),
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

  const { sessionId, decision, profileGeneration } = parsed.data;

  const stream = createAgentEventStream({
    app: await getAgentApp(),
    // resume 不经过 parseIntent，因此这里用 Command.update 把 generation 写进状态，
    // 否则快照回显的还是上一轮的值，成交信号会被前端当成过期 patch 丢掉
    input: new Command({
      resume: decision,
      update: { profileGeneration: profileGeneration ?? 0 },
    }),
    config: threadConfig(sessionId),
    sessionId,
  });

  return sseResponse(stream);
}
