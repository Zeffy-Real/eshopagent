import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { buildHistoryContext, historyConfig } from '@/lib/agent/history';
import { isLlmEnabled } from '@/lib/agent/llm';
import { INTENT_SYSTEM_PROMPT, buildIntentUserPrompt } from '@/lib/agent/prompts';
import {
  describeFilters,
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

function toFilters(parsed: IntentParseResult, text: string): SearchFilters {
  const filters: SearchFilters = { rawQuery: text };
  if (parsed.keywords?.length) filters.keywords = parsed.keywords;
  if (parsed.category) filters.category = parsed.category;
  if (typeof parsed.minPrice === 'number') filters.minPrice = parsed.minPrice;
  if (typeof parsed.maxPrice === 'number') filters.maxPrice = parsed.maxPrice;
  if (typeof parsed.minRating === 'number') filters.minRating = parsed.minRating;
  if (parsed.brands?.length) filters.brands = parsed.brands;
  if (parsed.tags?.length) filters.tags = parsed.tags;
  if (parsed.sort) filters.sort = parsed.sort;
  return filters;
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

/** 新条件过于稀疏时，沿用上一轮的条件（例如「我想买跑鞋」→「预算 500 以内」） */
function shouldKeepPrevious(
  intent: AgentIntent,
  next: SearchFilters,
  previous: SearchFilters,
): boolean {
  if (intent === 'refine') return true;
  const nextSparse = !next.category && !next.keywords?.length;
  const previousHasScope = Boolean(previous.category || previous.keywords?.length);
  return intent === 'search' && nextSparse && previousHasScope;
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

  if (shouldKeepPrevious(intent, filters, state.searchFilters)) {
    filters = mergeFilters(state.searchFilters, filters);
  }
  // 注意：相对表述（「再便宜一点」）的放宽只在 refineSearch 节点执行一次，
  // 这里不再处理，否则同一轮会被放宽两次（500 → 350 → 245）。

  const sourceText =
    source === 'llm'
      ? // 把「是否注入了历史」写进时间线：这是验证指代能力最直接的证据
        `LLM 解析（${method === 'prompt' ? '文本 JSON' : method === 'jsonMode' ? 'JSON 模式' : '工具调用'}）${
          history ? ` · 历史 ${history.length} 字` : ''
        }`
      : `规则解析${llmError ? ` · LLM 失败：${llmError.slice(0, 80)}` : ''}`;

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

  return {
    intent,
    searchFilters: filters,
    // 每轮都写：解析不出序数时写 null，避免上一轮的目标残留影响本轮
    focusProductId: focusProduct?.id ?? null,
    // 每轮重置本轮画像信号（覆盖型 reducer，见 AgentState 的注释）
    profilePatch: [],
    profileHint,
    toolCallLog: logs,
  };
}
