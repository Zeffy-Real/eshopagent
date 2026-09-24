#!/usr/bin/env node
/**
 * 京东实时商品源（构建期可选源）
 *
 * 用法：
 *   node --env-file=.env.local scripts/build-real-catalog.mjs --source=justoneapi [--per=14]
 *   node --env-file=.env.local scripts/sources/justoneapi.mjs [--per=14]   # 等价，直接跑本文件
 *
 * 产物写到 `data/justoneapi-catalog.json`（**不碰** `data/real-catalog.json`），
 * 用 `tmp + rename` 原子替换：构建失败时上一版产物原样保留。
 *
 * 取数口径（全部来自实测，见 docs/justoneapi-design.md §2/§3/§4）：
 *   价格 ← 搜索端点（`price` 是精确售价字符串；详情端点同字段实测被打码为 `"1??"`）
 *   品牌 / 图片 / 库存等级 / 参数 ← 详情端点
 *   评分 / 评论数 / 销量 / 划线价 / 描述 ← **京东这两个端点里都没有**，一律记 0/空
 *
 * 失败语义：单条商品的失败（采集失败重试后仍失败、404、参数错）→ 丢弃该条并计数；
 * 配额用尽（303）/ 余额不足（601）/ 限额（602）/ token 无效（100、101）→ **中止整个构建**，
 * 不写产物。判定用的是 lib/justoneapi/codes.mjs（与运行时同一份码表）。
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CATEGORIES,
  CURRENCY_TO_CNY,
  PRICE_CNY_MAX,
  PRICE_CNY_MIN,
  clean,
  deriveStock,
  isProductLike,
  perCategoryFromArgv,
  truncate,
} from '../catalog-shared.mjs';
import { callJustOneApi, hasJustOneApiToken } from '../../lib/justoneapi/client.mjs';
import { isJustOneApiError, tripsBreaker } from '../../lib/justoneapi/errors.mjs';
import {
  JD_ENDPOINTS,
  encodeStockLevel,
  parseJdPriceYuan,
  resolveJdCategory,
  toJdImageUrl,
} from '../../lib/justoneapi/platforms/jd.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUTPUT_PATH = resolve(HERE, '../../data/justoneapi-catalog.json');

/**
 * 关键词表：从项目 7 品类派生，每个品类 2 个中文词。
 *
 * 选词依据：都是「品类里最典型的搜索词」，保证京东搜索结果能填满每个品类；
 * 实测（§15.5）每个词都能返回 48 件、类目链稳定落在该品类的 cid 上。
 * 关键词数量直接决定搜索调用数（7 品类 × 2 词 = 14 次成功调用计费），
 * 因此不做「一词多品类」的扩张。
 */
export const CATEGORY_KEYWORDS = {
  数码: ['蓝牙耳机', '移动电源'],
  服饰: ['连衣裙', '男士夹克'],
  食品: ['坚果', '咖啡豆'],
  家居: ['保温杯', '收纳箱'],
  运动: ['跑步鞋', '瑜伽垫'],
  美妆: ['面膜', '口红'],
  图书: ['小说', '儿童绘本'],
};

/** 致命失败：继续跑只会重复失败的（配额 / 余额 / 限额 / token 无效 / 未配置） */
function isFatal(error) {
  if (!isJustOneApiError(error)) return false;
  return (
    tripsBreaker(error) ||
    error.kind === 'token_invalid' ||
    error.kind === 'token_missing'
  );
}

/**
 * 把「搜索条目 + 详情」归一化成 Product（纯函数，单测直接喂实测夹具）。
 *
 * 只做映射与校验，不发请求；返回 `{ product }` 或 `{ skip: 原因 }`。
 * 丢弃原因会按原因分类进构建统计——这是「按行丢弃」策略在实时源上的延续。
 */
export function normalizeJdProduct({ search, detail }) {
  const skuId = clean(String(search?.id ?? detail?.product?.skuId ?? ''));
  if (skuId === '') return { skip: '缺少商品 ID' };

  const cid1 = detail?.product?.cid1 ?? search?.cid1;
  const cid2 = detail?.product?.cid2 ?? search?.cid2;
  const cid3 = detail?.product?.cid3 ?? search?.cid3;
  const category = resolveJdCategory(cid1, cid2, cid3);
  if (category === null) return { skip: 'cid 未映射到项目品类' };

  const price = parseJdPriceYuan(search?.price);
  if (price === null) return { skip: '价格缺失或非法' };
  if (price < PRICE_CNY_MIN || price > PRICE_CNY_MAX) return { skip: '价格越界' };

  const name = truncate(clean(String(detail?.product?.skuName ?? search?.title ?? '')), 60);
  if (name === '') return { skip: '标题为空' };

  const brandRaw = clean(String(detail?.product?.brandName ?? detail?.product?.cBrand ?? ''));
  const brand = brandRaw === '' ? '京东' : brandRaw;

  const image = toJdImageUrl(detail?.product?.mainImages?.[0] ?? search?.imageUrl ?? '');
  if (image === '') return { skip: '主图为空' };

  // 库存等级：真实信号优先；没有信号时用与 HF 快照同一条派生规则（界面只显示等级）
  const stockLevel = encodeStockLevel(detail?.stock?.StockState);
  const stock = stockLevel === null ? deriveStock(skuId) : stockLevel;

  const weight = clean(String(detail?.product?.weight ?? ''));
  const dimensions = [detail?.product?.length, detail?.product?.width, detail?.product?.height]
    .map((value) => clean(String(value ?? '')))
    .filter((value) => value !== '')
    .join(' × ');
  const warranty = clean(String(detail?.product?.wserve ?? ''));
  const model = clean(String(detail?.product?.model ?? ''));
  const upc = clean(String(detail?.product?.upc ?? '')).split(';')[0] ?? '';

  // 注意：不放「品牌」——对比表已有固定的品牌行，重复会让表格出现两行同名参数
  const specifications = {};
  const put = (key, value) => {
    if (value !== '') specifications[key] = truncate(value, 40);
  };
  put('类目', category);
  put('型号', model);
  put('重量', weight === '' ? '' : `${weight} kg`);
  put('尺寸', dimensions === '' ? '' : `${dimensions} mm`);
  put('质保', warranty);
  put('UPC', upc);

  // 京东这两个端点都没有商品描述字段；按既有「图书简介为派生文案」的先例，
  // 用真实字段拼一句可读文案，而不是留空（留空会让运行时校验把商品整条丢弃）
  const descriptionParts = [brand, model === '' ? '' : `型号 ${model}`, weight === '' ? '' : `重量 ${weight}kg`];
  if (warranty !== '') descriptionParts.push(warranty);
  descriptionParts.push(`所属类目：${category}`);
  const description = truncate(descriptionParts.filter((part) => part !== '').join('｜'), 200);

  const product = {
    id: `jd-${skuId}`,
    name,
    brand,
    category,
    price,
    // 京东搜索/详情都没有划线价字段（`lowestPrice` 实测是标记位、`jdpriceRange`/`priceTag` 为空串）
    originalPrice: price,
    // 评分 / 评论数 / 销量：京东搜索与详情端点均无可用字段（实测为空串或区间文案）
    rating: 0,
    reviews: 0,
    sales: 0,
    stock,
    image,
    description,
    specifications,
    tags: [],
    platform: '京东',
    sourceId: skuId,
    sourceUrl: `https://item.jd.com/${skuId}.html`,
  };

  return { product, brandFallback: brandRaw === '', stockDerived: stockLevel === null };
}

/** 原子写入：先写临时文件再 rename。失败时目标文件保持原样（上一版产物不会被破坏） */
export async function writeJsonAtomically(outPath, payload) {
  const tmpPath = `${outPath}.tmp`;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmpPath, outPath);
}

function createStats() {
  return {
    /** 成功调用次数 = 计费次数（失败不计费） */
    quota: 0,
    searches: { total: 0, failed: 0 },
    detailCalls: { total: 0, failed: 0 },
    candidates: 0,
    detailUsed: 0,
    brandFallback: 0,
    stockDerived: 0,
    dropped: new Map(),
    byCategory: new Map(CATEGORIES.map((category) => [category, { candidates: 0, kept: 0 }])),
  };
}

function bump(map, key, delta = 1) {
  map.set(key, (map.get(key) ?? 0) + delta);
}

/**
 * 拉取并归一化全量商品（不发请求的注入点留给单测：`fetchImpl` / `sleep`）。
 *
 * 返回 `{ products, stats }`；**不写文件**（写盘由调用方决定，便于单测）。
 */
export async function buildJustoneapiCatalog(options = {}) {
  const keywords = options.keywords ?? CATEGORY_KEYWORDS;
  const perCategory = options.perCategory ?? 14;
  const log = options.log ?? (() => {});
  const callOptions = { fetchImpl: options.fetchImpl, sleep: options.sleep, logger: options.logger };
  const stats = createStats();

  /** 单次调用：成功计配额并返回数据；致命失败直接抛出（中止构建），其余失败返回 null */
  const call = async (endpoint, params, label) => {
    try {
      const data = await callJustOneApi(endpoint, params, callOptions);
      stats.quota += 1;
      return data;
    } catch (error) {
      if (isFatal(error)) throw error;
      if (isJustOneApiError(error)) {
        bump(stats.dropped, `请求失败（code ${error.code ?? error.kind}）`);
        log(`  × ${label}：${error.message}`);
        return null;
      }
      throw error;
    }
  };

  // ① 逐品类搜索，收集候选（按 id 去重，价格与类目先筛掉明摆着不合格的）
  const candidates = new Map();
  for (const category of CATEGORIES) {
    for (const keyword of keywords[category] ?? []) {
      stats.searches.total += 1;
      log(`[搜索] ${category} ·「${keyword}」`);
      const data = await call(JD_ENDPOINTS.search, { keyword, page: 1 }, `搜索「${keyword}」`);
      if (!data) {
        stats.searches.failed += 1;
        continue;
      }
      const items = Array.isArray(data.products) ? data.products : [];
      for (const item of items) {
        const id = clean(String(item?.id ?? ''));
        if (id === '' || candidates.has(id)) continue;
        stats.candidates += 1;
        if (parseJdPriceYuan(item.price) === null) {
          bump(stats.dropped, '价格缺失或非法');
          continue;
        }
        const resolved = resolveJdCategory(item.cid1, item.cid2, item.cid3);
        if (resolved === null) {
          bump(stats.dropped, 'cid 未映射到项目品类');
          continue;
        }
        candidates.set(id, { search: item, category: resolved });
        const bucketStat = stats.byCategory.get(resolved);
        if (bucketStat) bucketStat.candidates += 1;
      }
      log(`  命中 ${items.length} 件，累计候选 ${candidates.size} 件`);
    }
  }

  // ② 按 cid 判定的品类分桶，每桶取前 perCategory 件（顺序 = 京东搜索的相关度顺序）
  const buckets = new Map(CATEGORIES.map((category) => [category, []]));
  const kept = new Map(CATEGORIES.map((category) => [category, []]));
  for (const candidate of candidates.values()) {
    buckets.get(candidate.category)?.push(candidate);
  }
  for (const category of CATEGORIES) {
    const bucket = buckets.get(category) ?? [];
    const selected = bucket.slice(0, perCategory);
    log(`[详情] ${category}：候选 ${bucket.length} → 取前 ${selected.length} 件补详情`);

    for (const candidate of selected) {
      stats.detailCalls.total += 1;
      const skuId = clean(String(candidate.search.id));
      const detail = await call(JD_ENDPOINTS.detail, { itemId: skuId }, `详情 ${skuId}`);
      if (!detail) {
        stats.detailCalls.failed += 1;
        // 详情取不到就不入库：品牌/图片/库存/参数全部来自详情，缺了它这条商品只剩标题与价格，
        // 与其塞一条残缺记录，不如按「映射不到就丢弃」处理（宁少不错）
        bump(stats.dropped, '详情未取到（无法确认品牌/库存）');
        continue;
      }

      const outcome = normalizeJdProduct({ search: candidate.search, detail });
      if (!outcome.product) {
        bump(stats.dropped, outcome.skip);
        continue;
      }
      if (!isProductLike(outcome.product)) {
        bump(stats.dropped, '未通过写盘前校验');
        continue;
      }
      if (outcome.brandFallback) stats.brandFallback += 1;
      if (outcome.stockDerived) stats.stockDerived += 1;
      stats.detailUsed += 1;
      kept.get(category)?.push(outcome.product);
      const bucketStat = stats.byCategory.get(category);
      if (bucketStat) bucketStat.kept += 1;
    }
  }

  const products = CATEGORIES.flatMap((category) => kept.get(category) ?? []);
  return { products, stats };
}

/** 组装产物元信息（真实性边界必须写准：没有的字段就明确写「无」） */
export function buildPayload(products, stats) {
  const derivedNote =
    stats.stockDerived > 0
      ? `；${stats.stockDerived} 件商品未给出库存状态码，其件数为派生值（界面只显示等级）`
      : '';
  return {
    generatedAt: new Date().toISOString(),
    status: 'ok',
    source: 'https://api.justoneapi.com（京东 search-item-list / get-item-detail）',
    platforms: ['京东'],
    // 京东返回 CNY，本产物不触发汇率换算；保留字段是为了与 real-catalog.json 同构
    currencyToCny: CURRENCY_TO_CNY,
    note:
      '标题/价格/图片/品牌/类目/参数/库存等级为京东实时数据（构建时刻）；' +
      `评分、评论数、销量、划线价在京东搜索与详情端点里没有可用字段，一律记 0 且界面按现有策略显示「暂无评分」${derivedNote}；` +
      '商品描述为派生文案（由品牌/型号/重量/质保等真实字段拼装）；价格为人民币原币种，未折算',
    count: products.length,
    products,
  };
}

/**
 * 完整跑一遍：搜索 → 详情 → 校验 → 原子写盘 → 打印统计。
 *
 * 失败时抛错（调用方负责打印「状态：failed」并保留上一版产物）；**不返回半成品**。
 */
export async function runJustoneapiSource(options = {}) {
  const log = options.log ?? console.log;
  const outPath = options.outPath ?? OUTPUT_PATH;

  if (!hasJustOneApiToken()) {
    throw new Error(
      '未配置环境变量 JUSTONEAPI_TOKEN：京东实时源不可用（把它写进 .env.local 再跑，见 .env.example）',
    );
  }

  log(`[京东实时源] 输出：${outPath}`);
  log('[京东实时源] 成功的调用会计费；失败不计费');

  const { products, stats } = await buildJustoneapiCatalog(options);
  const payload = buildPayload(products, stats);
  await writeJsonAtomically(outPath, payload);

  log('');
  log(`状态：ok，已写入 ${outPath}`);
  log(`商品总数：${payload.count}`);
  for (const category of CATEGORIES) {
    const bucket = stats.byCategory.get(category) ?? { candidates: 0, kept: 0 };
    log(`  ${category}：候选 ${bucket.candidates} → 采纳 ${bucket.kept}`);
  }
  const dropped = [...stats.dropped.entries()].sort((a, b) => b[1] - a[1]);
  log(
    `丢弃 ${dropped.reduce((sum, [, count]) => sum + count, 0)} 件` +
      (dropped.length === 0
        ? ''
        : `（${dropped.map(([reason, count]) => `${reason} ${count}`).join('、')}）`),
  );
  log(
    `调用：搜索 ${stats.searches.total - stats.searches.failed}/${stats.searches.total} 成功、` +
      `详情 ${stats.detailCalls.total - stats.detailCalls.failed}/${stats.detailCalls.total} 成功`,
  );
  if (stats.brandFallback > 0) log(`品牌缺失用平台名兜底：${stats.brandFallback} 件`);
  log(`本次配额消耗：${stats.quota} 次成功调用（失败不计费）`);

  return { outPath, count: payload.count, quota: stats.quota, stats };
}

/** 允许直接执行：`node --env-file=.env.local scripts/sources/justoneapi.mjs` */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    const result = await runJustoneapiSource({ perCategory: perCategoryFromArgv(process.argv) });
    console.log(`[京东实时源] 完成：${result.count} 件`);
  } catch (error) {
    console.error(`状态：failed（已保留上一版产物）\n${error?.message ?? error}`);
    process.exit(1);
  }
}