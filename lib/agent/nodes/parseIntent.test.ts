import { HumanMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { describe, expect, it, vi } from 'vitest';
import {
  isScopeSwitch,
  parseIntentNode,
  resolveOrdinalTarget,
  sanitizeLlmError,
} from '@/lib/agent/nodes/parseIntent';
import { mergeSearchFilters } from '@/lib/agent/state';
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

/**
 * 条件继承与重置（2026-09-26 修 §8-32「检索条件粘性」与品类 chip 场景）。
 *
 * 背景：LLM 路径的 `toFilters` 过去只写本轮解析出来的字段，浅合并 reducer 会把
 * 上一轮设过的字段（价格 / 关键词等）默默留下 —— 「100 元以内」之后点「服饰」chip，
 * 命中从 60 缩到 4。修法是在 parseIntent 里做唯一判定：切换浏览目标 → 重置细分条件，
 * 其余情况合并（未提到的字段沿用）。这一组用例锁住判据的四个边界。
 */
describe('parseIntentNode：检索条件的继承与重置', () => {
  const dirtyFilters: SearchFilters = {
    category: '图书',
    keywords: ['小说'],
    minPrice: 50,
    maxPrice: 100,
    minRating: 4.5,
    tags: ['透气'],
    brands: ['Sony'],
  };

  it('只有品类（chip 场景）→ 重置价格 / 评分 / 标签 / 品牌与上一轮关键词', async () => {
    const update = await parseIntentNode(
      makeState({
        messages: [new HumanMessage('帮我看看服饰的商品')],
        searchFilters: dirtyFilters,
      }),
    );

    const filters = filtersOf(update);
    expect(filters.category).toBe('服饰');
    expect(filters.keywords).toBeUndefined();
    expect(filters.minPrice).toBeUndefined();
    expect(filters.maxPrice).toBeUndefined();
    expect(filters.minRating).toBeUndefined();
    expect(filters.tags).toBeUndefined();
    expect(filters.brands).toBeUndefined();
  });

  it('只有关键词（无品类）→ 同样视为新目标并重置细分条件', async () => {
    const update = await parseIntentNode(
      makeState({ messages: [new HumanMessage('推荐点耳机')], searchFilters: dirtyFilters }),
    );

    const filters = filtersOf(update);
    expect(filters.keywords).toContain('耳机');
    expect(filters.maxPrice).toBeUndefined();
    expect(filters.brands).toBeUndefined();
  });

  it('品类 + 价格 → 两者都生效（不触发重置）', async () => {
    const update = await parseIntentNode(
      makeState({
        messages: [new HumanMessage('500 元以内的跑鞋')],
        searchFilters: { maxPrice: 200 },
      }),
    );

    const filters = filtersOf(update);
    expect(filters.category).toBe('运动');
    expect(filters.keywords).toContain('跑鞋');
    expect(filters.maxPrice).toBe(500);
  });

  it('纯指代（无品类 / 关键词）→ 继承上一轮条件', async () => {
    const update = await parseIntentNode(
      makeState({ messages: [new HumanMessage('换成第二件')], searchFilters: dirtyFilters }),
    );

    const filters = filtersOf(update);
    expect(filters.category).toBe('图书');
    expect(filters.keywords).toEqual(['小说']);
    expect(filters.maxPrice).toBe(100);
  });

  it('增量（只给价格）→ 继承其余条件', async () => {
    const update = await parseIntentNode(
      makeState({ messages: [new HumanMessage('预算 300 以内')], searchFilters: dirtyFilters }),
    );

    const filters = filtersOf(update);
    expect(filters.category).toBe('图书');
    expect(filters.keywords).toEqual(['小说']);
    expect(filters.maxPrice).toBe(300);
  });

  it('品类 + 排序 → 重置过滤条件、保留排序', async () => {
    const update = await parseIntentNode(
      makeState({
        messages: [new HumanMessage('服饰 最便宜的')],
        searchFilters: { maxPrice: 100, tags: ['透气'] },
      }),
    );

    const filters = filtersOf(update);
    expect(filters.category).toBe('服饰');
    expect(filters.sort).toBe('price_asc');
    expect(filters.maxPrice).toBeUndefined();
    expect(filters.tags).toBeUndefined();
  });

  it('本轮没给排序时，上一轮的排序不被重置（sort 是展示偏好）', async () => {
    const update = await parseIntentNode(
      makeState({
        messages: [new HumanMessage('帮我看看服饰的商品')],
        searchFilters: { ...dirtyFilters, sort: 'sales' },
      }),
    );

    expect(filtersOf(update).sort).toBe('sales');
  });

  it('重置会在时间线上留一条可见记录（条件悄悄消失会让人困惑）', async () => {
    const update = await parseIntentNode(
      makeState({
        messages: [new HumanMessage('帮我看看服饰的商品')],
        searchFilters: dirtyFilters,
      }),
    );

    const reset = logsOf(update).find((entry) => entry.name === 'scope_reset');
    expect(reset?.title).toBe('切换浏览目标：重置上一轮条件');
    expect(reset?.detail).toContain('图书');
    expect(reset?.detail).toContain('服饰');
    expect(reset?.detail).toContain('→');
  });

  it('上一轮没有细分条件可重置时不写记录（避免无信息量的噪音）', async () => {
    const update = await parseIntentNode(
      makeState({
        messages: [new HumanMessage('帮我看看服饰的商品')],
        searchFilters: { category: '图书' },
      }),
    );

    expect(logsOf(update).some((entry) => entry.name === 'scope_reset')).toBe(false);
  });

  it('显式 undefined 在浅合并 reducer 下覆盖旧值（重置的机制保证）', async () => {
    const previous: SearchFilters = { ...dirtyFilters };
    const update = await parseIntentNode(
      makeState({
        messages: [new HumanMessage('帮我看看服饰的商品')],
        searchFilters: previous,
      }),
    );

    // 还原真实链路：节点返回值经 searchFilters 的 reducer（mergeSearchFilters）落到状态
    const merged = mergeSearchFilters(previous, filtersOf(update));
    expect(merged.category).toBe('服饰');
    expect(merged.maxPrice).toBeUndefined();
    expect(merged.tags).toBeUndefined();
    expect(merged.keywords).toBeUndefined();
  });
});

/**
 * 判据的「只认本轮新给出的取值」这层 —— LLM 会把 prompt 里「当前筛选条件」的旧值
 * 一并写进结构化输出（实测：chip 轮带回 maxPrice、排序轮带回 category），
 * 直接拿原样输出当证据会让重置被沿用值挡掉（或误伤同值目标）。
 */
describe('isScopeSwitch：同值沿用与原话兜底', () => {
  it('与上一轮同值的品类不算新目标（排序轮带回的 category）', () => {
    expect(
      isScopeSwitch(
        { rawQuery: '按价格从低到高排', category: '图书', sort: 'price_asc' },
        { category: '图书', keywords: ['小说'] },
      ),
    ).toBe(false);
  });

  it('与上一轮同值的价格、原话未提及 → 视为沿用（重置触发）', () => {
    expect(
      isScopeSwitch({ rawQuery: '帮我看看服饰的商品', category: '服饰', maxPrice: 100 }, { maxPrice: 100 }),
    ).toBe(true);
  });

  it('与上一轮同值的价格、但原话里说了 → 算本轮条件（不重置）', () => {
    expect(
      isScopeSwitch({ rawQuery: '100 元以内的书', category: '图书', maxPrice: 100 }, { maxPrice: 100 }),
    ).toBe(false);
  });

  it('新品类 + 新价格 → 不触发重置（两者都生效）', () => {
    expect(
      isScopeSwitch({ rawQuery: '服饰 200 以内', category: '服饰', maxPrice: 200 }, { maxPrice: 100 }),
    ).toBe(false);
  });

  it('新关键词 + 无细分条件 → 触发（换商品目标）', () => {
    expect(
      isScopeSwitch({ rawQuery: '推荐点耳机', keywords: ['耳机'] }, { category: '图书', keywords: ['小说'] }),
    ).toBe(true);
  });
});
