import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { buildHistoryContext, historyConfig } from '@/lib/agent/history';
import { isLlmEnabled } from '@/lib/agent/llm';
import { INTENT_SYSTEM_PROMPT, buildIntentUserPrompt } from '@/lib/agent/prompts';
import {
  describeFilters,
  detectClearAll,
  extractFiltersByRules,
  guessIntentByRules,
  parseOrdinalIndex,
} from '@/lib/agent/ruleParser';
import type { AgentStateUpdate, AgentStateValue } from '@/lib/agent/state';
import { invokeStructured, type StructuredMethod } from '@/lib/agent/structured';
import { createLogEntry, nodeLog } from '@/lib/agent/utils';
import { lastHumanText } from '@/lib/agent/utils';
import {
  PROFILE_SOURCE_LABEL,
  hasProfileSignals,
  profileFromConfig,
  profileHintOf,
  profileRecall,
  profileSummaryLines,
} from '@/lib/profile';
import {
  CATEGORIES,
  INTENT_LABEL,
  SORT_KEYS,
  type AgentIntent,
  type Product,
  type SearchFilters,
} from '@/lib/types';

/**
 * LLM 结构化输出契约（intent + 筛选条件）。
 * 除 intent 外全部用 nullish：模型漏填字段时不会让整次解析失败，
 * 只是该维度不参与筛选，剩余维度仍然生效。
 */
const IntentSchema = z.object({
  intent: z.enum(['search', 'refine', 'compare', 'cart', 'checkout', 'chat']),
  keywords: z.array(z.string()).nullish(),
  category: z.enum(CATEGORIES).nullish(),
  minPrice: z.number().nullish(),
  maxPrice: z.number().nullish(),
  minRating: z.number().nullish(),
  brands: z.array(z.string()).nullish(),
  tags: z.array(z.string()).nullish(),
  sort: z.enum(SORT_KEYS).nullish(),
  /** 序数指代：「换成第二件」里的 2（1 起始）。不是序数时留空 */
  targetIndex: z.number().int().min(1).max(20).nullish(),
  reason: z.string().nullish(),
});

type IntentParseResult = z.infer<typeof IntentSchema>;

/**
 * 把序数解析成上一轮结果里的具体商品。
 *
 * 越界（例如上一轮只有 3 件却问「第 5 件」）或没有序数时返回 null，
 * 调用方按「普通细化」处理，不去改结果集。
 */
export function resolveOrdinalTarget(
  results: Product[],
  index: number | null,
): Product | null {
  if (index === null) return null;
  return results[index - 1] ?? null;
}

/**
 * LLM 结构化输出 → **完整的**筛选条件对象（未解析出的字段显式为 undefined）。
 *
 * 为什么补齐「空键」而不是只写本轮解析出来的字段（2026-09-26 修检索条件粘性）：
 * searchFilters 的 reducer 是浅合并，只写有值的键时，上一轮设过的字段会被
 * 「默默留下」—— LLM 路径实测：「100 元以内」之后点品类 chip，`maxPrice` 仍在、
 * 命中从 60 缩到 4。规则解析器一直返回完整对象（未命中即 undefined），
 * 两条路径对齐这一形状后，「重置」才有确定的机制保证：
 * 显式 undefined 在浅合并里覆盖旧值（由 mergeSearchFilters 的单测锁定）。
 */
function toFilters(parsed: IntentParseResult, text: string): SearchFilters {
  return {
    rawQuery: text,
    keywords: parsed.keywords?.length ? parsed.keywords : undefined,
    category: parsed.category ?? undefined,
    minPrice: typeof parsed.minPrice === 'number' ? parsed.minPrice : undefined,
    maxPrice: typeof parsed.maxPrice === 'number' ? parsed.maxPrice : undefined,
    minRating: typeof parsed.minRating === 'number' ? parsed.minRating : undefined,
    brands: parsed.brands?.length ? parsed.brands : undefined,
    tags: parsed.tags?.length ? parsed.tags : undefined,
    sort: parsed.sort ?? undefined,
  };
}

/** 增量合并：只覆盖本次真正解析出来的字段 */
function mergeFilters(base: SearchFilters, patch: SearchFilters): SearchFilters {
  const merged: SearchFilters = { ...base };
  for (const [key, value] of Object.entries(patch) as [
    keyof SearchFilters,
    SearchFilters[keyof SearchFilters],
  ][]) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    Object.assign(merged, { [key]: value });
  }
  return merged;
}

/** 五类「细分条件」：价格 / 评分 / 标签 / 品牌。排序刻意不在其中（见 isScopeSwitch） */
function hasRefinementConditions(filters: SearchFilters): boolean {
  return (
    filters.minPrice !== undefined ||
    filters.maxPrice !== undefined ||
    filters.minRating !== undefined ||
    (filters.tags?.length ?? 0) > 0 ||
    (filters.brands?.length ?? 0) > 0
  );
}

/** 列表型字段是否含有「上一轮没有的」新词（同值不算本轮证据） */
function hasNewWords(next: string[] | undefined, previous: string[] | undefined): boolean {
  if (!next?.length) return false;
  const known = new Set(previous ?? []);
  return next.some((word) => !known.has(word));
}

/**
 * 本轮**新给出**的细分条件：「与上一轮同值」且「用户原话里也没出现」的取值
 * 视为沿用（LLM 把旧条件写回来的情形），不计入本轮证据。
 *
 * 为什么必须做这层过滤：LLM 会把 prompt 里「当前筛选条件」的旧值一并写进结构化
 * 输出 —— 实测「100 元以内」之后点服饰 chip，输出里带着 maxPrice=100 回来；
 * 「推荐几本小说」之后说「按价格从低到高排」，输出里带着上一轮的 category=图书
 * 回来。拿原样输出当证据，重置会被这些沿用值无条件挡掉，判据等于失效。
 *
 * 为什么还要「原话兜底」：用户明确重述一个与上一轮相同的值时（「100 元以内的书」
 * 在 ≤100 的会话里），它是**本轮给出的条件**，不能被当成沿用清掉。
 * 数字按字面匹配、词按子串匹配 —— 宁可判成「本轮条件」（不重置），不可反过来。
 */
function hasNewRefinements(next: SearchFilters, previous: SearchFilters): boolean {
  const text = next.rawQuery ?? '';
  const isNewNumber = (value: number | undefined, former: number | undefined): boolean =>
    value !== undefined && (value !== former || text.includes(String(value)));
  const isNewWordList = (list: string[] | undefined, former: string[] | undefined): boolean =>
    (list ?? []).some((word) => !(former ?? []).includes(word) || text.includes(word));
  return (
    isNewNumber(next.minPrice, previous.minPrice) ||
    isNewNumber(next.maxPrice, previous.maxPrice) ||
    isNewNumber(next.minRating, previous.minRating) ||
    isNewWordList(next.tags, previous.tags) ||
    isNewWordList(next.brands, previous.brands)
  );
}

/**
 * 「切换浏览目标」判据（2026-09-26 修 §8-32 检索条件粘性、品类 chip 场景）：
 * 本轮**新给出**明确的浏览目标（品类或关键词）、且没有新的细分条件
 * → 视为一次全新浏览，重置上一轮的细分条件；否则与上一轮合并（未提到的字段沿用）。
 *
 * 四个刻意的设计点：
 * 1. **与 intent 无关**：LLM 对「切换目标」的判定不稳定（实测同一句话可能判 search、
 *    也可能判 refine），靠 intent 分叉必漏一处；判据只看「本轮解析出了什么」。
 * 2. **只看「新给出」的取值**：与上一轮同值的字段视为沿用（LLM 会把旧条件写回来，
 *    见 hasNewRefinements 的注释）。
 * 3. **sort 不参与判据、也不被重置**：它是展示偏好不是过滤条件 ——
 *    「服饰，按价格排序」要的是「服饰 + 按价格排」，不该被上一轮的价格条件挡住。
 * 4. **关键词也是明确目标**：「推荐点跑鞋」在图书会话里应换到运动品类，
 *    所以 category 与 keywords 命中其一即可触发。
 */
export function isScopeSwitch(next: SearchFilters, previous: SearchFilters): boolean {
  const categoryIsNew = next.category !== undefined && next.category !== previous.category;
  const targetIsNew = categoryIsNew || hasNewWords(next.keywords, previous.keywords);
  return targetIsNew && !hasNewRefinements(next, previous);
}

/**
 * 清空整份筛选条件：八个筛选字段全部显式置 undefined（浅合并 reducer 下覆盖旧值），
 * 只留本轮原话与排序偏好（sort 是展示偏好，按既有裁决不参与重置）。
 *
 * 为什么必须「显式」：reducer 是 `{...previous, ...next}`，只写 `{rawQuery}` 的话
 * 上一轮的 category / keywords 会原样留下 —— 清空就成了摆设。
 */
export function clearAllFilters(next: SearchFilters, previous: SearchFilters): SearchFilters {
  return {
    rawQuery: next.rawQuery,
    keywords: undefined,
    category: undefined,
    minPrice: undefined,
    maxPrice: undefined,
    minRating: undefined,
    brands: undefined,
    tags: undefined,
    sort: next.sort ?? previous.sort,
  };
}

/**
 * 重置细分条件：五类显式置 undefined（浅合并 reducer 下覆盖旧值，单测锁定该语义）；
 * 品类 / 关键词用本轮的，排序本轮给了就用本轮、没给沿用上一轮。
 */
export function resetRefinements(next: SearchFilters, previous: SearchFilters): SearchFilters {
  return {
    ...next,
    minPrice: undefined,
    maxPrice: undefined,
    minRating: undefined,
    tags: undefined,
    brands: undefined,
    sort: next.sort ?? previous.sort,
  };
}

/**
 * 清洗写进时间线的 LLM 失败文本（2026-09-25）。
 *
 * 动机不是「修漏洞」，而是**口径一致**：项目纪律是 token 不进日志 / 文档 / commit，
 * 右栏时间线同样是被截图、被讲述、被审查的界面，因此也不该出现密钥片段 ——
 * 实测服务商 401 文本形如 `401 Authentication Fails, Your api key: ****rsal is invalid
 * (request_id: …)`，其中含密钥末 4 位。
 *
 * 只去掉密钥片段，**保留可诊断信息**（HTTP 状态码、request_id、超时描述）。
 */
export function sanitizeLlmError(message: string): string {
  return message
    // 「Your api key: ****abcd is invalid」整体换成中性描述（最多吃掉 48 字，遇到 , ; ( ) 即停，避免误伤后续诊断信息）
    .replace(/(?:your\s+)?api[\s_-]?key\s*[:=]?\s*[^,;()]{0,48}/gi, '服务商鉴权失败')
    // 兜底：任何「****abcd」形态的掩码片段
    .replace(/\*{2,}[A-Za-z0-9]+/g, '***')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 意图解析节点。
 *
 * 主路径：LLM 结构化输出（withStructuredOutput，强约束 schema）；
 * 兜底：LLM 未配置 / 超时 / 解析失败时走规则解析器，
 * 保证没有 API Key 也能把「自然语言 → 筛选条件」跑通。
 */
export async function parseIntentNode(
  state: AgentStateValue,
  config?: RunnableConfig,
): Promise<AgentStateUpdate> {
  const startedAt = Date.now();
  const text = lastHumanText(state.messages);
  const ruleFilters = extractFiltersByRules(text);

  // 短期记忆：把最近若干轮对话裁进 prompt，用于消解「刚才那个」这类指代。
  // 历史只作理解输入，不作为路由依据（见 INTENT_SYSTEM_PROMPT 第 6 - 8 条）。
  const { enabled: historyEnabled, maxChars } = historyConfig();
  const history = historyEnabled ? buildHistoryContext(state.messages, maxChars) : '';

  // 跨会话画像：服务端不持有它，随请求（config.configurable）上行，用完即弃。
  // 注入了什么就展示什么 —— 面板里的「记起你的偏好」必须能对应到这次真实注入。
  const profile = profileFromConfig(config);
  const profileLines =
    profile && hasProfileSignals(profile) ? profileSummaryLines(profile) : [];

  let intent: AgentIntent = guessIntentByRules(text);
  let filters = ruleFilters;
  let source: 'llm' | 'rules' = 'rules';
  let method: StructuredMethod | null = null;
  let llmError: string | null = null;
  let llmTargetIndex: number | null = null;
  let detail = describeFilters(ruleFilters);

  if (isLlmEnabled() && text.trim()) {
    try {
      const result = await invokeStructured({
        schema: IntentSchema,
        name: 'parse_intent',
        system: INTENT_SYSTEM_PROMPT,
        user: buildIntentUserPrompt(text, state.searchFilters, history, profileLines),
        temperature: 0,
      });
      intent = result.value.intent;
      filters = toFilters(result.value, text);
      source = 'llm';
      method = result.method;
      llmTargetIndex = result.value.targetIndex ?? null;
      detail = result.value.reason || describeFilters(filters);
    } catch (error) {
      // 不再静默吞掉：把失败原因写进时间线，否则线上只能看到「LLM 不可用」这种误导性描述
      llmError = error instanceof Error ? error.message : String(error);
    }
  }

  // 条件继承与重置（唯一判定点，2026-09-26 起）：
  // - 用户要看「全部商品」（清空条件类表达）→ 整份条件重置（含品类 / 关键词）；
  // - 切换浏览目标 → 重置上一轮的细分条件（价格 / 评分 / 标签 / 品牌）；
  // - 其余情况（细化、稀疏增量、闲聊等）→ 与上一轮合并，未提到的字段沿用。
  const previous = state.searchFilters;
  // 「看全部」判据只读**用户原话**（detectClearAll 不看 LLM 输出、不看 filters）：
  // 旧判据被绕过的原因正是拿「LLM 回写的旧值」当「本轮提到了什么」的证据 ——
  // 用户说「让我看看所有 420 件商品」时，回写回来的「数码」是旧的，不是他说的话。
  // intent 门挡在 {search, refine}：购物车 / 结算 / 对比 / 闲聊轮不清空（「全部加入购物车」）。
  const clearsAll = (intent === 'search' || intent === 'refine') && detectClearAll(text);
  const switchesScope = !clearsAll && isScopeSwitch(filters, previous);
  filters = clearsAll
    ? clearAllFilters(filters, previous)
    : switchesScope
      ? resetRefinements(filters, previous)
      : mergeFilters(previous, filters);
  // 注意：相对表述（「再便宜一点」）的放宽只在 refineSearch 节点执行一次，
  // 这里不再处理，否则同一轮会被放宽两次（500 → 350 → 245）。

  const sourceText =
    source === 'llm'
      ? // 把「是否注入了历史」写进时间线：这是验证指代能力最直接的证据
        `LLM 解析（${method === 'prompt' ? '文本 JSON' : method === 'jsonMode' ? 'JSON 模式' : '工具调用'}）${
          history ? ` · 历史 ${history.length} 字` : ''
        }`
      : `规则解析${llmError ? ` · LLM 失败：${sanitizeLlmError(llmError).slice(0, 80)}` : ''}`;

  // 序数指代（「换成第二件」）：定位到上一轮结果的第 N 件，交给 searchProducts 收窄结果集。
  // LLM 没给出 targetIndex 时用规则解析兜底 —— 「无 Key 也能跑」同样要覆盖这个能力。
  const targetIndex = llmTargetIndex ?? parseOrdinalIndex(text);
  const focusProduct = resolveOrdinalTarget(state.searchResults, targetIndex);
  const focusNote = focusProduct
    ? ` · 定位到第 ${targetIndex} 件：${focusProduct.name}`
    : '';

  // 画像消费（只在这一处判定，generateReply 只负责渲染）：
  // - 判据取**规则解析出的当前输入条件**，而不是 LLM 解析出的 filters ——
  //   模型可能参考画像补上品类，用它判断会把「模型参考了偏好」误判成
  //   「用户明确说了品类」，提示与记忆事件都不会出现；
  // - 只有找商品的场景（search / refine / chat）才提偏好，购物车 / 结算 / 对比不打扰用户；
  // - 规则路径不拿画像改筛选条件（以当前输入为准），只把偏好体现在回复里。
  const inputHasScope = Boolean(ruleFilters.category) || (ruleFilters.keywords?.length ?? 0) > 0;
  const recallEligible = intent === 'search' || intent === 'refine' || intent === 'chat';
  const recall =
    profile && !inputHasScope && recallEligible ? profileRecall(profile) : null;
  const profileHint = recall ? profileHintOf(recall) : '';

  const logs = [
    nodeLog(
      'parseIntent',
      `识别意图：${INTENT_LABEL[intent]}`,
      `${sourceText} · ${detail}${focusNote}`,
      startedAt,
    ),
  ];
  if (recall) {
    logs.push(
      createLogEntry({
        kind: 'decision',
        name: 'profile_recall',
        title: `记起你的偏好：${recall.label}`,
        detail: `本轮输入未给出品类/关键词，参考了历史偏好（来源：${PROFILE_SOURCE_LABEL[recall.source]}）`,
        status: 'done',
        startedAt,
      }),
    );
  }
  // 重置发生时留一条中性记录：条件悄悄消失会让人困惑（本项目的主题是推理过程可视化）。
  // 上一轮本来就没什么可重置时不写 —— 避免「全部商品 → 服饰」这种没有信息量的噪音。
  if (clearsAll && describeFilters(previous) !== '全部商品') {
    logs.push(
      createLogEntry({
        kind: 'decision',
        name: 'clear_filters',
        title: '清空条件：重置全部筛选条件',
        detail: `${describeFilters(previous)} → ${describeFilters(filters)}`,
        status: 'done',
        startedAt,
      }),
    );
  }
  if (switchesScope && hasRefinementConditions(previous)) {
    logs.push(
      createLogEntry({
        kind: 'decision',
        name: 'scope_reset',
        title: '切换浏览目标：重置上一轮条件',
        detail: `${describeFilters(previous)} → ${describeFilters(filters)}`,
        status: 'done',
        startedAt,
      }),
    );
  }

  return {
    intent,
    searchFilters: filters,
    // 每轮都写：解析不出序数时写 null，避免上一轮的目标残留影响本轮
    focusProductId: focusProduct?.id ?? null,
    // 每轮重置本轮画像信号（覆盖型 reducer，见 AgentState 的注释）
    profilePatch: [],
    // 每轮重置自动放宽计数（覆盖型 reducer）：它是**本轮**的放宽轮次，不是线程级累积 ——
    // 旧实现逐轮累加，跑满 2 轮后时间线显示「第 3/2 轮」，且条件边永远判 false
    // （needsRefine && refineCount < 2），该线程的自动放宽能力从此永久失效。
    refineCount: 0,
    profileHint,
    toolCallLog: logs,
  };
}
