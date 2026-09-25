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

/* ---------- 派生文案：A+ CSS 描述降级（与图书简介共用同一套拼装规则） ---------- */

/**
 * 亚马逊 A+ 详情页 CSS 的特征。
 *
 * 为什么要专门判它：少数商品的源 `description` 是**整页样式代码**
 * （实测 2 件：5977 / 20747 字符，形如 `From the brand .aplus-v2 { display:block; … }`），
 * 构建期「长度 ≥ 60」的门只看长度、挡不住它，于是 CSS 混进目录、本地化后只剩几个可见字。
 *
 * 只认真正的 CSS 特征，**不认 `From the Manufacturer` / `From the brand` 这类前缀**：
 * 实测综合样本里有 9 件商品的描述以 `From the Manufacturer Product Description …` 开头，
 * 后面是正常的商品文案（可读、可翻译），按前缀判会把好描述误降级。
 */
const APLUS_CSS_PATTERN = /aplus-v2|brand-story\.cfg|display:\s*block/i;

export function isAplusCss(text) {
  return typeof text === 'string' && APLUS_CSS_PATTERN.test(text);
}

/**
 * 派生文案的统一拼装规则：非空片段用 `；` 连接、句号结尾、截断到 180 字。
 *
 * 图书简介与 A+ CSS 降级共用这一份——两处各写一套拼接格式，文案风格立刻分叉。
 */
export function buildDerivedDescription(parts) {
  const kept = parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part !== '');
  if (kept.length === 0) return '';
  return truncate(`${kept.join('；')}。`, 180);
}

/**
 * A+ CSS 商品的降级描述（**降级而不是丢弃**：商品本身是好的——价格、图片、规格、
 * 评分都是真实字段，只是 description 不可用；丢弃会改变件数、牵动全部文档计数）。
 *
 * 只用数据里确实存在的字段拼装：品牌 + 上游类目叶子 + 商品参数（最多 4 项）+ 评分与评价数，
 * 不编造剧情梗概或营销卖点。`specifications.类目` 比本项目 7 品类更具体，优先用它。
 *
 * 评分与评价数不只是「信息更全」：没有它们，疏散情形（无品牌 + 规格只有一项）会拼出
 * 「类目：数码。」这种 6 字文案，直接落在目录不变量扫描的非法区间（< 10 字）。
 */
export function describeWithoutSourceDescription({ brand, category, specifications, rating, reviews }) {
  const specs = specifications ?? {};
  const parts = [];
  if (clean(brand)) parts.push(`品牌 ${clean(brand)}`);
  const categoryText = clean(specs.类目) || clean(category);
  if (categoryText) parts.push(`类目：${categoryText}`);
  const detailParts = Object.entries(specs)
    // 类目已单独成段，重复会让描述读起来像拼凑
    .filter(([key]) => key !== '类目')
    .slice(0, 4)
    .map(([key, value]) => `${clean(key)} ${clean(value)}`)
    .filter((part) => part.trim() !== '');
  if (detailParts.length > 0) parts.push(`商品参数：${detailParts.join('、')}`);
  if (typeof rating === 'number' && Number.isFinite(rating) && rating > 0) {
    const reviewCount = typeof reviews === 'number' && Number.isFinite(reviews) && reviews > 0 ? reviews : 0;
    parts.push(`评分 ${rating} 分（${reviewCount} 条评价）`);
  }
  return buildDerivedDescription(parts);
}

/* ---------- 跨产物继承：重建时保住上一轮的本地化文案 ---------- */

/**
 * `localize-catalog.mjs` 写进产物的全部文案字段。
 *
 * build 每次都从数据源重新生成英文原文，这五个字段是上一轮本地化的唯一产物；
 * 不继承就等于每次重建都把已验收中文文案丢掉、全量重译
 * （实测 420 条 = 70 批 / 221.5 秒，且 112 件已验收文案里只有 16 件逐字未变）。
 */
export const LOCALIZED_FIELDS = ['name', 'description', 'tags', 'specifications', 'nameOriginal'];

/**
 * 已本地化判定 = 条目带 `nameOriginal` 标记（`localize-catalog.mjs` 是唯一写入者）。
 *
 * 判据必须用**标记的存在性**，不能用「nameOriginal ≠ name」：
 * 实测 420 件里有 40 件（37 图书 + 2 Lazada + 1 Amazon 的品牌/型号标题）的译名
 * 与英文原文逐字相同——这是 LLM 按提示词「保留品牌名与型号」的正确输出，
 * 而不是翻译失败。用等值判据会把它们当成未本地化 → 每次重建都重译这 40 件
 * （漂移 + 白花 token），build 的继承也会漏掉它们。
 *
 * 反过来，翻译失败的条目根本不会被写入 nameOriginal（批次失败时该条目整体不动），
 * 因此「有标记 = 处理过」既充分又必要。只用产物里已有的信号，不引入语言检测依赖。
 * build（继承判据）与 localize（跳过判据）共用这一份，不允许两处各写一套。
 */
export function isLocalizedProduct(product) {
  const original = typeof product?.nameOriginal === 'string' ? product.nameOriginal.trim() : '';
  return original !== '';
}

/**
 * 把上一版产物里已本地化的字段继承到新构建结果上（纯函数，不读写文件）。
 *
 * 判据是**双重校验**：`id` 相同 **且** 旧产物的 `nameOriginal`（英文原文）
 * 与新构建出的英文 `name` 逐字一致。只按 id 继承会在数据源更新后张冠李戴
 * （同一 id 换了商品或标题，旧中文文案就被安到别的商品上）。
 *
 * 另有一道「描述基准」guard：`descriptionDerived`（源描述是 A+ 页 CSS、
 * 已降级为派生文案）在两版之间不一致时**整条不继承**——字段的生成依据变了，
 * 旧的中文描述不能代表新依据，交给 localize 按新基准重译一遍。
 * 图书源不设该标记（其简介从一开始就是派生的，基准未变），因此图书照常继承。
 *
 * @returns `{ products, inherited, pending }`：合并结果 + 继承条数 + 待翻译条数
 *          （口径与 localize 的「已本地化 / 待本地化」一致）
 */
export function inheritLocalizedFields(freshProducts, previousProducts) {
  const previousById = new Map();
  for (const item of previousProducts ?? []) {
    if (item && typeof item.id === 'string' && item.id) previousById.set(item.id, item);
  }

  let inherited = 0;
  const products = freshProducts.map((fresh) => {
    const old = previousById.get(fresh.id);
    const original = typeof old?.nameOriginal === 'string' ? old.nameOriginal.trim() : '';
    if (!old || !isLocalizedProduct(old) || original !== fresh.name) return fresh;
    if (Boolean(old.descriptionDerived) !== Boolean(fresh.descriptionDerived)) return fresh;

    inherited += 1;
    const merged = { ...fresh };
    for (const key of LOCALIZED_FIELDS) {
      const value = old[key];
      if (value === undefined) continue;
      // 数组 / 对象复制一份，避免合并结果与旧产物对象共享引用
      merged[key] =
        Array.isArray(value) ? [...value] : value !== null && typeof value === 'object' ? { ...value } : value;
    }
    return merged;
  });

  return { products, inherited, pending: products.length - inherited };
}