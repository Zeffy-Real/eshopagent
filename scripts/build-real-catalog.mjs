#!/usr/bin/env node
/**
 * 真实商品目录构建脚本（多平台）
 *
 * 数据来源（两个 Bright Data 公开的真实抓取样本仓库）：
 *   1. luminati-io/eCommerce-dataset-samples —— 综合电商样本，含 5 个真实平台：
 *      Amazon / Walmart / Lazada / Shopee / Shein
 *   2. luminati-io/Amazon-popular-books-dataset —— 亚马逊畅销图书样本（2269 条），
 *      用于补实「图书」品类（综合样本里图书只有 2 条，撑不起一个品类）
 *
 * 用法：
 *   node scripts/build-real-catalog.mjs                 # 默认每个品类保留 14 条
 *   node scripts/build-real-catalog.mjs --per=20
 *
 * 币种处理：价格字段按 currency 查固定汇率表折算成人民币；汇率表未覆盖的币种直接跳过，
 * 而不是当成美元处理（否则 93500 IDR 会被当成 93500 美元判越界）。
 *
 * 字段真实性说明（README 同步记录）：
 *   真实：标题、品牌、价格、原价、评分、评论数、图片、类目、商品参数、ASIN/SKU，
 *         以及 Amazon/Lazada/Shopee 的销量与「是否有货」信号
 *   派生：人民币价格（按固定汇率折算）；
 *         部分来源缺失的库存件数（由「是否有货」信号 + id 哈希派生）——
 *           **仅作为内部可用性模型（缺货不可加购 / 加购上限），界面不展示件数**；
 *         图书简介（该数据集的 description 是 A+ 页面原始 CSS，不可用，改为用
 *                 作者/类目/评分/版本等真实字段拼装）
 *   不编造：来源没有销量字段时 sales 记 0（界面改展示真实评价数），
 *           不用「评价数 × 系数」估算一个假的销量（见 normalizeRow 注释）
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES,
  CURRENCY_TO_CNY,
  PRICE_CNY_MAX,
  PRICE_CNY_MIN,
  clean,
  perCategoryFromArgv,
  stableHash,
  stripInvisible,
  toNumber,
  truncate,
} from './catalog-shared.mjs';

const REPO = 'luminati-io/eCommerce-dataset-samples';
/** 图书专用数据集：综合样本里图书太少，单独接一个真实亚马逊畅销书样本 */
const BOOKS_REPO = 'luminati-io/Amazon-popular-books-dataset';
const API_HEADERS = { 'User-Agent': 'eshop-catalog-builder', Accept: 'application/vnd.github+json' };

const PER_CATEGORY = perCategoryFromArgv(process.argv);

/** 数据源：`real`（默认，HF 公开抓取快照）| `justoneapi`（京东实时，需 JUSTONEAPI_TOKEN） */
const SOURCE = (process.argv.find((arg) => arg.startsWith('--source=')) ?? '--source=real').split('=')[1];

/* ---------- 源分支 ---------- */
// 京东实时源与 HF 快照源的流程没有交集（一个走 HTTP 调用、一个读数据集 CSV），
// 因此在这里直接分叉：实时源不读数据集、不写 real-catalog.json，产物是独立文件。
if (SOURCE === 'justoneapi') {
  const { runJustoneapiSource } = await import('./sources/justoneapi.mjs');
  try {
    const result = await runJustoneapiSource({ perCategory: PER_CATEGORY });
    console.log(`[构建] 完成：${result.count} 件`);
  } catch (error) {
    console.error(`状态：failed（已保留上一版产物）\n${error?.message ?? error}`);
    process.exit(1);
  }
  process.exit(0);
}
if (SOURCE !== 'real') {
  console.error(`未知数据源：${SOURCE}（可选：real | justoneapi）`);
  process.exit(1);
}

/* ---------- 多平台字段映射 ---------- */
const SOURCES = [
  {
    file: 'amazon-products.csv',
    platform: 'Amazon',
    idPrefix: 'amz',
    map: {
      id: 'asin',
      name: 'title',
      brand: 'brand',
      price: 'final_price',
      originalPrice: 'initial_price',
      rating: 'rating',
      reviews: 'reviews_count',
      sales: 'bought_past_month',
      image: 'image_url',
      description: 'description',
      currency: 'currency',
      categories: 'categories',
      specs: 'product_details',
      availability: 'availability',
      available: 'is_available',
      url: 'url',
      weight: 'item_weight',
      dimensions: 'product_dimensions',
      model: 'model_number',
      department: 'department',
    },
  },
  {
    file: 'walmart-products.csv',
    platform: 'Walmart',
    idPrefix: 'wmt',
    map: {
      id: 'product_id',
      name: 'product_name',
      brand: 'brand',
      price: 'final_price',
      originalPrice: 'initial_price',
      rating: 'rating',
      reviews: 'review_count',
      image: 'main_image',
      description: 'description',
      currency: 'currency',
      categories: 'category_path',
      specs: 'specifications',
      availability: 'available_for_delivery',
      url: 'url',
      model: 'upc',
    },
  },
  {
    file: 'lazada-products.csv',
    platform: 'Lazada',
    idPrefix: 'lzd',
    map: {
      id: 'sku',
      name: 'title',
      brand: 'brand',
      price: 'final_price',
      originalPrice: 'initial_price',
      rating: 'rating',
      reviews: 'reviews',
      sales: 'number_sold',
      image: 'image',
      description: 'product_description',
      currency: 'currency',
      categories: 'breadcrumb',
      specs: 'product_specifications',
      url: 'url',
    },
  },
  {
    file: 'shopee-products.csv',
    platform: 'Shopee',
    idPrefix: 'shp',
    map: {
      id: 'id',
      name: 'title',
      brand: 'brand',
      price: 'final_price',
      originalPrice: 'initial_price',
      rating: 'rating',
      reviews: 'reviews',
      sales: 'sold',
      stock: 'stock',
      image: 'image',
      description: 'Product Description',
      currency: 'currency',
      categories: 'breadcrumb',
      specs: 'Product Specifications',
      available: 'is_available',
      url: 'url',
    },
  },
  {
    file: 'shein-products.csv',
    platform: 'Shein',
    idPrefix: 'she',
    // Shein 样本缺少 rating 字段，实测 1000 行全部无法通过质量门槛，因此默认关闭；
    // 保留映射配置以便数据集更新后一行开启
    enabled: false,
    map: {
      id: 'product_id',
      name: 'product_name',
      brand: 'brand',
      price: 'final_price',
      originalPrice: 'initial_price',
      rating: 'rating',
      reviews: 'reviews_count',
      image: 'main_image',
      description: 'description',
      currency: 'currency',
      categories: 'category_tree',
      specs: 'other_attributes',
      available: 'in_stock',
      url: 'url',
      model: 'model_number',
    },
  },
  {
    // 图书专用来源：字段结构与上面的综合样本完全不同（rating 是 "4.6 out of 5 stars"
    // 这种字符串、categories/format 是 JSON 数组字符串、没有销量字段），
    // 因此走独立的 normalizeBookRow，不复用 normalizeRow。
    repo: BOOKS_REPO,
    file: 'Amazon_popular_books_dataset.csv',
    platform: 'Amazon',
    idPrefix: 'bk',
    kind: 'books',
  },
];

/* ---------- 类目映射（顺序敏感） ---------- */
/**
 * 各平台类目 → 本项目 7 个品类。
 *
 * 关键词覆盖多语言：Amazon/Walmart 是英文，Lazada 混印尼语，Shopee 混
 * 西班牙语/印尼语/越南语（例如 Buku & Majalah = 图书与杂志、
 * Deportes y Aire Libre = 运动户外、Hogar y Vida = 家居生活）。
 *
 * 顺序敏感：
 *   1. 运动鞋在 Amazon 里挂在 Clothing 下，必须先判运动再判服饰；
 *   2. 图书要在最前面：Shopee 的「Buku & Alat Tulis」是图书文具，
 *      若先判文具类会被归到家居；
 *   3. 保健品（Health & Household / Vitamins）必须排在数码之前。
 */
const CATEGORY_RULES = [
  {
    category: '图书',
    // 只认类目、不认标题：标题匹配会把 LookbookStore（含 book）、
    // "BOOKSHAPED BOX"、"kệ sách"（书架）这类商品误判成图书
    categoryOnly: true,
    pattern: /Books|Kindle|Audible|Literature|Textbook|Buku & Majalah|Buku Bacaan|Majalah|Libros|Sách|Nhà sách/i,
    // 文具、书架、相框、便签本都不是图书
    exclude: /Alat Tulis|Stationery|Kertas|Tulis|Frame|Kệ|Giá|Shel|Memo|Scratch|Notebook|Sticker|Coloring|Papelería/i,
  },
  {
    category: '运动',
    pattern: /Sporting Goods|Athletic|Running|Sports & Outdoors|Outdoor Recreation|Exercise & Fitness|Cycling|Camping|Hiking|Deportes|Olahraga|Thể thao|Aire Libre|Esportes/i,
    exclude: /Hunting|Gunsmithing|Airsoft|Paintball|Archery|Firearm|Trophy|Taxidermy|Automotive|Motocicleta|Motorcycle/i,
  },
  { category: '美妆', pattern: /Beauty|Personal Care|Skin Care|Makeup|Hair Care|Fragrance|Health & Household|Vitamins|Supplement|Dietary|Nutrition|Belleza|Perawatan|Kecantikan|Cuidado Personal|Salud/i },
  { category: '食品', pattern: /Grocery|Gourmet|Food|Beverage|Snack|Coffee|Tea|Candy|Pantry|Alimentos|Bebidas|Makanan|Minuman|Thực phẩm|Comida/i },
  { category: '数码', pattern: /Electronics|Computers|Camera|Headphone|Cell Phones|Video Games|Home Audio|Television|Laptop|Tablet|Musical Instruments|Mobiles|Aksesoris Elektronik|Electrónica|Computación|Celulares|Máy tính|Komputer|Handphone/i },
  { category: '家居', pattern: /Home & Kitchen|Furniture|Bedding|Kitchen|Appliances|Tools & Home|Garden|Bath|Storage|Lighting|Office Product|Home\b|Hogar|Vida|Rumah|Nhà cửa|Muebles|Cocina|Jardín|Decoração|Household Supplies/i },
  { category: '服饰', pattern: /Clothing|Shoes & Jewelry|Apparel|Jewelry|Handbag|Watch|Accessories|Ropa|Moda|Thời trang|Pakaian|Tas & Travel|Zapatos|Calzado/i },
];

/* ---------- 极简 RFC4180 CSV 解析 ---------- */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* ---------- 字段清洗（clean / toNumber / truncate / stableHash 在 catalog-shared.mjs） ---------- */
function toBooleanish(value) {
  const text = clean(value).toLowerCase();
  if (['true', 'yes', '1', 'in stock', 'instock'].includes(text)) return true;
  if (['false', 'no', '0', 'out of stock'].includes(text)) return false;
  return null;
}

/** 类目字段可能是 JSON 数组、逗号分隔串或路径串，统一成字符串数组 */
function toCategoryList(value) {
  const text = clean(value);
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((item) => clean(String(item)));
    } catch {
      /* 落到下面的字符串切分 */
    }
  }
  return text
    .split(/\s*(?:>|\/|\||,)\s*/)
    .map((item) => clean(item))
    .filter((item) => item.length > 1 && item.length < 40);
}

/**
 * 图片字段可能是单个 URL，也可能是 JSON 数组字符串（Shopee/Lazada 就是这样，
 * 值是 `["https://..."]`）。不处理会直接把整个平台判成「缺少图片」。
 * 另外 CSV 里数组内逗号会把字段截断，JSON 解析失败时退化为正则抽取首个 URL。
 */
function toImageUrl(value) {
  const text = clean(value);
  if (!text) return '';
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const first = parsed.find(
          (item) => typeof item === 'string' && item.startsWith('http'),
        );
        if (first) return first;
      }
    } catch {
      /* 落到正则抽取 */
    }
    const match = text.match(/https?:\/\/[^",\s\]]+/);
    return match ? match[0] : '';
  }
  if (text.startsWith('//')) return `https:${text}`;
  return text;
}

/** 规格参数：可能是 JSON 对象或 "键: 值 | 键: 值" 串 */
function toSpecifications(value) {
  const text = clean(value);
  if (!text) return {};
  const result = {};

  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, raw] of Object.entries(parsed)) {
          const specValue = clean(String(raw ?? ''));
          if (key && specValue && specValue.length <= 42) result[clean(key)] = specValue;
        }
        return result;
      }
    } catch {
      /* 落到下面的字符串解析 */
    }
  }

  for (const part of text.split(/\s*[|;]\s*/)) {
    const [key, ...rest] = part.split(/\s*[:：]\s*/);
    const specValue = clean(rest.join(':'));
    if (key && specValue && key.length <= 14 && specValue.length <= 42) {
      result[clean(key)] = specValue;
    }
  }
  return result;
}

function resolveCategory(categories, title) {
  const categoryText = categories.join(' > ');
  const haystack = `${categoryText} ${title}`;
  for (const rule of CATEGORY_RULES) {
    // categoryOnly 的规则只在类目文本里匹配，避免标题里的品牌名/描述词造成误判
    const scope = rule.categoryOnly ? categoryText : haystack;
    if (rule.exclude?.test(scope)) continue;
    if (rule.pattern.test(scope)) return rule.category;
  }
  return null;
}

/* ---------- 抓取（带本地缓存） ---------- */
const CACHE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../.cache/datasets');
const REFRESH = process.argv.includes('--refresh');

/** 数据集文件有 2 - 8MB，跨境网络下偶发连接中断，因此带重试 */
async function fetchWithRetry(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, { headers: API_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const wait = 1200 * attempt;
        console.warn(`    下载失败（${error.message}），${wait}ms 后第 ${attempt + 1} 次重试…`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  throw lastError;
}

/**
 * 取数据集 CSV。
 * 优先读本地缓存：数据集是静态样本，反复构建时没必要每次都跨境拉几 MB，
 * 网络不稳时也能保证 `catalog:build` 可复现。需要最新数据时加 --refresh。
 */
async function fetchSourceCsv(source) {
  const cachePath = join(CACHE_DIR, source.file);
  if (!REFRESH) {
    try {
      const cached = await readFile(cachePath, 'utf8');
      console.log(`    使用本地缓存 ${source.file}`);
      return cached;
    } catch {
      /* 缓存不存在，走下载 */
    }
  }

  // 不同来源可能来自不同仓库，因此仓库地址随 source 走而不是用全局常量
  const repo = source.repo ?? REPO;
  const tree = await fetchWithRetry(
    `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`,
  );
  const entry = tree.tree.find((item) => item.path === source.file);
  if (!entry) throw new Error(`仓库 ${repo} 中未找到 ${source.file}`);
  const blob = await fetchWithRetry(
    `https://api.github.com/repos/${repo}/git/blobs/${entry.sha}`,
  );
  const text = Buffer.from(blob.content, 'base64').toString('utf8');
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath, text, 'utf8');
  return text;
}

/* ---------- 归一化 ---------- */
function normalizeRow(row, headerIndex, source) {
  const pick = (key) => {
    const column = source.map[key];
    if (!column) return '';
    return clean(row[headerIndex[column] ?? -1]);
  };

  const currency = (pick('currency') || 'USD').toUpperCase();
  const rate = CURRENCY_TO_CNY[currency];
  if (!rate) return { skip: `未支持币种(${currency})` };

  // 先解析类目再走质量门槛：这样淘汰原因可以按品类归类，
  // 便于发现「某个品类几乎没有可用商品」这类数据缺口
  const categories = toCategoryList(pick('categories'));
  const category = resolveCategory(categories, clean(pick('name')));
  if (!category) return { skip: '类目未映射' };

  const rawId = pick('id');
  const name = pick('name');
  const image = toImageUrl(pick('image'));
  const description = pick('description');
  const priceRaw = toNumber(pick('price'));
  const initialRaw = toNumber(pick('originalPrice'));
  const rating = toNumber(pick('rating'));
  const reviews = toNumber(pick('reviews'));
  const sales = toNumber(pick('sales'));
  const brand = pick('brand');

  const skip = (reason) => ({ skip: `${category}|${reason}` });

  if (!rawId || !name || name.length < 12 || name.length > 130) return skip('名称不合法');
  if (!image.startsWith('http')) return skip('缺少图片');
  if (description.length < 60) return skip('缺少描述');

  // 先按币种折算成人民币，再用人民币区间做门槛：
  // 否则 93500 IDR（≈¥42）会被当成 93500 美元直接判越界
  const priceCny = priceRaw === null ? null : Math.round(priceRaw * rate);
  if (priceCny === null || priceCny < PRICE_CNY_MIN || priceCny > PRICE_CNY_MAX) {
    return skip('价格越界');
  }
  // 图书在公开样本里极少，且部分真实书籍没有评分字段。
  // 只对图书放宽为「允许无评分」，用 rating=0 表示「暂无评分」——
  // 绝不编造评分数字，界面会如实展示「暂无评分」。
  const ratingValue = rating ?? (category === '图书' ? 0 : null);
  if (ratingValue === null || ratingValue > 5) return skip('评分不可用');
  if (category !== '图书' && ratingValue < 3.5) return skip('评分不足');

  const availability = pick('availability').toLowerCase();
  const availableFlag = toBooleanish(pick('available'));
  const outOfStock = /out of stock|unavailable|sold out/.test(availability) || availableFlag === false;

  const id = `${source.idPrefix}-${rawId}`;
  const price = priceCny;
  const originalPrice =
    initialRaw !== null && priceRaw !== null && initialRaw > priceRaw
      ? Math.round(initialRaw * rate)
      : price;

  // Shopee 等来源有真实库存件数；缺失时用库存布尔信号 + id 哈希派生
  const rawStock = toNumber(pick('stock'));
  const stock = outOfStock ? 0 : rawStock !== null && rawStock > 0 ? Math.round(rawStock) : 21 + (stableHash(id) % 480);

  const specs = toSpecifications(pick('specs'));
  // 注意：不要放「品牌」——对比表已有固定的品牌行，重复会让表格出现两行同名参数
  const specifications = {
    类目: categories.slice(-1)[0] ?? category,
    ...Object.fromEntries(Object.entries(specs).slice(0, 5)),
    ...(clean(pick('weight')) ? { 重量: clean(pick('weight')) } : {}),
    ...(clean(pick('dimensions')) ? { 尺寸: clean(pick('dimensions')) } : {}),
    ...(clean(pick('model')) ? { 型号: clean(pick('model')) } : {}),
  };

  return {
    product: {
      id,
      name,
      brand: brand || '未知品牌',
      category,
      price,
      originalPrice,
      rating: Number(ratingValue.toFixed(1)),
      reviews: reviews === null ? 0 : Math.round(reviews),
      // 来源没有销量字段时记 0，**不**用「评价数 × 系数」估算。
      // 之前这里写的是 Math.round((reviews ?? 0) * 1.6)：估算值会被界面当成
      // 「销量 3.4万」展示、被 LLM 当成事实引用、还被写进对比表与决策推荐，
      // 而目录元信息却声称销量是真实平台数据——这等于用假数据冒充真实数据。
      // 现在 sales === 0 表示「该来源无销量数据」，界面与 LLM 改展示真实评价数。
      sales: sales !== null && sales > 0 ? Math.round(sales) : 0,
      stock,
      image,
      description: truncate(description, 180),
      specifications,
      tags: [],
      platform: source.platform,
      sourceId: rawId,
      sourceUrl: pick('url'),
    },
    raw: { specs },
  };
}

/* ---------- 图书来源归一化 ---------- */

/**
 * 评分字段是自然语言："4.6 out of 5 stars"。
 *
 * 不能交给 toNumber：它会先剥掉所有非数字字符，"4.6 out of 5 stars" 会变成
 * "4.6outof5stars" → 去除非数字后是 "4.65"（"5" 被当成小数位），
 * 于是 4.6 分被读成 4.65 分。必须用正则只取 "out of 5" 前面的那个数。
 */
function parseStarRating(value) {
  const match = clean(value).match(/(\d+(?:\.\d+)?)\s*out of\s*5/i);
  if (!match) return null;
  const rating = Number.parseFloat(match[1]);
  return Number.isFinite(rating) && rating >= 0 && rating <= 5 ? rating : null;
}

/** 版本字段是 JSON 数组字符串：[{"name":"Kindle","price":"$0.99","url":"..."}] */
function parseFormats(value) {
  const text = clean(value);
  if (!text.startsWith('[')) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        name: clean(String(item?.name ?? '')),
        price: clean(String(item?.price ?? '')),
      }))
      .filter((item) => item.name.length > 0 && item.name.length <= 24);
  } catch {
    return [];
  }
}

/**
 * 图书简介（派生文案）。
 *
 * 为什么不用源数据的 description：实测 2269 行里只有 712 行非空，其中 708 行是
 * 亚马逊 A+ 详情页的原始 CSS（形如 `From the Publisher .aplus-v2 { display:block; … }`），
 * 渲染出来是一屏样式代码；features 字段只有 4 行非空。
 *
 * 因此简介改为用**真实字段**拼装：作者、类目、评分与评价数、可选版本、首次上架时间。
 * 只陈述数据里确实存在的字段，不编造剧情梗概或营销卖点。
 */
function buildBookDescription({ author, categories, rating, reviews, formats, firstAvailable }) {
  const parts = [];
  if (author) parts.push(`作者 ${author}`);
  const categoryPath = categories.slice(1).join(' / ') || categories[0];
  if (categoryPath) parts.push(`亚马逊图书类目：${categoryPath}`);
  if (rating !== null) parts.push(`评分 ${rating} 分（${reviews} 条评价）`);
  else if (reviews > 0) parts.push(`${reviews} 条评价`);
  const formatNames = formats.map((item) => item.name).slice(0, 5);
  if (formatNames.length > 0) parts.push(`可选版本：${formatNames.join('、')}`);
  if (firstAvailable) parts.push(`首次上架 ${firstAvailable}`);
  return truncate(`${parts.join('；')}。`, 180);
}

/**
 * 亚马逊畅销图书样本的归一化。
 *
 * 与综合样本的差异（所以不能复用 normalizeRow）：
 *   - rating 是 "4.6 out of 5 stars" 字符串；
 *   - categories / format 是 JSON 数组字符串；
 *   - 没有销量字段（sales 记 0，界面改展示真实评价数）；
 *   - description 不可用（见 buildBookDescription）；
 *   - brand 字段存的是**作者**而不是出版社。
 */
function normalizeBookRow(row, headerIndex, source) {
  const pick = (key) => clean(row[headerIndex[key] ?? -1]);

  const rawId = pick('asin');
  const name = pick('title');
  const author = pick('brand');
  const currency = (pick('currency') || 'USD').toUpperCase();
  const rate = CURRENCY_TO_CNY[currency];
  const skip = (reason) => ({ skip: `图书|${reason}` });

  if (!rate) return skip(`未支持币种(${currency})`);

  const categories = toCategoryList(pick('categories'));
  // 该数据集整库都是图书，但仍按统一规则判定一次：判定结果不是「图书」的直接丢弃，
  // 避免图书来源的数据因为类目规则变化悄悄漏进别的品类
  const category = resolveCategory(categories, name);
  if (category !== '图书') return skip('类目未映射');

  const image = toImageUrl(pick('image_url'));
  const priceRaw = toNumber(pick('final_price'));
  const initialRaw = toNumber(pick('initial_price'));
  const rating = parseStarRating(pick('rating'));
  const reviewsRaw = toNumber(pick('reviews_count'));
  const reviews = reviewsRaw === null || reviewsRaw < 0 ? 0 : Math.round(reviewsRaw);
  const formats = parseFormats(pick('format'));
  const firstAvailable = pick('date_first_available').slice(0, 10);

  if (!rawId || !name || name.length < 12 || name.length > 130) return skip('名称不合法');
  if (!image.startsWith('http')) return skip('缺少图片');

  const priceCny = priceRaw === null ? null : Math.round(priceRaw * rate);
  if (priceCny === null || priceCny < PRICE_CNY_MIN || priceCny > PRICE_CNY_MAX) {
    return skip('价格越界');
  }
  // 图书允许无评分：rating 缺失时用 0 表示「暂无评分」，绝不编造评分
  if (rating !== null && rating > 5) return skip('评分不可用');
  if (rating !== null && rating < 3.5) return skip('评分不足');

  const id = `${source.idPrefix}-${rawId}`;
  const available = /in stock/i.test(pick('availability'));

  const specifications = {
    作者: author || '佚名',
    类目: categories.slice(-1)[0] ?? '图书',
    ...(formats.length > 0 ? { 装帧: formats.map((item) => item.name).slice(0, 4).join(' / ') } : {}),
    ...(pick('item_weight') ? { 重量: pick('item_weight') } : {}),
    ...(pick('product_dimensions') ? { 尺寸: pick('product_dimensions') } : {}),
    ...(firstAvailable ? { 首次上架: firstAvailable } : {}),
  };

  return {
    product: {
      id,
      name,
      brand: author || '未知作者',
      category,
      price: priceCny,
      originalPrice:
        initialRaw !== null && priceRaw !== null && initialRaw > priceRaw
          ? Math.round(initialRaw * rate)
          : priceCny,
      rating: rating === null ? 0 : Number(rating.toFixed(1)),
      reviews,
      // 该来源没有销量字段：记 0 而不是估算，界面会改展示真实的评价数
      sales: 0,
      // 库存件数同样是派生的（该来源只有「是否有货」信号）
      stock: available ? 21 + (stableHash(id) % 480) : 0,
      image,
      description: buildBookDescription({
        author,
        categories,
        rating,
        reviews,
        formats,
        firstAvailable,
      }),
      specifications,
      tags: [],
      platform: source.platform,
      sourceId: rawId,
      sourceUrl: pick('url'),
    },
    raw: { formats },
  };
}

/**
 * 图书去重键：同一本书在亚马逊上会以多个版本出现（平装 / 精装 / 纪念版 / 副标题不同），
 * 标题字符串不同但其实是同一本书。实测 16 本里出现了 4 组近重复：
 *   The Vanishing Half: A Novel / The Vanishing Half: Shortlisted for…
 *   A Time for Mercy (Jake Brigance) / A Time for Mercy: A Jake Brigance Novel
 *   The Thursday Murder Club: A Novel / The Thursday Murder Club: The Record-Breaking…
 *   The Boy, the Mole, the Fox and the Horse / …Deluxe (Yellow) Edition
 * 因此图书按「书名主体」去重：截掉副标题（`:` 与括号之后的内容），再去掉版本噪声词。
 *
 * 只对图书启用：服饰等品类的括号里装的是颜色 / 尺码，那是不同 SKU，合并会丢商品。
 */
const BOOK_EDITION_NOISE =
  /\b(deluxe|edition|special|anniversary|illustrated|revised|paperback|hardcover|kindle|audiobook|boxed|set|gift)\b/g;

/** 去掉 "25th" / "1st" 这类版本序号 */
const BOOK_ORDINAL = /\b\d+(?:st|nd|rd|th)\b/g;

function bookDedupeKey(name) {
  const core = clean(name)
    .split(/[:：(（\[]/)[0]
    .toLowerCase()
    .replace(BOOK_ORDINAL, '')
    .replace(BOOK_EDITION_NOISE, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  return core.slice(0, 30);
}

/**
 * 判断两个书名主体是否是同一本书。
 *
 * 单靠相等不够：版本后缀不一定带 `:` 或括号，例如
 *   thewonkydonkey（The Wonky Donkey）
 *   thewonkydonkeybooktoy（The Wonky Donkey Book & Toy Boxed Set）
 * 因此改为前缀判定——较短的主体若是较长主体的前缀，视为同一本书。
 * 要求较短主体至少 12 个字符，避免 "Midnight Sun" 这种短书名被别的书名前缀误吞。
 */
function isSameBook(a, b) {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 12 && longer.startsWith(shorter);
}

/* ---------- 主流程 ---------- */
const buckets = Object.fromEntries(CATEGORIES.map((category) => [category, []]));
const seen = new Set();
/** 图书书名主体（用于前缀判重，见 isSameBook） */
const bookCores = [];
const stats = [];

for (const source of SOURCES) {
  if (source.enabled === false) {
    stats.push({ platform: source.platform, rows: 0, accepted: 0, topSkip: [['已停用', 0]] });
    continue;
  }
  const csv = await fetchSourceCsv(source);
  const rows = parseCsv(csv);
  const header = rows[0].map((name) => clean(name));
  const headerIndex = Object.fromEntries(header.map((name, i) => [name, i]));
  // 图书来源字段结构完全不同，走自己的归一化函数
  const normalize = source.kind === 'books' ? normalizeBookRow : normalizeRow;

  let accepted = 0;
  const skipReasons = new Map();

  for (const row of rows.slice(1)) {
    const outcome = normalize(row, headerIndex, source);
    if (!outcome.product) {
      skipReasons.set(outcome.skip, (skipReasons.get(outcome.skip) ?? 0) + 1);
      continue;
    }
    const product = outcome.product;
    if (source.kind === 'books') {
      // 图书按「书名主体」判重：同一本书的多个版本标题不同但主体相同
      const core = bookDedupeKey(product.name);
      if (bookCores.some((existing) => isSameBook(existing, core))) continue;
      bookCores.push(core);
    } else {
      const dedupeKey = product.name
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
        .slice(0, 40);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
    }
    buckets[product.category].push(product);
    accepted += 1;
  }

  stats.push({
    platform: source.platform,
    rows: rows.length - 1,
    accepted,
    topSkip: Array.from(skipReasons.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3),
  });
}

const products = [];
for (const category of CATEGORIES) {
  products.push(...buckets[category].sort((a, b) => b.reviews - a.reviews).slice(0, PER_CATEGORY));
}

if (products.length === 0) throw new Error('没有解析出任何商品，数据集结构可能已变化');

const outPath = resolve(dirname(fileURLToPath(import.meta.url)), '../data/real-catalog.json');
await mkdir(dirname(outPath), { recursive: true });

// 真实性说明里的「哪些平台有真实销量」必须从数据里算出来，不能手写：
// 手写过一版写的是「Amazon/Lazada/Shopee」，但实测 Shopee 的 sold 字段
// 1000 行全是 0，且它现在一条商品都没进目录——元信息一旦与数据脱节就是在撒谎。
const platformsWithSales = Array.from(
  new Set(products.filter((product) => product.sales > 0).map((product) => product.platform)),
);
const salesClaim =
  platformsWithSales.length > 0
    ? `销量为 ${platformsWithSales.join(' / ')} 提供的真实字段`
    : '所有来源均无销量字段';

await writeFile(
  outPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: `https://github.com/${REPO} + https://github.com/${BOOKS_REPO}`,
      // 只列出真正贡献了商品的平台（有的来源会因为缺少评分/币种不符被整体丢弃）
      platforms: Array.from(new Set(products.map((product) => product.platform))),
      currencyToCny: CURRENCY_TO_CNY,
      // 真实性边界必须写准：上一版这里声称「销量」也是真实数据，但 Walmart 与
      // 大部分 Amazon 商品的销量其实是「评价数 × 1.6」估算出来的，元信息在撒谎。
      // 现在改为逐字段说明来源，且「哪些平台有销量」由数据算出（见 salesClaim）。
      note: `标题/品牌/价格/原价/评分/评论数/图片/类目/商品参数/ASIN 为真实平台数据；${salesClaim}，其余来源无销量字段记 0（界面改展示真实评价数）；库存只有「有货/紧张/缺货」等级来自真实信号，件数为派生值且界面不展示；人民币价格按固定汇率折算；图书简介为派生文案`,
      count: products.length,
      products,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`生成 ${outPath}`);
for (const stat of stats) {
  console.log(
    `  ${stat.platform}：${stat.rows} 行 → 采纳 ${stat.accepted} 条（主要丢弃原因：${stat.topSkip
      .map(([reason, count]) => `${reason} ${count}`)
      .join('、')}）`,
  );
}
console.log(`商品总数：${products.length}`);
for (const category of CATEGORIES) {
  console.log(`  ${category}：候选 ${buckets[category].length} → 保留 ${Math.min(PER_CATEGORY, buckets[category].length)}`);
}
