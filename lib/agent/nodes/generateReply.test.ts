import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { generateReplyNode } from '@/lib/agent/nodes/generateReply';
import {
  buildProfileHint,
  createEmptyProfile,
  extractProfileSignals,
  mergeProfile,
} from '@/lib/profile';
import { makeProduct, makeState } from '@/lib/test-utils/factories';

/**
 * 规则路径必须**消费**画像：不报错 ≠ 生效。
 *
 * 没有 Key 时回复走模板，模板末尾要把「注意到你之前常看图书…」补上 ——
 * 这句话由 parseIntent 判定（写进 profileHint），本节点只负责渲染。
 */

// 固定走模板路径，避免本机恰好配了 Key 时去打真实网络请求
vi.mock('@/lib/agent/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/llm')>();
  return { ...actual, isLlmEnabled: () => false };
});

const book = makeProduct({ id: 'p-book', name: '测试小说', category: '图书', price: 39 });

const hint = buildProfileHint(
  mergeProfile(createEmptyProfile(), extractProfileSignals({ kind: 'cart', product: book })),
);

function replyOf(update: Awaited<ReturnType<typeof generateReplyNode>>): string {
  const messages = update.messages;
  if (!Array.isArray(messages)) throw new Error('generateReplyNode 未返回 messages');
  const first = messages[0];
  return typeof first?.content === 'string' ? first.content : '';
}

function greetingState(profileHint: string) {
  return makeState({
    intent: 'chat',
    messages: [new HumanMessage('你好')],
    profileHint,
  });
}

describe('generateReplyNode：规则路径的画像消费', () => {
  it('profileHint 非空时补在模板回复末尾', async () => {
    const update = await generateReplyNode(greetingState(hint));
    expect(hint).toContain('图书');
    expect(replyOf(update).trimEnd().endsWith(hint)).toBe(true);
  });

  it('profileHint 为空时不硬提偏好', async () => {
    const update = await generateReplyNode(greetingState(''));
    expect(replyOf(update)).not.toContain('注意到你之前');
  });
});