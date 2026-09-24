import { JD_ENDPOINTS, encodeStockLevel, parseJdPriceFen } from '@/lib/justoneapi/platforms/jd.mjs';
import { callJustOneApi, hasJustOneApiToken } from '@/lib/justoneapi/client.mjs';
import { isJustOneApiError, tripsBreaker } from '@/lib/justoneapi/errors.mjs';
import { SingleFlightCache, LIVE_CACHE_TTL_MS } from '@/lib/justoneapi/cache';
import {
  hasLiveKeyword,
  hasStockKeyword,
  isResolvableProductId,
  withLivePrice,
  withLiveStock,
} from '@/lib/justoneapi/overrides';
import type { AgentStateUpdate, AgentStateValue } from '@/lib/agent/state';
import { createLogEntry, lastHumanText } from '@/lib/agent/utils';
import type { Product } from '@/lib/types';

/**
 * 实时数据补充节点（`enrichLiveData`）。
 *
 * 定位是**补充节点**，不是替代节点：
 *   - 主数据仍来自 searchProducts（冻结快照）；
 *   - 本节点只对**已选中的商品**用京东实时价覆盖 `price`（以及可选 `stock`），
 *     **不新增商品、不改排序、不改筛选条件**；
 *   - 失败完全静默：不抛错、不进对话文本、不弹提示，只在右栏时间线留一条中性记录。
 *
 * 为什么做成图里的节点而不是独立函数：图是唯一编排层，函数会变成图之外的特例
 * （谁来调、何时调、失败怎么办都散落在调用点）；条件触发声明在**边**里可被单测覆盖；
 * 失败隔离在节点内，节点不抛错即天然不污染主流程。
 *
 * 覆盖范围（2026-09-25 裁定 1）：**只覆盖 price 与 stock**。
 * 京东搜索与详情端点里没有 rating / reviews / sales（实测为空串或「1万+」区间文案），
 * 拿不到的东西不假装有。
 */

/** 单轮最多补充几件（配额保护） */
export const MAX_ENRICH_ITEMS = 3;

/** 同一 thread 两次拉取的最小间隔（毫秒）：避免连续追问烧配额 */
export const LIVE_COOLDOWN_MS = 60_000;

/**
 * 结果缓存：同一商品 5 分钟内只拉一次（键含平台前缀，避免跨平台 id 撞车）。
 *
 * 分价格与库存两个缓存，缓存的是**映射后的结果**（一个数字），不是原始响应——
 * 京东详情响应体实测 40KB/件，缓存原始响应在 200 条上限下会占 8MB（见设计文档 §0 第 6 行）。
 * 失败不写缓存（`SingleFlightCache` 的语义）：一次抖动不该被固化 5 分钟。
 */
const priceCache = new SingleFlightCache<number>({ ttlMs: LIVE_CACHE_TTL_MS });
const stockCache = new SingleFlightCache<number>({ ttlMs: LIVE_CACHE_TTL_MS });

/** 单测隔离用：清空进程内缓存（否则同 id 的第二次用例会命中上一次的缓存） */
export function resetLiveCache(): void {
  priceCache.clear();
  stockCache.clear();
}

/* ============================================================
   熔断（当日不再进入本节点）
   ============================================================ */

/**
 * 挂 globalThis 而不是模块级变量：dev 下 HMR 会重建模块，模块级标记会被重置，
 * 于是「当日熔断」在热更新后失效、继续撞配额——与 checkpointer 需要锚定 globalThis
 * 是同一个理由（那边丢的是会话数据，这边丢的是熔断状态，后果都是「以为挡住了其实没挡」）。
 */
const BREAKER_KEY = '__eshopJustOneApiBreakerDate__';

interface BreakerHost {
  [BREAKER_KEY]?: string;
}

/** 熔断标记按「自然日」记：跨天后自动失效，不需要定时器 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isBreakerOpen(): boolean {
  return (globalThis as BreakerHost)[BREAKER_KEY] === today();
}

/** 收到配额/余额/限额类失败时落闸；仅用于内部与单测（导出以便重置） */
export function tripLiveBreaker(): void {
  (globalThis as BreakerHost)[BREAKER_KEY] = today();
}

/** 重置熔断标记（单测隔离用：熔断是进程内状态） */
export function resetLiveBreaker(): void {
  delete (globalThis as BreakerHost)[BREAKER_KEY];
}

/* ============================================================
   条件边判定（六条，全部满足才进入）
   ============================================================ */

/** 本轮可进入本节点的商品（保留原顺序，最多 MAX_ENRICH_ITEMS 件） */
export function resolvableProducts(state: AgentStateValue): Product[] {
  return state.searchResults.filter((product) => isResolvableProductId(product.id)).slice(0, MAX_ENRICH_ITEMS);
}

export interface LiveGateInput {
  hasToken: boolean;
  searchResults: Product[];
  userText: string;
  liveFetchedAt: number | null;
  breakerOpen: boolean;
  now: number;
}

/**
 * 六条判定（导出为纯函数，便于逐条单测）。
 *
 * 1. token 已配置（`hasJustOneApiToken()`，不自己读 env）
 * 2. searchResults 非空
 * 3. 本轮用户输入命中实时性关键词
 * 4. 至少一个商品 id 可解析为目标平台 id（`jd-` + 数字）
 * 5. 同 thread 距上次拉取 > 60 秒（冷启动 null → 通过）
 * 6. 当日未熔断
 */
export function shouldEnrich(input: LiveGateInput): boolean {
  if (!input.hasToken) return false;
  if (input.searchResults.length === 0) return false;
  if (!hasLiveKeyword(input.userText)) return false;
  if (!input.searchResults.some((product) => isResolvableProductId(product.id))) return false;
  if (input.liveFetchedAt !== null && input.now - input.liveFetchedAt <= LIVE_COOLDOWN_MS) return false;
  if (input.breakerOpen) return false;
  return true;
}

/** 供 graph.ts 使用的条件边判定：从状态里取输入 */
export function shouldEnterEnrichLiveData(state: AgentStateValue): boolean {
  return shouldEnrich({
    hasToken: hasJustOneApiToken(),
    searchResults: state.searchResults,
    userText: lastHumanText(state.messages),
    liveFetchedAt: state.liveFetchedAt,
    breakerOpen: isBreakerOpen(),
    now: Date.now(),
  });
}

/* ============================================================
   节点实现
   ============================================================ */

export interface LiveOutcome {
  /** 覆盖后的商品（键 = id）；全部失败时为空对象 */
  overrides: Record<string, Product>;
  /** 成功覆盖价格的件数 */
  priceCount: number;
  /** 成功覆盖库存等级的件数 */
  stockCount: number;
  /** 是否命中熔断码（调用方据此落闸） */
  breakerTripped: boolean;
  /** 是否发生过失败（用于时间线文案；不区分具体原因，不把错误抛出去） */
  failed: boolean;
}

/**
 * 拉取 + 覆盖（可注入 fetch，单测不发真实请求）。
 *
 * 失败语义：单件失败只跳过该件（不抛错、不重试到影响别件）；命中 303/601/602
 * （`tripsBreaker`）时把 `breakerTripped` 交给调用方落闸——节点本身仍不抛错。
 */
export async function collectLiveOverrides(
  products: Product[],
  options: {
    withStock: boolean;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    logger?: (line: string) => void;
  },
): Promise<LiveOutcome> {
  const overrides: Record<string, Product> = {};
  let priceCount = 0;
  let stockCount = 0;
  let failed = false;
  let breakerTripped = false;

  // 上限在这里（花钱的边界）也把一次：调用方多传了商品也不会多花配额。
  // 节点侧 resolvableProducts 已经截过，这里是防御性的第二道。
  for (const product of products.slice(0, MAX_ENRICH_ITEMS)) {
    const skuId = product.id.replace(/^jd-/, '');
    try {
      const livePrice = await priceCache.run(`jd:price:${skuId}`, async () => {
        const data = await callJustOneApi<{ data?: { price?: unknown }[] }>(
          JD_ENDPOINTS.price,
          { itemId: skuId },
          { fetchImpl: options.fetchImpl, sleep: options.sleep, logger: options.logger },
        );
        // 实测形状：{ data: [ { good_id, price } ] }，price 单位是**分**
        const parsed = parseJdPriceFen(data?.data?.[0]?.price);
        // 抛出去 = 不写缓存（下次还会真拉一次），由调用方按「这件没取到」处理
        if (parsed === null) throw new Error('price endpoint returned no parsable price');
        return parsed;
      });
      overrides[product.id] = withLivePrice(product, livePrice);
      priceCount += 1;
    } catch (error) {
      if (isJustOneApiError(error) && tripsBreaker(error)) breakerTripped = true;
      failed = true;
      continue;
    }

    if (!options.withStock) continue;

    try {
      const level = await stockCache.run(`jd:stock:${skuId}`, async () => {
        const detail = await callJustOneApi<{ stock?: { StockState?: unknown } }>(
          JD_ENDPOINTS.detail,
          { itemId: skuId },
          { fetchImpl: options.fetchImpl, sleep: options.sleep, logger: options.logger },
        );
        const parsed = encodeStockLevel(detail?.stock?.StockState);
        if (parsed === null) throw new Error('detail endpoint returned no stock state');
        return parsed;
      });
      const base = overrides[product.id] ?? product;
      overrides[product.id] = withLiveStock(base, level);
      stockCount += 1;
    } catch (error) {
      if (isJustOneApiError(error) && tripsBreaker(error)) breakerTripped = true;
      failed = true;
    }
  }

  return { priceCount, stockCount, breakerTripped, failed, overrides };
}

/** 时间线文案（中性，不喊不叫）：成功与失败两种，均为 tool 级条目 */
function timelineOf(outcome: LiveOutcome, withStock: boolean): string {
  if (outcome.priceCount === 0) return '实时数据不可用，已用快照数据';
  const parts = [`${outcome.priceCount} 件价格`];
  if (withStock) parts.push(`${outcome.stockCount} 件库存`);
  return `补充实时数据 · ${parts.join(' + ')}`;
}

/**
 * 节点主体：**永不抛错**。
 *
 * 「不抛错」是设计而非疏忽：本节点的失败在业务上等价于「没有实时数据」，
 * 主流程（快照数据）仍然照常走完。任何异常都转成时间线上的一条中性记录。
 *
 * 只能有一个入参（`state`）：LangGraph 的节点签名第二参是 Runtime，
 * 加「可选注入项」会与它冲突。要在单测里注入假 fetch，用 `vi.stubGlobal('fetch', …)`
 * 或在更下层直接测 `collectLiveOverrides`（它带注入点）。
 */
export async function enrichLiveDataNode(state: AgentStateValue): Promise<AgentStateUpdate> {
  const startedAt = Date.now();
  const products = resolvableProducts(state);
  const withStock = hasStockKeyword(lastHumanText(state.messages));

  if (products.length === 0) {
    // 条件边已挡住了这种情况；真走到这里也只留空更新，不产生噪音
    return {};
  }

  const outcome = await collectLiveOverrides(products, { withStock });

  if (outcome.breakerTripped) {
    // 配额 / 余额 / 限额类失败：当日不再进入本节点（进程内、按自然日失效）
    tripLiveBreaker();
  }

  const entry = createLogEntry({
    kind: 'tool',
    name: 'enrich_live_data',
    title: timelineOf(outcome, withStock),
    detail: outcome.failed ? '部分商品未取到实时值，已保留快照数据' : undefined,
    status: outcome.failed ? 'error' : 'done',
    startedAt,
  });

  // 全部失败 → overrides 为空，liveOverrides 保持不变（合并型 reducer 收到空对象等于不变）；
  // liveFetchedAt 仍然推进：这一轮确实尝试过了，60 秒冷却对失败同样适用
  return {
    liveOverrides: outcome.overrides,
    liveFetchedAt: Date.now(),
    toolCallLog: [entry],
  };
}