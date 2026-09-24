import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { buildHistoryContext, historyConfig, DEFAULT_HISTORY_MAX_CHARS } from '@/lib/agent/history';

/**
 * 短期记忆是「把硬编码的单场景规则升级为基于真实上下文的理解」的关键，
 * 两条硬约束必须锁死：按轮次裁剪（不截断单条）、排除当前输入。
 */

const BUDGET = 10_000;

describe('buildHistoryContext：基本裁剪', () => {
  it('空消息 → 空串', () => {
    expect(buildHistoryContext([], BUDGET)).toBe('');
  });

  it('只有当前输入（无更早消息）→ 空串', () => {
    // 当前输入由调用方单独传入，历史里必须排除它，否则同一句话出现两次
    expect(buildHistoryContext([new HumanMessage('推荐几本小说')], BUDGET)).toBe('');
  });

  it('一轮历史 → 保留「用户 + 助手」并带角色标注', () => {
    const messages = [
      new HumanMessage('推荐几本小说'),
      new AIMessage('为你找到 8 本图书'),
      new HumanMessage('刚才那个再便宜点'),
    ];
    const history = buildHistoryContext(messages, BUDGET);
    expect(history).toContain('用户：推荐几本小说');
    expect(history).toContain('助手：为你找到 8 本图书');
    // 当前输入不能被写进历史
    expect(history).not.toContain('刚才那个再便宜点');
  });

  it('多轮历史按时间顺序拼接', () => {
    const messages = [
      new HumanMessage('第一问'),
      new AIMessage('第一答'),
      new HumanMessage('第二问'),
      new AIMessage('第二答'),
      new HumanMessage('第三问'),
    ];
    const history = buildHistoryContext(messages, BUDGET);
    expect(history.indexOf('第一问')).toBeLessThan(history.indexOf('第二问'));
  });

  it('预算为 0 → 空串', () => {
    const messages = [new HumanMessage('问'), new AIMessage('答'), new HumanMessage('当前')];
    expect(buildHistoryContext(messages, 0)).toBe('');
  });
});

describe('buildHistoryContext：超预算时丢最旧的完整轮次', () => {
  const messages = [
    new HumanMessage('第一问'),
    new AIMessage('第一答'),
    new HumanMessage('第二问'),
    new AIMessage('第二答'),
    new HumanMessage('当前输入'),
  ];

  it('只保留最近若干轮，且丢弃的是最旧的', () => {
    // 「用户：第二问\n助手：第二答」约 20 字，给刚好装下一轮的预算
    const history = buildHistoryContext(messages, 24);
    expect(history).toContain('第二问');
    expect(history).not.toContain('第一问');
  });

  it('绝不截断单条消息：一条装不下就整条丢弃', () => {
    const long = '很长的助手回复'.repeat(20);
    const withLong = [
      new HumanMessage('短问题'),
      new AIMessage(long),
      new HumanMessage('当前输入'),
    ];
    const history = buildHistoryContext(withLong, 30);
    // 整轮都装不下 → 什么都不给，而不是给半句被截断的回复
    expect(history).toBe('');
  });

  it('保留的是「最近连续若干轮」，不是跳跃的碎片', () => {
    const history = buildHistoryContext(messages, 24);
    // 一旦某轮装不下就停止，不会跳过它去取更早的轮次
    expect(history.startsWith('用户：')).toBe(true);
  });
});

describe('buildHistoryContext：消息类型与内容容错', () => {
  it('忽略非 human / ai 的消息，且只取文本部分', () => {
    const multimodal = new HumanMessage({
      content: [
        { type: 'text', text: '以图搜同款' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
      ],
    });
    const messages = [multimodal, new AIMessage('已识别到耳机'), new HumanMessage('当前')];
    const history = buildHistoryContext(messages, BUDGET);
    expect(history).toContain('用户：以图搜同款');
    expect(history).not.toContain('base64');
  });

  it('空文本消息被跳过，不产生「用户：」空行', () => {
    const messages = [new HumanMessage('   '), new AIMessage('有内容'), new HumanMessage('当前')];
    const history = buildHistoryContext(messages, BUDGET);
    expect(history).not.toContain('用户：\n');
  });
});

describe('historyConfig：环境变量开关', () => {
  it('未配置时默认开启，预算为默认值', () => {
    const original = process.env.HISTORY_MAX_CHARS;
    delete process.env.HISTORY_MAX_CHARS;
    const config = historyConfig();
    expect(config.enabled).toBe(true);
    expect(config.maxChars).toBe(DEFAULT_HISTORY_MAX_CHARS);
    if (original !== undefined) process.env.HISTORY_MAX_CHARS = original;
  });

  it('HISTORY_MAX_CHARS 非法值回落到默认预算', () => {
    const original = process.env.HISTORY_MAX_CHARS;
    process.env.HISTORY_MAX_CHARS = 'abc';
    expect(historyConfig().maxChars).toBe(DEFAULT_HISTORY_MAX_CHARS);
    process.env.HISTORY_MAX_CHARS = '-5';
    expect(historyConfig().maxChars).toBe(DEFAULT_HISTORY_MAX_CHARS);
    if (original === undefined) delete process.env.HISTORY_MAX_CHARS;
    else process.env.HISTORY_MAX_CHARS = original;
  });
});
