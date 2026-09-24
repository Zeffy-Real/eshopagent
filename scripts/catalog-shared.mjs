/**
 * 构建期脚本共享的常量与纯函数。
 *
 * 谁在用：`build-real-catalog.mjs`（HF 快照源）与 `sources/justoneapi.mjs`（京东实时源）。
 * 抽出来的唯一理由：两个源必须用**同一套**品类表、汇率表、价格区间、每品类上限与
 * 库存派生规则——各写一份就是埋「两套口径」的雷。
 *
 * 注意是 .mjs：构建脚本由纯 node 直接运行，加载不了 TS。因此这里的校验语义与
 * `lib/catalog/products.ts` 的 `isProductLike()` 是一份**镜像实现**，
 * 由 `lib/justoneapi/jdSource.test.ts` 的等价性单测盯着——两边判定必须永远一致。
 */

export const CATEGORIES = ['数码', '服饰', '食品', '家居', '运动', '美妆', '图书'];

/**
 * 各平台币种 → 人民币的固定汇率（写死以保证构建结果可复现）。
 *
 * 汇率取近似值，仅用于演示展示；接真实电商 API 时应改用当日汇率。
 * 京东源返回 CNY（不在表内），走「币种即 CNY」那一支，不触发换算。
 */
export const CURRENCY_TO_CNY = {
  USD: 7.2,
  SGD: 5.4,
  MYR: 1.62,
  THB: 0.21,
  IDR: 0.00045,
  PHP: 0.128,
  VND: 0.00029,
  TWD: 0.225,
  BRL: 1.3,
  MXN: 0.39,
  CLP: 0.0076,
  COP: 0.0018,
  EUR: 7.8,
  GBP: 9.2,
};

/** 折算后的人民币价格区间（过滤明显异常值） */
export const PRICE_CNY_MIN = 10;
export const PRICE_CNY_MAX = 20000;

/** `--per=N`：每个品类保留多少条（默认 14） */
export function perCategoryFromArgv(argv, fallback = 14) {
  const arg = argv.find((item) => item.startsWith('--per='));
  const value = Number((arg ?? `--per=${fallback}`).split('=')[1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/* ---------- 字段清洗 ---------- */
export function stripInvisible(text) {
  return text.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '');
}

export function clean(value) {
  if (typeof value !== 'string') return '';
  const trimmed = stripInvisible(value).trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'NULL' || trimmed === 'undefined') return '';
  return trimmed.replace(/^"+|"+$/g, '').replace(/\s+/g, ' ').trim();
}

export function toNumber(value) {
  const text = clean(value).replace(/[^0-9.]/g, '');
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

export function stableHash(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 1_000_000;
  }
  return hash;
}

/**
 * 库存件数的派生规则（**内部可用性模型，界面从不展示件数**）。
 *
 * 真实数据源里没有一件商品带真实库存件数；只有「是否有货 / 库存状态」信号是真的。
 * 因此件数一律由 id 哈希派生，界面只显示 `stockLevelOf()` 得出的等级。
 * 与 `build-real-catalog.mjs` 的既有写法完全相同（同一个公式，不是第二个版本）。
 */
export function deriveStock(id) {
  return 21 + (stableHash(id) % 480);
}

/** 必须是非空字符串的字段：这些值会直接渲染，类型不对会让 React 直接抛错 */
const REQUIRED_STRING_FIELDS = ['id', 'name', 'brand', 'image', 'description'];

/**
 * 运行时校验语义的镜像（`lib/catalog/products.ts` 的 `isProductLike()`）。
 *
 * 判两件事：必填字符串字段不能是空串（只判 `undefined` 会让 `null` 混过去），
 * 数值字段必须有限且在区间内（`typeof NaN === 'number'` 恒为 true，不判 `Number.isFinite`
 * 会让一个 NaN 评分渲染成「NaN 分」）。
 */
export function isProductLike(value) {
  if (!value || typeof value !== 'object') return false;

  for (const field of REQUIRED_STRING_FIELDS) {
    const raw = value[field];
    if (typeof raw !== 'string' || raw.trim() === '') return false;
  }

  if (typeof value.price !== 'number' || !Number.isFinite(value.price)) return false;
  if (value.price < 0.01) return false;
  if (typeof value.rating !== 'number' || !Number.isFinite(value.rating)) return false;
  if (value.rating < 0 || value.rating > 5) return false;

  return CATEGORIES.includes(value.category);
}