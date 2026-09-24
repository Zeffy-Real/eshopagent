import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isProductLike as isProductLikeTs } from '@/lib/catalog/products';
import { isProductLike as isProductLikeMjs } from '@/scripts/catalog-shared.mjs';
import {
  encodeStockLevel,
  parseJdPriceFen,
  parseJdPriceYuan,
  resolveJdCategory,
  toJdImageUrl,
} from '@/lib/justoneapi/platforms/jd.mjs';
import {
  buildJustoneapiCatalog,
  buildPayload,
  normalizeJdProduct,
  writeJsonAtomically,
} from '@/scripts/sources/justoneapi.mjs';

/**
 * 京东实时源的单测：**全部 mock fetch**，不发真实网络请求（项目硬约束）。
 *
 * 夹具是实测响应的**逐字段摘录**（原始响应存于 .cache/justoneapi-probe/，不进仓库）：
 *   - 搜索条目：/api/jd/search-item-list/v1?keyword=耳机 的第 1 件（id 100207440191）
 *   - 详情：/api/jd/get-item-detail/v1?itemId=100207440191
 * 字段名与取值都照抄实测，避免「用自造夹具验证自造映射」的空转。
 */

const TOKEN = 'tok-secret-for-test-only';
const ORIGINAL_TOKEN = process.env.JUSTONEAPI_TOKEN;

/** 实测摘录：搜索条目（原响应 48 件里的第 1 件） */
const SEARCH_ITEM = {
  id: '100207440191',
  title:
    'Viken【2026最新款丨柏林之声第1名】骨传导蓝牙耳机耳夹式概念无线开放式运动跑步超长续航不入耳挂耳',
  price: '198.00',
  imageUrl: 'jfs/t1/528727/28/4600/117062/6aaf4700F357ff9f3/0083320320641c06.jpg',
  cid1: '652',
  cid2: '828',
  cid3: '842',
  shopName: '维肯（Viken）京东自营旗舰店',
};

/** 实测摘录：详情（只保留用到的字段，值照抄） */
const DETAIL = {
  product: {
    skuId: '100207440191',
    skuName: SEARCH_ITEM.title,
    brandName: '维肯（Viken）',
    cBrand: '维肯（Viken）',
    cid1: '652',
    cid2: '828',
    cid3: '842',
    category: '652,828,842',
    model: 'i113',
    weight: '0.182',
    length: '107',
    width: '107',
    height: '52',
    wserve: '1年质保',
    upc: '6941463424375;6979854450061;6979854453161',
    mainImages: [
      'https://img30.360buyimg.com/sku/jfs/t1/528727/28/4600/117062/6aaf4700F357ff9f3/0083320320641c06.jpg',
      'https://img30.360buyimg.com/sku/jfs/t1/527484/9/5338/125141/6aaf470eF4ad0fb9c/0083320320ea2f12.jpg',
    ],
  },
  stock: { skuId: '100207440191', StockState: 33, preStore: 10 },
};

function envelope(code: number, data: unknown, message = ''): string {
  return JSON.stringify({ code, message, data, recordTime: null });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

/** 假的 fetch：搜索返回 2 件（1 件 cid 可映射、1 件不可映射），详情返回实测形状 */
function mockFetch(searchItems: unknown[] = [SEARCH_ITEM]) {
  return vi.fn(async (url: string) => {
    if (url.includes('/search-item-list/')) {
      return jsonResponse(envelope(0, { products: searchItems, totalCount: searchItems.length }));
    }
    if (url.includes('/get-item-detail/')) {
      return jsonResponse(envelope(0, DETAIL));
    }
    return jsonResponse(envelope(404, null), 404);
  });
}

beforeEach(() => {
  process.env.JUSTONEAPI_TOKEN = TOKEN;
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.JUSTONEAPI_TOKEN;
  else process.env.JUSTONEAPI_TOKEN = ORIGINAL_TOKEN;
  vi.restoreAllMocks();
});

describe('resolveJdCategory：cid 链 → 项目 7 品类', () => {
  const HITS: [string, string][] = [
    ['652', '数码'],
    ['1315', '服饰'],
    ['1672', '服饰'],
    ['1316', '美妆'],
    ['1713', '图书'],
    ['6196', '家居'],
    ['1318', '运动'],
    ['36574', '食品'],
  ];

  it.each(HITS)('cid1=%s → %s', (cid1, category) => {
    expect(resolveJdCategory(cid1, '828', '842')).toBe(category);
  });

  it('实测过的三级链（652/828/842）落在数码', () => {
    expect(resolveJdCategory('652', '828', '842')).toBe('数码');
  });

  it('刻意不映射的 11729（鞋子/鞋靴）返回 null，由调用方丢弃', () => {
    expect(resolveJdCategory('11729', '11730', '6908')).toBeNull();
  });

  it('空值与未知 cid 一律 null，不猜', () => {
    expect(resolveJdCategory(undefined, undefined, undefined)).toBeNull();
    expect(resolveJdCategory(null, null, null)).toBeNull();
    expect(resolveJdCategory('999999', '', '')).toBeNull();
  });
});

describe('价格解析：元与分两条路径', () => {
  it('搜索端点：`"198.00"`（元字符串）→ 198', () => {
    expect(parseJdPriceYuan('198.00')).toBe(198);
    expect(parseJdPriceYuan(15.9)).toBe(15.9);
    expect(parseJdPriceYuan('  89.90 ')).toBe(89.9);
  });

  it('价格端点：`19800`（分）→ 198（与搜索端点同一商品的价格一致）', () => {
    expect(parseJdPriceFen(19800)).toBe(198);
    expect(parseJdPriceFen('19800')).toBe(198);
    expect(parseJdPriceFen(1)).toBe(0.01);
  });

  it('缺失 / 非法 / 非正数一律 null', () => {
    for (const bad of ['', 'null', 'abc', null, undefined, 0, -5, Number.NaN]) {
      expect(parseJdPriceYuan(bad)).toBeNull();
      expect(parseJdPriceFen(bad)).toBeNull();
    }
  });
});

describe('encodeStockLevel：京东库存状态码 → 等级代表值', () => {
  it.each([
    [33, 40],
    [39, 40],
    [40, 40],
    [36, 10],
    [34, 0],
  ])('StockState %i → %i', (state, level) => {
    expect(encodeStockLevel(state)).toBe(level);
  });

  it('未知码 / 缺失返回 null（调用方不得据此判缺货）', () => {
    expect(encodeStockLevel(0)).toBeNull();
    expect(encodeStockLevel(999)).toBeNull();
    expect(encodeStockLevel(undefined)).toBeNull();
    expect(encodeStockLevel('')).toBeNull();
  });
});

describe('toJdImageUrl：相对路径补前缀', () => {
  it('搜索端点的相对路径拼上图片前缀', () => {
    expect(toJdImageUrl('jfs/t1/abc.jpg')).toBe('https://img30.360buyimg.com/sku/jfs/t1/abc.jpg');
  });

  it('详情端点的完整 URL 原样返回；空值返回空串', () => {
    const absolute = DETAIL.product.mainImages[0];
    expect(toJdImageUrl(absolute)).toBe(absolute);
    expect(toJdImageUrl('')).toBe('');
    expect(toJdImageUrl(undefined)).toBe('');
  });
});

describe('normalizeJdProduct：搜索 + 详情 → Product', () => {
  it('实测夹具映射出完整商品（价格来自搜索、品牌/图片/库存来自详情）', () => {
    const { product } = normalizeJdProduct({ search: SEARCH_ITEM, detail: DETAIL });
    expect(product).toBeDefined();
    if (!product) throw new Error('应当映射成功');

    expect(product.id).toBe('jd-100207440191');
    expect(product.category).toBe('数码');
    expect(product.price).toBe(198);
    // 源里没有划线价：按现有兜底与现价相同
    expect(product.originalPrice).toBe(198);
    expect(product.brand).toBe('维肯（Viken）');
    expect(product.image).toBe(DETAIL.product.mainImages[0]);
    // 33 = 现货 → 等级代表值 40（有货），不是件数
    expect(product.stock).toBe(40);
    // 评分/评论数/销量：京东这两个端点没有可用字段 → 记 0
    expect(product.rating).toBe(0);
    expect(product.reviews).toBe(0);
    expect(product.sales).toBe(0);
    expect(product.description.length).toBeGreaterThan(0);
    expect(product.specifications.型号).toBe('i113');
    expect(product.specifications.品牌).toBeUndefined();
    // 平台附加字段（Product 模型之外）：真实目录同样带 platform/sourceId/sourceUrl
    expect((product as { sourceUrl?: string }).sourceUrl).toBe(
      'https://item.jd.com/100207440191.html',
    );
  });

  it('类目以详情为准（详情 cid 是商品自身的类目，比搜索列表更权威）', () => {
    const outcome = normalizeJdProduct({
      search: { ...SEARCH_ITEM, cid1: '36574', cid2: '36824', cid3: '37169' },
      detail: DETAIL, // 详情里是 652/828/842
    });
    expect(outcome.product?.category).toBe('数码');
  });

  it('cid 映射不到 → 丢弃并给出原因（搜索与详情的 cid 都不可映射）', () => {
    const outcome = normalizeJdProduct({
      search: { ...SEARCH_ITEM, cid1: '11729', cid2: '11730', cid3: '6908' },
      detail: {
        product: { ...DETAIL.product, cid1: '11729', cid2: '11730', cid3: '6908' },
        stock: DETAIL.stock,
      },
    });
    expect(outcome.product).toBeUndefined();
    expect(outcome.skip).toBe('cid 未映射到项目品类');
  });

  it('价格越界 → 丢弃（沿用 10 ≤ price ≤ 20000）', () => {
    expect(normalizeJdProduct({ search: { ...SEARCH_ITEM, price: '5.00' }, detail: DETAIL }).skip).toBe(
      '价格越界',
    );
    expect(
      normalizeJdProduct({ search: { ...SEARCH_ITEM, price: '99999.00' }, detail: DETAIL }).skip,
    ).toBe('价格越界');
  });

  it('价格缺失 → 丢弃；标题为空 → 丢弃', () => {
    expect(normalizeJdProduct({ search: { ...SEARCH_ITEM, price: '' }, detail: DETAIL }).skip).toBe(
      '价格缺失或非法',
    );
    expect(
      normalizeJdProduct({
        search: { ...SEARCH_ITEM, title: '' },
        detail: { product: { ...DETAIL.product, skuName: '' }, stock: DETAIL.stock },
      }).skip,
    ).toBe('标题为空');
  });

  it('库存状态码缺失 → 用与 HF 快照同一条派生规则（界面只显示等级）', () => {
    const outcome = normalizeJdProduct({
      search: SEARCH_ITEM,
      detail: { product: DETAIL.product, stock: { skuId: '100207440191' } },
    });
    expect(outcome.stockDerived).toBe(true);
    expect(outcome.product?.stock).toBeGreaterThan(20); // 派生件数 → stockLevelOf 判为有货
  });

  it('品牌缺失 → 用平台名兜底并标记（统计里单独计数）', () => {
    const outcome = normalizeJdProduct({
      search: SEARCH_ITEM,
      detail: { product: { ...DETAIL.product, brandName: '', cBrand: '' }, stock: DETAIL.stock },
    });
    expect(outcome.brandFallback).toBe(true);
    expect(outcome.product?.brand).toBe('京东');
  });
});

describe('isProductLike：脚本侧镜像实现与 TS 侧语义一致', () => {
  const CASES: unknown[] = [
    { id: 'jd-1', name: 'n', brand: 'b', image: 'https://x/1.jpg', description: 'd', price: 10, rating: 0, category: '数码' },
    { id: 'jd-2', name: 'n', brand: 'b', image: 'https://x/1.jpg', description: '', price: 10, rating: 0, category: '数码' },
    { id: 'jd-3', name: '', brand: 'b', image: 'https://x/1.jpg', description: 'd', price: 10, rating: 0, category: '数码' },
    { id: 'jd-4', name: 'n', brand: 'b', image: 'https://x/1.jpg', description: 'd', price: Number.NaN, rating: 0, category: '数码' },
    { id: 'jd-5', name: 'n', brand: 'b', image: 'https://x/1.jpg', description: 'd', price: 0, rating: 0, category: '数码' },
    { id: 'jd-6', name: 'n', brand: 'b', image: 'https://x/1.jpg', description: 'd', price: 10, rating: 5.1, category: '数码' },
    { id: 'jd-7', name: 'n', brand: 'b', image: 'https://x/1.jpg', description: 'd', price: 10, rating: 0, category: '不存在' },
    { id: 'jd-8', name: 'n', brand: 'b', image: 'https://x/1.jpg', description: 'd', price: '10', rating: 0, category: '数码' },
    null,
    undefined,
    'not-an-object',
    [],
  ];

  it.each(CASES.map((value, index) => [index, value] as const))(
    '用例 %i：两侧判定相同',
    (_index, value) => {
      expect(isProductLikeMjs(value)).toBe(isProductLikeTs(value));
    },
  );

  it('镜像实现确实会拦下非法值（不是「两边都恒真」）', () => {
    expect(isProductLikeMjs(CASES[1])).toBe(false);
    expect(isProductLikeMjs(CASES[3])).toBe(false);
    expect(isProductLikeMjs(CASES[0])).toBe(true);
  });
});

describe('buildJustoneapiCatalog：mock 响应 → 完整产物结构', () => {
  const onlyDigital: Record<string, string[]> = { 数码: ['耳机'] };

  it('搜索 → 详情 → 归一化，统计与配额对得上', async () => {
    const fetchImpl = mockFetch([
      SEARCH_ITEM,
      { ...SEARCH_ITEM, id: '999', cid1: '11729', cid2: '11730', cid3: '6908' },
    ]);

    const { products, stats } = await buildJustoneapiCatalog({
      keywords: onlyDigital,
      perCategory: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      logger: () => {},
      log: () => {},
    });

    // 不可映射的那件在搜索阶段就被丢弃，因此只补 1 次详情
    expect(products).toHaveLength(1);
    expect(products[0]?.id).toBe('jd-100207440191');
    expect(stats.candidates).toBe(2);
    expect(stats.dropped.get('cid 未映射到项目品类')).toBe(1);
    expect(stats.quota).toBe(2); // 1 次搜索 + 1 次详情（成功才计费）
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('每品类只取前 perCategory 件（配额保护）', async () => {
    const items = [1, 2, 3, 4, 5].map((n) => ({ ...SEARCH_ITEM, id: `10020744019${n}` }));
    const fetchImpl = mockFetch(items);

    const { products, stats } = await buildJustoneapiCatalog({
      keywords: onlyDigital,
      perCategory: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      logger: () => {},
      log: () => {},
    });

    expect(products).toHaveLength(2);
    expect(stats.candidates).toBe(5);
    expect(stats.detailCalls.total).toBe(2);
    expect(stats.quota).toBe(3); // 1 次搜索 + 2 次详情
  });

  it('配额用尽（code 303）→ 中止整个构建，不返回半成品', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(envelope(303, null, 'DAILY LIMIT'), 429));

    await expect(
      buildJustoneapiCatalog({
        keywords: onlyDigital,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => {},
        logger: () => {},
        log: () => {},
      }),
    ).rejects.toMatchObject({ kind: 'quota_exceeded' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 303 不重试
  });

  it('单条商品的失败（404）只丢这一件，不中止构建', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/search-item-list/')) {
        return jsonResponse(envelope(0, { products: [SEARCH_ITEM] }));
      }
      return jsonResponse(envelope(404, null, 'Resource not found'), 404);
    });

    const { products, stats } = await buildJustoneapiCatalog({
      keywords: onlyDigital,
      perCategory: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      logger: () => {},
      log: () => {},
    });

    expect(products).toHaveLength(0);
    expect(stats.dropped.get('详情未取到（无法确认品牌/库存）')).toBe(1);
    expect(stats.detailCalls.failed).toBe(1);
  });
});

describe('writeJsonAtomically：失败不替换、成功原子生效', () => {
  it('成功：内容被替换', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jd-catalog-'));
    const outPath = join(dir, 'catalog.json');
    await writeFile(outPath, '{"count":0}', 'utf8');

    await writeJsonAtomically(outPath, { count: 7, products: [] });

    const written = JSON.parse(await readFile(outPath, 'utf8')) as { count: number };
    expect(written.count).toBe(7);
  });

  it('失败：上一版产物原样保留（tmp 未落地为正式文件）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jd-catalog-'));
    const outPath = join(dir, 'catalog.json');
    const previous = '{"count":3}';
    await writeFile(outPath, previous, 'utf8');

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(writeJsonAtomically(outPath, circular)).rejects.toThrow();
    expect(await readFile(outPath, 'utf8')).toBe(previous);
  });
});

describe('buildPayload：真实性边界写准', () => {
  it('明确写出「评分/评论数/销量无可用字段」而不是含糊其辞', () => {
    const stats = {
      quota: 0,
      searches: { total: 0, failed: 0 },
      detailCalls: { total: 0, failed: 0 },
      candidates: 0,
      detailUsed: 0,
      brandFallback: 0,
      stockDerived: 2,
      dropped: new Map<string, number>(),
      byCategory: new Map<string, { candidates: number; kept: number }>(),
    };
    const payload = buildPayload([], stats);
    expect(payload.status).toBe('ok');
    expect(payload.platforms).toEqual(['京东']);
    expect(String(payload.note)).toContain('评分、评论数、销量、划线价');
    expect(String(payload.note)).toContain('2 件商品未给出库存状态码');
    expect(payload.count).toBe(0);
  });
});