import { HumanMessage } from '@langchain/core/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateReplyNode } from '@/lib/agent/nodes/generateReply';
import type { AgentStateUpdate } from '@/lib/agent/state';
import {
  buildProfileHint,
  createEmptyProfile,
  extractProfileSignals,
  mergeProfile,
} from '@/lib/profile';
import type { ToolLogEntry } from '@/lib/types';
import { makeProduct, makeState } from '@/lib/test-utils/factories';

/**
 * 规则路径必须**消费**画像：不报错 ≠ 生效。
 * 没有 Key 时回复走模板，模板末尾要把「注意到你之前常看图书…」补上 ——
 * 这句话由 parseIntent 判定（写进 profileHint），本节点只负责渲染。
 *
 * 另一半是落地校验的重试策略：第一次没过不直接降级，先把不符的数字点名告诉模型再问一次，
 * 仍不过才用模板 —— 直接降级会让用户看到一句「少了个数字」的模板文案，
 * 而重试往往能救回来。
 */

const mocks = vi.hoisted(() => ({
  llmEnabled: false,
  /** 每次 stream() 依次产出的文本（模拟多轮候选） */
  streamOutputs: [] as string[],
  /** invoke() 的返回值（重试结果）与调用次数 */
  invokeOutput: '',
  invokeCalls: 0,
}));

vi.mock('@/lib/agent/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/llm')>();
  return {
    ...actual,
    isLlmEnabled: () => mocks.llmEnabled,
    createChatModel: () => ({
      // 分片 yield：与真实流式一致（连接器按 chunk 累积）
      stream: async function* () {
        const next = mocks.streamOutputs.shift() ?? '';
        for (const piece of next.match(/[\s\S]{1,12}/g) ?? []) {
          yield { content: piece };
        }
      },
      invoke: async () => {
        mocks.invokeCalls += 1;
        return { content: mocks.invokeOutput };
      },
    }),
  };
});

beforeEach(() => {
  mocks.llmEnabled = false;
  mocks.streamOutputs = [];
  mocks.invokeOutput = '';
  mocks.invokeCalls = 0;
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

function logOf(update: AgentStateUpdate): ToolLogEntry | undefined {
  const value = update.toolCallLog;
  return Array.isArray(value) ? value[0] : undefined;
}

function greetingState(profileHint: string) {
  return makeState({
    intent: 'chat',
    messages: [new HumanMessage('你好')],
    profileHint,
  });
}

function searchState() {
  return makeState({
    intent: 'search',
    messages: [new HumanMessage('推荐几本图书')],
    searchResults: [book],
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

describe('generateReplyNode：落地校验失败先重试一次', () => {
  it('首次出现编造金额 → 带纠正提示重试一次，采用重试结果', async () => {
    mocks.llmEnabled = true;
    mocks.streamOutputs = ['这本只要 ¥999999，非常划算。'];
    mocks.invokeOutput = '这本书 ¥39，评分 4.5 分，在预算内。';

    const update = await generateReplyNode(searchState());

    expect(mocks.invokeCalls).toBe(1);
    expect(replyOf(update)).toBe('这本书 ¥39，评分 4.5 分，在预算内。');
    expect(logOf(update)?.detail).toContain('已按纠正提示重试一次');
    expect(logOf(update)?.detail).toContain('¥999999');
  });

  it('重试后仍不符 → 降级为模板回复，时间线说明重试失败', async () => {
    mocks.llmEnabled = true;
    mocks.streamOutputs = ['这本只要 ¥999999。'];
    mocks.invokeOutput = '还是 ¥888888，很便宜。';

    const update = await generateReplyNode(searchState());

    expect(mocks.invokeCalls).toBe(1);
    // 模板回复的特征：数据全部来自状态
    expect(replyOf(update)).toContain('为你找到');
    expect(replyOf(update)).not.toContain('888888');
    expect(logOf(update)?.detail).toContain('重试后仍未通过');
  });

  it('首次即通过 → 不触发重试', async () => {
    mocks.llmEnabled = true;
    mocks.streamOutputs = ['这本书 ¥39，评分 4.5 分。'];

    const update = await generateReplyNode(searchState());

    expect(mocks.invokeCalls).toBe(0);
    expect(replyOf(update)).toBe('这本书 ¥39，评分 4.5 分。');
    expect(logOf(update)?.detail).toBe('LLM 生成');
  });

  it('数量口径贴错标签（把评价数写成销量）也走重试', async () => {
    mocks.llmEnabled = true;
    // 该商品没有真实销量（sales = 0），模型把评价数当销量说出去
    mocks.streamOutputs = ['销量 1,000，口碑很好。'];
    mocks.invokeOutput = '评价 1,000 条，口碑很好。';

    const update = await generateReplyNode(searchState());

    expect(mocks.invokeCalls).toBe(1);
    expect(replyOf(update)).toBe('评价 1,000 条，口碑很好。');
    expect(logOf(update)?.detail).toContain('销量 1,000');
  });
});