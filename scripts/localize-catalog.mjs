#!/usr/bin/env node
/**
 * 真实商品目录本地化脚本
 *
 * 背景：真实电商数据（Amazon 公开样本）是英文的，而本项目的界面与用户输入是中文。
 * 如果直接接入，中文查询（「透气跑鞋」）会因为名称/标签全是英文而匹配不到商品。
 *
 * 做法：用 LLM 把「文案类字段」离线翻译成中文，写回 data/real-catalog.json：
 *   翻译：name / description / tags / specifications 的值
 *   保持原样：id(ASIN) / price / originalPrice / rating / reviews / sales / stock /
 *             image / category / sourceUrl
 * 也就是「同一件真实商品，只是把展示语言本地化」——这正是跨境购物站点的常见做法。
 *
 * 用法：
 *   node --env-file=.env.local scripts/localize-catalog.mjs           # 本地化并覆盖写回
 *   node --env-file=.env.local scripts/localize-catalog.mjs --dry-run # 只打印结果不写文件
 *
 * 失败处理：任一批次失败或字段缺失时，该字段保留英文原文，不会因为翻译失败丢数据。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BATCH_SIZE = 6;
const DRY_RUN = process.argv.includes('--dry-run');
/** 只做标签派生、跳过 LLM 翻译（翻译完成后补标签用） */
const TAGS_ONLY = process.argv.includes('--tags-only');

/**
 * 从中文文案里派生功能标签。
 *
 * 为什么需要：真实目录的标签来自英文 features 字段，本地化后往往缺少用户实际会搜的
 * 功能词（例如「透气」在源数据里没有对应 feature）。而这些词其实就写在本地化后的
 * 标题与描述里，扫一遍补成标签，中文检索才能真正命中。
 */
const DERIVED_TAGS = [
  '透气', '轻量', '防水', '防滑', '降噪', '保暖', '无线', '蓝牙', '可充电', '耐用',
  '便携', '可调节', '可折叠', '不锈钢', '有机', '保温', '可机洗', '反光', '防震',
  '人体工学', '静音', '快充', '高清', '智能', '天然', '无糖', '低脂', '高蛋白',
  '加厚', '速干', '弹力', '修身', '百搭', '亲肤', '大容量', '小巧', '舒适',
];

/**
 * 图书标签词表：题材 → 中文标签 + 命中词。
 *
 * 图书没有「透气 / 降噪」这类功能词，用上面的通用词表扫一遍结果是空标签。
 * 这不是小事：`matchHardFilters` 里只要 filters.tags 有值，标签命中不了的
 * 商品会被**整条过滤掉**，于是「推荐几本悬疑小说」会一本都搜不到。
 *
 * 命中词同时给中英文：图书简介里的类目路径由 LLM 翻译，实测存在个别条目
 * 仍保留英文（如 "Self-Help / Personal Transformation"），只匹配中文会漏标签。
 * 匹配时统一转小写，避免 "Fiction" / "fiction" 两种写法漏判。
 */
const BOOK_TAGS = [
  { tag: '漫画', patterns: ['漫画', '图像小说', 'graphic novel', 'comic'] },
  { tag: '小说', patterns: ['小说', 'fiction', 'novel'] },
  { tag: '科幻', patterns: ['科幻', 'science fiction'] },
  { tag: '奇幻', patterns: ['奇幻', 'fantasy'] },
  { tag: '悬疑', patterns: ['悬疑', '推理', '惊悚', 'mystery', 'thriller', 'suspense'] },
  { tag: '童书', patterns: ['童书', '儿童', "children's", 'children'] },
  { tag: '绘本', patterns: ['绘本', 'picture book'] },
  { tag: '理财', patterns: ['理财', '投资', 'business', 'money', 'finance'] },
  { tag: '传记', patterns: ['传记', '回忆录', 'biograph', 'memoir'] },
  { tag: '历史', patterns: ['历史', 'history'] },
  { tag: '自我提升', patterns: ['自我提升', '个人成长', 'self-help', 'transformation'] },
  { tag: '写作', patterns: ['写作', '参考', 'writing', 'reference'] },
  { tag: '美食', patterns: ['美食', '烹饪', 'cookbook', 'cooking'] },
  { tag: '爱情', patterns: ['爱情', 'romance'] },
  { tag: '青少年', patterns: ['青少年', '青年', 'teen', 'young adult'] },
  { tag: '教育', patterns: ['教育', '教学', 'education'] },
];

function deriveTags(product) {
  const isBook = product.category === '图书';
  // 图书把规格参数（含已本地化的「类目」）也纳入扫描范围，题材词就藏在那里
  const specText = isBook ? Object.values(product.specifications ?? {}).join(' ') : '';
  const haystack = `${product.name ?? ''} ${product.description ?? ''} ${specText}`.toLowerCase();
  const existing = (product.tags ?? [])
    .map((tag) => String(tag).trim())
    .filter((tag) => tag.length > 0);

  // 派生标签优先：翻译来的标签多是「运动鞋 / 步鞋」这类品类词，
  // 若让它们先占满槽位，用户真正会搜的功能词（透气 / 轻量）就挤不进来了。
  const derived = isBook
    ? BOOK_TAGS.filter((entry) => entry.patterns.some((p) => haystack.includes(p)))
        .map((entry) => entry.tag)
        .slice(0, 3)
    : DERIVED_TAGS.filter((tag) => haystack.includes(tag)).slice(0, 3);

  const merged = [...derived];
  for (const tag of existing) {
    if (merged.length >= 6) break;
    if (!merged.includes(tag)) merged.push(tag);
  }
  return merged;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = resolve(root, 'data/real-catalog.json');

const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL ?? 'deepseek-chat';

if (!TAGS_ONLY && (!baseUrl || !apiKey)) {
  console.error('缺少 LLM_BASE_URL / LLM_API_KEY，请用 node --env-file=.env.local 运行');
  process.exit(1);
}

const SYSTEM_PROMPT = `你是电商商品文案本地化专家。把商品信息翻译成简体中文。

输入可能是英文、印尼语、西班牙语、越南语或泰语（数据来自多个平台），请统一译成简体中文。

要求：
1. 商品名称：保留品牌名与型号（如 "Under Armour Charged Assert 9" 中的品牌型号不译），其余描述性文字译成自然的中文，控制在 40 字内。
2. 描述：译成通顺中文，保留关键参数与卖点，控制在 90 字内。
3. 标签：译成简短中文词（2-6 字），例如 Running→跑步、Waterproof→防水、Lightweight→轻量、Breathable→透气、Wireless→无线、Rechargeable→可充电、Durable→耐用、Portable→便携。
4. 规格参数：只翻译「值」中的描述性内容，保留数字、单位、型号（如 "3.31 pounds"→"3.31 磅"，"STKP18000400" 原样保留）。
5. 只输出 json，不要输出任何解释或 Markdown 代码块。`;

function buildUserPrompt(items) {
  return [
    '请把下面商品列表本地化为中文，输出 json，格式为：',
    '{"items":[{"id":"原样返回","name":"中文名","description":"中文描述","tags":["中文标签"],"specifications":{"键":"中文值"}}]}',
    '',
    JSON.stringify(
      items.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        tags: item.tags,
        specifications: item.specifications,
      })),
      null,
      1,
    ),
  ].join('\n');
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('响应中未找到 JSON');
  return JSON.parse(candidate.slice(start, end + 1));
}

async function translateBatch(items, attempt = 1) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(items) },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    if (attempt < 2) {
      console.warn(`  批次失败（${response.status}），重试一次…`);
      return translateBatch(items, attempt + 1);
    }
    throw new Error(`接口 ${response.status}: ${detail.slice(0, 160)}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content ?? '';
  const parsed = extractJson(content);
  if (!Array.isArray(parsed.items)) throw new Error('返回结构缺少 items');
  return parsed.items;
}

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const products = catalog.products;
console.log(`待本地化商品：${products.length} 条，批次大小 ${BATCH_SIZE}`);

const byId = new Map(products.map((product) => [product.id, product]));
let translated = 0;
let fallback = 0;

for (let offset = 0; !TAGS_ONLY && offset < products.length; offset += BATCH_SIZE) {
  const batch = products.slice(offset, offset + BATCH_SIZE);
  const index = Math.floor(offset / BATCH_SIZE) + 1;
  process.stdout.write(`  批次 ${index}（${batch.length} 条）… `);

  try {
    const items = await translateBatch(batch);
    for (const item of items) {
      const target = byId.get(item.id);
      if (!target) continue;
      if (typeof item.name === 'string' && item.name.trim()) {
        target.nameOriginal = target.name;
        target.name = item.name.trim();
      }
      if (typeof item.description === 'string' && item.description.trim()) {
        target.description = item.description.trim();
      }
      if (Array.isArray(item.tags) && item.tags.length > 0) {
        target.tags = item.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 5);
      }
      if (item.specifications && typeof item.specifications === 'object') {
        // 以原始规格为基准，只用翻译结果覆盖**已存在**的键。
        // 之前是整体替换：模型少返回一个键，就会静默丢掉一条真实参数
        // （例如图书的「装帧」「首次上架」）。限制在已存在的键上，
        // 同时避免模型自造出数据源里根本没有的参数行。
        const merged = { ...(target.specifications ?? {}) };
        for (const [key, value] of Object.entries(item.specifications)) {
          if (!(key in merged)) continue;
          const text = String(value ?? '').trim();
          if (text) merged[key] = text;
        }
        target.specifications = merged;
      }
      translated += 1;
    }
    console.log('完成');
  } catch (error) {
    fallback += batch.length;
    console.log(`失败（保留英文原文）：${error.message}`);
  }
}

catalog.localizedAt = new Date().toISOString();
// 上一版这里写「月销量」，但只有 Amazon 的 bought_past_month 是「近一个月」口径，
// Lazada 是累计销量，Walmart 与图书样本根本没有销量字段。
// 现在「哪些来源有真实销量」由数据算出，元信息不会再与数据脱节。
const salesPlatforms = Array.from(
  new Set(products.filter((product) => product.sales > 0).map((product) => product.platform)),
);
catalog.localizeNote = `商品文案（名称/描述/标签/规格值）已本地化为中文；价格、评分、评论数、图片、ASIN 为原始真实数据；${
  salesPlatforms.length > 0
    ? `销量仅 ${salesPlatforms.join(' / ')} 有真实字段`
    : '所有来源均无销量字段'
}，其余来源记 0 并改展示评价数`;

// 本地化之后统一补派生标签（无论是否走了翻译）
let tagged = 0;
for (const product of products) {
  const before = (product.tags ?? []).join(',');
  const after = deriveTags(product);
  if (after.join(',') !== before) tagged += 1;
  product.tags = after;
}
console.log(`派生功能标签：${tagged} 条商品标签发生变化`);

if (DRY_RUN) {
  console.log('\n[dry-run] 前 3 条结果：');
  console.log(JSON.stringify(products.slice(0, 3), null, 1));
} else {
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  console.log(`\n已写回 ${catalogPath}`);
}

console.log(`本地化成功 ${translated} 条，保留英文 ${fallback} 条`);
