import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_COOLDOWN_MS,
  MAX_ENRICH_ITEMS,
  collectLiveOverrides,
  enrichLiveDataNode,
  resetLiveBreaker,
  resetLiveCache,
  resolvableProducts,
  shouldEnrich,
  shouldEnterEnrichLiveData,
} from '@/lib/agent/nodes/enrichLiveData';
import { mergeLiveOverrides } from '@/lib/agent/state';
import {
  applyLiveOverride,
  hasLiveKeyword,
  hasStockKeyword,
  isResolvableProductId,
  withLivePrice,
  withLiveStock,
} from '@/lib/justoneapi/overrides';
import { checkGrounding } from '@/lib/agent/grounding';
import { makeProduct, makeState } from '@/lib/test-utils/factories';
import type { Product } from '@/lib/types';

/**
 * 实时补充节点的单测：**全部 mock fetch**，不发真实网络请求（项目硬约束）。
 *
 * 覆盖四层：
 *   1. 条件边六条判定（逐条构造「只差这一条」的输入）
 *   2. 覆盖规则（只盖价格与库存等级、划线价一致性、按 id 取值）
 *   3. 节点行为（前 3 件、部分失败、全部失败、熔断、价格模式 vs 库存模式）
 *   4. 与既有链路的衔接（reducer 合并、grounding 认实时价）
 */

const TOKEN = 'tok-secret-for-test-only';
const ORIGINAL_TOKEN = process.env.JUSTONEAPI_TOKEN;

/** 可解析的京东商品（同 justoneapi 目录的 id 形状） */
function jdProduct(id: string, price = 198): Product {
  return makeProduct({ id, name: `商品 ${id}`, price, originalPrice: price + 20 });
}

function envelope(code: number, data: unknown, message = '', status = 200): Response {
  return new Response(JSON.stringify({ code, message, data, recordTime: null }), { status });
}

/** 价格端点实测形状：{ data: [ { good_id, price(分) } ] } */
function priceOk(fen: number): Response {
  return envelope(0, { data: [{ good_id: 'x', price: fen }] });
}

/** 详情端点的库存部分：实测 StockState 33 = 有货 */
function detailOk(stockState = 33): Response {
  return envelope(0, { stock: { StockState: stockState } });
}

function stubFetch(impl: (url: string) => Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: string) => impl(String(url)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  process.env.JUSTONEAPI_TOKEN = TOKEN;
  resetLiveCache();
  resetLiveBreaker();
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.JUSTONEAPI_TOKEN;
  else process.env.JUSTONEAPI_TOKEN = ORIGINAL_TOKEN;
  resetLiveBreaker();
  vi.unstubAllGlobals();
});

describe('关键词与 id 判定', () => {
  it('实时性词表命中（现在 / 多少钱 / 库存 …），闲聊不命中', () => {
    for (const text of ['现在多少钱', '最新报价', '实时价格', '当前有货吗', '会涨价吗', '降价了吗']) {
      expect(hasLiveKeyword(text)).toBe(true);
    }
    expect(hasLiveKeyword('推荐几本小说')).toBe(false);
  });

  it('库存类关键词是子集：只有问到货/库存才额外取详情', () => {
    expect(hasStockKeyword('还有货吗')).toBe(true);
    expect(hasStockKeyword('现在多少钱')).toBe(false);
    expect(hasStockKeyword('多少钱')).toBe(false);
  });

  it('id 可解析规则：jd-数字 通过；ASIN 与非法形状不通过', () => {
    expect(isResolvableProductId('jd-100207440191')).toBe(true);
    expect(isResolvableProductId('amz-B092R6HW7L')).toBe(false);
    expect(isResolvableProductId('jd-abc')).toBe(false);
    expect(isResolvableProductId('jd-123')).toBe(false);
  });
});

describe('条件边六条判定（全部满足才进入）', () => {
  const base = {
    hasToken: true,
    searchResults: [jdProduct('jd-100207440191')],
    userText: '现在多少钱',
    liveFetchedAt: null,
    breakerOpen: false,
    now: 1_000_000,
  };

  it('六条全满足 → 进入', () => {
    expect(shouldEnrich(base)).toBe(true);
  });

  it.each([
    ['① token 未配置', { hasToken: false }],
    ['② 检索结果为空', { searchResults: [] }],
    ['③ 关键词不命中', { userText: '推荐几本小说' }],
    ['④ id 不可解析（默认 real 源的 ASIN）', { searchResults: [makeProduct({ id: 'amz-B092R6HW7L' })] }],
    ['⑤ 冷却中（60 秒内）', { liveFetchedAt: base.now - LIVE_COOLDOWN_MS + 1 }],
    ['⑥ 当日已熔断', { breakerOpen: true }],
  ])('%s → 跳过', (_label, patch) => {
    expect(shouldEnrich({ ...base, ...patch })).toBe(false);
  });

  it('冷却边界：判定是「距上次 > 60 秒」，刚好 60 秒仍算冷却中；冷启动（null）直接通过', () => {
    expect(shouldEnrich({ ...base, liveFetchedAt: base.now - LIVE_COOLDOWN_MS })).toBe(false);
    expect(shouldEnrich({ ...base, liveFetchedAt: base.now - LIVE_COOLDOWN_MS - 1 })).toBe(true);
    expect(shouldEnrich({ ...base, liveFetchedAt: null })).toBe(true);
  });

  it('从状态取输入：ASIN 结果 + 实时性提问 → 跳过（这正是「默认源零行为」的实现方式）', () => {
    const state = makeState({ searchResults: [makeProduct({ id: 'amz-B092R6HW7L' })] });
    expect(shouldEnterEnrichLiveData(state)).toBe(false);
  });

  it('从状态取输入：jd- 商品 + 「现在多少钱」+ 有 token → 进入', () => {
    const state = makeState({ searchResults: [jdProduct('jd-100207440191')] });
    state.messages = state.messages.concat({
      getType: () => 'human',
      content: '现在多少钱',
    } as never);
    expect(shouldEnterEnrichLiveData(state)).toBe(true);
  });
});

describe('覆盖规则（只盖价格与库存等级）', () => {
  it('withLivePrice：价格被替换、其余字段保留、金额取两位小数', () => {
    const base = jdProduct('jd-1', 198);
    const overridden = withLivePrice(base, 176.666);
    expect(overridden.price).toBe(176.67);
    expect(overridden.name).toBe(base.name);
    expect(overridden.rating).toBe(base.rating);
    expect(overridden.reviews).toBe(base.reviews);
    expect(overridden.sales).toBe(base.sales);
  });

  it('划线价一致性：实时价高于原划线价时，划线价同步为新价（避免「划线价低于现价」破图）', () => {
    const base = makeProduct({ price: 100, originalPrice: 110 });
    expect(withLivePrice(base, 105).originalPrice).toBe(110);
    expect(withLivePrice(base, 120).originalPrice).toBe(120);
  });

  it('withLiveStock：只改库存等级代表值', () => {
    const overridden = withLiveStock(jdProduct('jd-1'), 0);
    expect(overridden.stock).toBe(0);
    expect(overridden.price).toBe(198);
  });

  it('applyLiveOverride：按 id 取值，无覆盖时返回原对象（引用不变）', () => {
    const product = jdProduct('jd-1');
    expect(applyLiveOverride(product, undefined)).toBe(product);
    expect(applyLiveOverride(product, {})).toBe(product);
    const override = withLivePrice(product, 150);
    expect(applyLiveOverride(product, { 'jd-1': override })).toBe(override);
  });
});

describe('节点行为', () => {
  const products = [
    jdProduct('jd-100000000001'),
    jdProduct('jd-100000000002'),
    jdProduct('jd-100000000003'),
    jdProduct('jd-100000000004'),
  ];

  it('最多只拉前 3 件，保留原顺序', async () => {
    const mock = stubFetch(() => priceOk(19800));
    const outcome = await collectLiveOverrides(products, { withStock: false });

    expect(mock).toHaveBeenCalledTimes(MAX_ENRICH_ITEMS);
    expect(Object.keys(outcome.overrides)).toEqual([
      'jd-100000000001',
      'jd-100000000002',
      'jd-100000000003',
    ]);
    expect(outcome.priceCount).toBe(3);
    expect(outcome.stockCount).toBe(0);
  });

  it('resolvableProducts：过滤掉不可解析的 id（ASIN），且只取前 3 件', () => {
    const mixed = [makeProduct({ id: 'amz-B092R6HW7L' }), ...products];
    expect(resolvableProducts(makeState({ searchResults: mixed }))).toHaveLength(3);
    expect(resolvableProducts(makeState({ searchResults: mixed }))[0]?.id).toBe(
      'jd-100000000001',
    );
  });

  it('价格端点返回分：19800 → 198（与搜索端点同一商品的展示价一致）', async () => {
    stubFetch(() => priceOk(19800));
    const outcome = await collectLiveOverrides([jdProduct('jd-100000000001', 999)], {
      withStock: false,
    });
    expect(outcome.overrides['jd-100000000001']?.price).toBe(198);
  });

  it('部分失败：成功的写入、失败的跳过，不抛错', async () => {
    stubFetch((url) => {
      // 第二件 404（永久错误、不重试），其余正常
      if (url.includes('itemId=100000000002')) return envelope(404, null, 'Resource not found', 404);
      return priceOk(15000);
    });

    const outcome = await collectLiveOverrides(products, { withStock: false });
    expect(outcome.priceCount).toBe(2);
    expect(outcome.overrides['jd-100000000002']).toBeUndefined();
    expect(outcome.failed).toBe(true);
    expect(outcome.breakerTripped).toBe(false);
  });

  it('全部失败：overrides 为空（节点返回空更新），不抛错', async () => {
    stubFetch(() => envelope(100, null, 'TOKEN INVALID/UNACTIVATE', 401));
    const outcome = await collectLiveOverrides(products, { withStock: false });
    expect(outcome.priceCount).toBe(0);
    expect(outcome.overrides).toEqual({});
    expect(outcome.failed).toBe(true);
  });

  it('命中 303 时标记熔断；随后条件边不再进入', async () => {
    stubFetch(() => envelope(303, null, 'DAILY LIMIT', 429));
    const outcome = await collectLiveOverrides([jdProduct('jd-100000000001')], {
      withStock: false,
    });
    expect(outcome.breakerTripped).toBe(true);

    const state = makeState({ searchResults: [jdProduct('jd-100000000001')] });
    const update = await enrichLiveDataNode(state);
    expect(update.liveFetchedAt).toBeDefined();

    // 节点跑过之后熔断已落闸：条件边判定必须为 false（同进程内不再进入）
    expect(
      shouldEnrich({
        hasToken: true,
        searchResults: [jdProduct('jd-100000000001')],
        userText: '现在多少钱',
        liveFetchedAt: null,
        breakerOpen: true,
        now: Date.now(),
      }),
    ).toBe(false);
  });

  it('库存模式：价格与详情各调一次；详情失败时只保留价格覆盖', async () => {
    const mock = stubFetch((url) => {
      if (url.includes('get-item-detail')) {
        if (url.includes('itemId=100000000003')) return envelope(404, null, 'not found', 404);
        return detailOk(33);
      }
      return priceOk(19800);
    });

    const outcome = await collectLiveOverrides(products.slice(0, 3), { withStock: true });
    expect(mock).toHaveBeenCalledTimes(6); // 3 次价格 + 3 次详情
    expect(outcome.priceCount).toBe(3);
    expect(outcome.stockCount).toBe(2);
    expect(outcome.overrides['jd-100000000003']?.stock).toBe(
      products[2]?.stock,
    );
  });

  it('节点：成功一轮写 liveOverrides / liveFetchedAt / 时间线（中性文案）', async () => {
    stubFetch(() => priceOk(19800));
    const state = makeState({ searchResults: products.slice(0, 2) });
    const update = await enrichLiveDataNode(state);
    const entry = Array.isArray(update.toolCallLog) ? update.toolCallLog[0] : undefined;

    expect(Object.keys(update.liveOverrides ?? {})).toHaveLength(2);
    expect(update.liveFetchedAt).toBeGreaterThan(0);
    expect(entry?.title).toBe('补充实时数据 · 2 件价格');
    expect(entry?.status).toBe('done');
    expect(entry?.kind).toBe('tool');
  });

  it('节点：全部失败 → 空覆盖 + 中性记录 + 不抛错', async () => {
    stubFetch(() => envelope(100, null, 'TOKEN INVALID/UNACTIVATE', 401));
    const state = makeState({ searchResults: products.slice(0, 2) });
    const update = await enrichLiveDataNode(state);
    const entry = Array.isArray(update.toolCallLog) ? update.toolCallLog[0] : undefined;

    expect(update.liveOverrides).toEqual({});
    expect(entry?.title).toBe('实时数据不可用，已用快照数据');
    expect(entry?.status).toBe('error');
  });

  it('节点：没有可解析商品时返回空更新（不产生噪音日志）', async () => {
    const mock = stubFetch(() => priceOk(19800));
    const update = await enrichLiveDataNode(
      makeState({ searchResults: [makeProduct({ id: 'amz-B092R6HW7L' })] }),
    );
    expect(update).toEqual({});
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('liveOverrides reducer：多轮合并且不污染无关商品', () => {
  it('合并型：第二轮只改自己覆盖的商品，第一轮的覆盖仍在', () => {
    const first = { 'jd-1': withLivePrice(jdProduct('jd-1', 100), 90) };
    const second = { 'jd-2': withLivePrice(jdProduct('jd-2', 200), 180) };
    const merged = mergeLiveOverrides(first, second);
    expect(Object.keys(merged).sort()).toEqual(['jd-1', 'jd-2']);
    expect(merged['jd-1']?.price).toBe(90);
  });

  it('同一商品再覆盖以最新为准；空更新不改变已有覆盖', () => {
    const first = { 'jd-1': withLivePrice(jdProduct('jd-1', 100), 90) };
    expect(mergeLiveOverrides(first, { 'jd-1': withLivePrice(jdProduct('jd-1', 100), 80) })['jd-1']?.price).toBe(80);
    expect(mergeLiveOverrides(first, {})).toEqual(first);
  });
});

describe('与 grounding 的衔接：实时价必须被认作真实数据', () => {
  const snapshot = makeProduct({ id: 'jd-100000000001', price: 198, originalPrice: 218 });

  it('覆盖后的价格在已知金额里（截图：不登记就会被自己的校验判成编造）', () => {
    const overridden = withLivePrice(snapshot, 176);
    const withLive = makeState({
      searchResults: [snapshot],
      liveOverrides: { [snapshot.id]: overridden },
    });
    expect(checkGrounding('这款现在 ¥176', withLive).grounded).toBe(true);

    const withoutLive = makeState({ searchResults: [snapshot] });
    const result = checkGrounding('这款现在 ¥176', withoutLive);
    expect(result.grounded).toBe(false);
    expect(result.unknownAmounts).toContain(176);
  });

  it('快照原价仍然有效（覆盖只改价格，不改其它口径）', () => {
    const overridden = withLivePrice(snapshot, 176);
    const state = makeState({
      searchResults: [snapshot],
      liveOverrides: { [snapshot.id]: overridden },
    });
    expect(checkGrounding('现价 ¥176，原价 ¥218', state).grounded).toBe(true);
  });
});