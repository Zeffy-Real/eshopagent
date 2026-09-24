import { NextResponse } from 'next/server';
import { z } from 'zod';
import { threadConfig } from '@/lib/agent/checkpointer';
import { getAgentApp } from '@/lib/agent/graph';
import { buildUserMessage, createAgentEventStream, sseResponse } from '@/lib/agent/sse';
import { buildCartItems, cartLineSchema } from '@/lib/agent/tools/cartTools';
import { touchSession } from '@/lib/agent/session-store';
import { getProductsByIds } from '@/lib/catalog/products';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  sessionId: z.string().min(1).max(64),
  message: z.string().max(2000).default(''),
  // 复用工具层的 cartLineSchema，避免同一份契约两处实现（改一处忘一处会让两层约束悄悄不一致）
  cart: z.array(cartLineSchema).max(50).optional(),
  /** 以图搜商品：data URL，限制约 3MB（base64 后） */
  imageDataUrl: z.string().max(3_000_000).optional(),
  /** 商品区勾选的待对比商品 */
  compareProductIds: z.array(z.string().min(1)).max(4).optional(),
});

/**
 * Agent 主入口：SSE 流式返回。
 *
 * 请求体携带客户端购物车快照，服务端解析为实体后作为图输入的一部分注入，
 * 保证「UI 里改过的购物车」和「图状态里的购物车」不会分叉。
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

  const { sessionId, message, cart, imageDataUrl, compareProductIds } = parsed.data;
  if (!message.trim() && !imageDataUrl) {
    return NextResponse.json({ error: '消息与图片不能同时为空' }, { status: 400 });
  }

  // 会话元信息：首次出现的 sessionId 视为新会话，顺带触发一次过期会话清理
  await touchSession(sessionId);

  const compareTargets = compareProductIds ? getProductsByIds(compareProductIds) : [];

  const stream = createAgentEventStream({
    app: await getAgentApp(),
    input: {
      messages: [buildUserMessage(message.trim(), imageDataUrl)],
      ...(cart ? { cart: buildCartItems(cart) } : {}),
      ...(compareTargets.length > 0 ? { compareTargets } : {}),
    },
    config: threadConfig(sessionId),
    sessionId,
  });

  return sseResponse(stream);
}
