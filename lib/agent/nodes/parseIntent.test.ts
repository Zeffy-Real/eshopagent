import { HumanMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { describe, expect, it, vi } from 'vitest';
import { parseIntentNode, resolveOrdinalTarget, sanitizeLlmError } from '@/lib/agent/nodes/parseIntent';
import type { AgentStateUpdate } from '@/lib/agent/state';
import {
  createEmptyProfile,
  extractProfileSignals,
  mergeProfile,
  type UserProfile,
} from '@/lib/profile';
import type { ToolLogEntry, SearchFilters } from '@/lib/types';
import { makeCartItem, makeProduct, makeState } from '@/lib/test-utils/factories';

/**
 * 序数指代的落点：把「第 N 件」映射到上一轮结果里的具体商品。
 * 越界时必须返回 null（按普通细化处理），而不是抛错或取到错误的商品。
 *
 * 另外锁死画像的**无 Key 消费路径**：规则解析不拿画像改筛选条件，
 * 但宽泛输入下必须在回复里体现偏好，并产出右栏可见的记忆事件 ——
 * 「不报错 ≠ 生效」，这条只能靠单测守住。
 */

// 固定走规则路径：否则本机恰好配了 Key 时会去打真实网络请求
vi.mock('@/lib/agent/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/llm')>();
  return { ...actual, isLlmEnabled: () => false };
});

const results = [
  makeProduct({ id: 'a', name: '第一件' }),
  makeProduct({ id: 'b', name: '第二件' }),
  makeProduct({ id: 'c', name: '第三件' }),
];

describe('resolveOrdinalTarget', () => {
  it('按 1 起始的序号取对应商品', () => {
    expect(resolveOrdinalTarget(results, 1)?.id).toBe('a');
    expect(resolveOrdinalTarget(results, 2)?.id).toBe('b');
    expect(resolveOrdinalTarget(results, 3)?.id).toBe('c');
  });

  it('没有序号时返回 null（不是序数指代）', () => {
    expect(resolveOrdinalTarget(results, null)).toBeNull();
  });

  it('越界时返回 null，不会取到相邻商品', () => {
    expect(resolveOrdinalTarget(results, 4)).toBeNull();
    expect(resolveOrdinalTarget(results, 0)).toBeNull();
    expect(resolveOrdinalTarget(results, -1)).toBeNull();
  });

  it('上一轮结果为空时返回 null', () => {
    expect(resolveOrdinalTarget([], 1)).toBeNull();
  });
});

/** LangGraph 的 Update 类型会把字段放宽，这里做带守卫的窄化 */
function hintOf(update: AgentStateUpdate): string {
  const value = update.profileHint;
  return typeof value === 'string' ? value : '';
}

function logsOf(update: AgentStateUpdate): ToolLogEntry[] {
  const value = update.toolCallLog;
  return Array.isArray(value) ? value : [];
}

/** LangGraph 的 Update 会把字段放宽为 `T | OverwriteValue<T>`，运行时是普通对象 */
function filtersOf(update: AgentStateUpdate): SearchFilters {
  const value = update.searchFilters;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('parseIntentNode 未返回 searchFilters');
  }
  return value as SearchFilters;
}

const orderedBook = makeProduct({
  id: 'p-book',
  name: '测试小说',
  brand: '测试出版社',
  category: '图书',
  price: 39,
});

const boughtBook: UserProfile = mergeProfile(
  createEmptyProfile(),
  extractProfileSignals({ kind: 'order', items: [makeCartItem(orderedBook)] }),
);

function configWith(profile: UserProfile): RunnableConfig {
  return { configurable: { profile } };
}

describe('sanitizeLlmError：写进时间线前清洗密钥片段', () => {
  // 项目纪律是 token 不进日志 / 文档 / commit；右栏时间线同样会被截图与讲述，
  // 因此也不该出现密钥片段（实测服务商 401 文本会回显密钥末 4 位，见 demo-rehearsal.md §6.2 C3）。
  it('服务商回显的密钥片段换成中性描述，状态码与 request_id 保留', () => {
    const out = sanitizeLlmError(
      '401 Authentication Fails, Your api key: ****abcd is invalid (request_id: 2673ed9',
    );
    expect(out).not.toContain('abcd');
    expect(out).not.toMatch(/api[\s_-]?key/i);
    expect(out).toContain('401');
    expect(out).toContain('request_id: 2673ed9');
    expect(out).toContain('服务商鉴权失败');
  });

  it('裸掩码片段（无前后文）也会被掩掉', () => {
    expect(sanitizeLlmError('invalid credential ****deadbeef')).not.toContain('deadbeef');
  });

  it('普通失败文本原样保留（不误伤超时 / 限流描述）', () => {
    expect(sanitizeLlmError('timeout of 20000ms exceeded')).toBe('timeout of 20000ms exceeded');
    expect(sanitizeLlmError('429 rate limit exceeded')).toBe('429 rate limit exceeded');
  });
});

describe('parseIntentNode：画像消费（无 Key 路径）', () => {
  it('输入宽泛 + 画像有信号 → 写入 profileHint 并产出记忆事件', async () => {
    const update = await parseIntentNode(
      makeState({ messages: [new HumanMessage('推荐点什么')] }),
      configWith(boughtBook),
    );

    expect(hintOf(update)).toBe('注意到你之前买过图书，需要我按这个方向再找找吗？');
    const recall = logsOf(update).find((entry) => entry.name === 'profile_recall');
    expect(recall?.title).toBe('记起你的偏好：图书');
    // 规则路径不拿画像改筛选条件：筛选条件必须仍由当前输入决定
    expect(filtersOf(update).category).toBeUndefined();
  });

  it('输入已给出品类 → 不提偏好、不产记忆事件', async () => {
    const update = await parseIntentNode(
      makeState({ messages: [new HumanMessage('推荐几本图书')] }),
      configWith(boughtBook),
    );

    expect(hintOf(update)).toBe('');
    expect(logsOf(update).some((entry) => entry.name === 'profile_recall')).toBe(false);
    expect(filtersOf(update).category).toBe('图书');
  });

  it('没有画像 → 不提偏好（不硬提）', async () => {
    const update = await parseIntentNode(
      makeState({ messages: [new HumanMessage('推荐点什么')] }),
      configWith(createEmptyProfile()),
    );

    expect(hintOf(update)).toBe('');
    expect(logsOf(update).some((entry) => entry.name === 'profile_recall')).toBe(false);
  });

  it('购物车类输入不打扰：即使输入宽泛也不提偏好', async () => {
    const update = await parseIntentNode(
      makeState({ messages: [new HumanMessage('把购物车清空')] }),
      configWith(boughtBook),
    );

    expect(hintOf(update)).toBe('');
  });
});
